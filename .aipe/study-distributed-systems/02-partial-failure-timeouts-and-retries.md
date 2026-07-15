# Partial Failure, Retries, and Backoff

Retry policy / exponential backoff with jitter — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where retry policy sits

  ┌─ Service layer ───────────────────────────────────────────┐
  │  runScan() → readCatalog()                                 │
  └───────────────────────┬───────────────────────────────────┘
                          │ GraphQL query (HTTPS)
  ┌─ Network boundary ────▼───────────────────────────────────┐
  │  ★ RETRY POLICY ★ — runQuery() in catalog-reader.server.ts │ ← we are here
  └───────────────────────┬───────────────────────────────────┘
                          │
  ┌─ Provider layer ──────▼───────────────────────────────────┐
  │  Shopify Admin API (cost-throttled, rate limited)          │
  └───────────────────────────────────────────────────────────────┘
```

This is the one hop in the whole system that behaves like a genuinely
distributed dependency: Shopify's Admin API is owned by someone else, rate
limited by a cost budget you don't control, and reachable only over a real
network that can drop packets. Everything else in this repo (web ⇄ worker)
talks through a local SQLite file, which barely fails at all by comparison.
`app/app/services/shopify/catalog-reader.server.ts` is where partial failure
gets taken seriously, because it's the only place it has to be.

## Structure pass — layers, axis, seams

**Layers:** `runScan` (caller) → `readCatalog` (orchestrates pagination) →
`runQuery` (issues one GraphQL call with retry) → the Shopify Admin API.

**The axis: failure — where does it originate, and who's allowed to retry it?**

```
  Failure axis across the call chain

  runScan          →  catches EVERYTHING from readCatalog, marks scan FAILED
  readCatalog      →  propagates errors up untouched (no swallowing)
  runQuery         →  the ONLY layer that retries — classifies before deciding
  Shopify API      →  originates the failure (throttle, 5xx, network blip)
```

**The seam that matters: classification happens at the lowest layer, not the
highest.** `runQuery` (`app/app/services/shopify/catalog-reader.server.ts:200-241`)
is the only place that decides "is this worth retrying" — by the time an
error reaches `runScan`, it's already final. That's deliberate: retryable
vs. non-retryable is a fact about *this specific call*, and pushing that
decision up to a generic catch-all would mean retrying things that can never
succeed (a malformed query) or giving up on things that would have worked
on the next attempt (a throttle).

## How it works

### Move 1 — the mental model

You've written a `fetch()` wrapped in a `try/catch` that only handles one
kind of failure. This is that same idea, but with the catch block asking a
real question first: *is this the kind of failure that goes away if I wait
and ask again, or the kind that will fail identically forever?* Answering
that wrong in either direction is a real production bug — retrying a
malformed-query error burns your retry budget on something that can never
succeed; not retrying a throttle means one blip fails an entire scan.

```
  Pattern: classify-then-retry loop

  attempt = 0
  loop:
    result = call()
    if result is OK: return result
    if NOT classifiable-as-retryable: throw immediately  ← genuine error
    if attempt >= maxRetries: throw (retry budget exhausted)
    sleep(backoff(attempt))                                ← jittered
    attempt += 1
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** Three parts, and losing any one breaks the pattern:
a failure **classifier** (throttle vs. genuine error), a **backoff
function** (delay grows, capped, jittered), and a **retry budget** (a hard
stop so a persistently broken dependency doesn't retry forever).

```
  The kernel

  ┌─ classifier ────┐   ┌─ backoff ────────┐   ┌─ budget ─────────┐
  │ THROTTLED? →     │   │ base * 2^attempt │   │ attempt <        │
  │ retry            │   │ + jitter, capped │   │ maxRetries?      │
  │ else → throw now │   └───────────────────┘   └───────────────────┘
  └──────────────────┘
```

**What breaks when each part is missing:**

- **Drop the classifier**, retry everything → a malformed query (a real bug
  in the request, e.g. an unknown field) gets retried 4 times before
  failing instead of failing fast, wasting ~15 seconds of wall-clock time
  per scan for a failure that could never succeed.
- **Drop the jitter**, keep pure exponential backoff → if Shopify throttles
  many merchants' scans at once, every retry wakes up in lockstep and
  re-hits the same rate limit simultaneously (a thundering herd), instead of
  spreading retries across a window.
- **Drop the budget**, retry forever → a sustained Shopify outage means the
  scan never fails, the merchant sees a scan stuck in `READING_CATALOG`
  indefinitely, and the worker's single thread of execution is pinned on
  one shop while every other shop's queued scan starves.

**Code — the classifier**
(`app/app/services/shopify/catalog-reader.server.ts:186-198`):

```ts
function isThrottledErrorBody(body: any): boolean {
  if (!body?.errors || !Array.isArray(body.errors)) return false;
  return body.errors.some((error: any) => {
    const code = error?.extensions?.code;
    return typeof code === "string" && code.toUpperCase() === "THROTTLED";
  });
}
```
Shopify's cost-throttling comes back as an HTTP 200 with a `THROTTLED`
GraphQL error, not a rejected promise or a 429 status — an easy thing to
miss if you only check `response.ok`. This function is the one place that
knows the difference between "Shopify said slow down" and "Shopify said
your query is wrong," and every other genuine GraphQL error
(`body.errors` without a `THROTTLED` code) fails immediately at
`catalog-reader.server.ts:232-236` rather than burning retries.

**Code — the backoff with jitter**
(`app/app/services/shopify/catalog-reader.server.ts:160-184`):

```ts
const DEFAULT_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

function computeRetryDelayMs(attempt: number): number {
  const capped = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  // Full jitter within [capped / 2, capped]
  return capped / 2 + Math.random() * (capped / 2);
}
```
Delay doubles each attempt (500ms, 1s, 2s, 4s...) but is capped at 8
seconds and then randomized to half-to-full of that capped value — "full
jitter," the same technique AWS's architecture blog popularized for exactly
this reason: uncorrelated retries recover a rate-limited resource faster
than synchronized ones.

**Code — the retry loop itself**
(`app/app/services/shopify/catalog-reader.server.ts:200-241`):

```ts
async function runQuery(admin, query, variables, policy): Promise<any> {
  let attempt = 0;
  for (;;) {
    let body: any;
    try {
      const response = await admin.graphql(query, { variables });
      body = await response.json();
    } catch {
      // network blip / transient 5xx — retry like a throttle
      if (attempt < policy.maxRetries) {
        await policy.sleep(computeRetryDelayMs(attempt));
        attempt += 1;
        continue;
      }
      throw new Error("Failed to read catalog from Shopify: the GraphQL request failed after retries.");
    }
    if (body?.errors?.length > 0) {
      if (isThrottledErrorBody(body) && attempt < policy.maxRetries) {
        await policy.sleep(computeRetryDelayMs(attempt));
        attempt += 1;
        continue;
      }
      throw new Error("Failed to read catalog from Shopify: the GraphQL request returned errors.");
    }
    return body;
  }
}
```
Notice the rejected-promise branch (`catch`) and the well-formed-error
branch (`body.errors`) both retry through the *same* budget and backoff —
one `attempt` counter, one policy object, so a call that alternates between
a network blip and a throttle still only gets `maxRetries` total attempts,
not `maxRetries` per failure type. And notice what's deliberately
**absent** from the error thrown on line 234-236: the actual GraphQL error
body. Query text and schema internals never leak past this function — a
security-adjacent decision that belongs to this same boundary.

**Injectable time for testability**
(`app/app/services/shopify/catalog-reader.server.ts:23-37,164-173`): `sleep`
and `maxRetries` are constructor-injected via `ReadCatalogOptions`, defaulting
to a real `setTimeout`-based sleep and 4 retries. `runner.server.ts`'s
`RunScanDeps.catalogMaxRetries`/`catalogSleep` (lines 18-26) thread test
overrides all the way down, so a test simulating "Shopify is down" doesn't
have to wait out real exponential backoff — it can inject a synchronous
`sleep` and assert the call count instead.

### Move 3 — the principle

A retry policy is only as good as its classifier. Backoff-with-jitter is
the easy 80%; the hard 20% — and the part that actually prevents outages —
is knowing precisely which failures are worth retrying at all. Retry a
non-retryable error and you've turned a fast failure into a slow one;
fail-fast on a retryable one and you've turned a blip into an outage.

## Primary diagram

```
  Full retry path — one GraphQL call, classified and bounded

  runScan
    │
    ▼
  readCatalog ── paginates products/variants, calls runQuery per page
    │
    ▼
  runQuery(attempt=0) ──► admin.graphql() ──► Shopify Admin API
    │                                              │
    │         ┌─ THROTTLED? ─── yes ──► sleep(jitteredBackoff) ──┐
    │         │                                                   │
    │         └─ genuine error? ── yes ──► throw (no retry) ──┐  │
    │                                                          │  │
    │◄─────────────────── attempt += 1, loop ◄─────────────────┘◄─┘
    │         (until attempt >= maxRetries, then throw)
    ▼
  success → return body
```

## Elaborate

This pattern predates Shopify entirely — it's the same shape as AWS SDK
retry handlers, gRPC's retry policies, and any client library that talks to
a rate-limited third party. The specific numbers here (4 retries, 500ms
base, 8s cap) are tuned to Shopify's cost-throttling recovery window, not
universal constants; a different provider with a different throttle
recovery time would need different constants, but the shape — classify,
backoff exponentially, jitter, cap the budget — transfers unchanged. See
`06-queues-streams-ordering-and-backpressure.md` for what happens to the
*rest* of the queue while one shop's scan is retrying (short answer: nothing
— retries are per-scan, and the worker doesn't move to the next scan until
this one finishes or fails).

## Interview defense

**Q: "How do you tell a retryable failure from a permanent one here?"**
A: By inspecting the GraphQL error body for `extensions.code === "THROTTLED"`
— Shopify returns throttling as a 200 response with that error code, not an
HTTP status you can branch on. Any other error (malformed query, missing
field) fails immediately with no retry.
```
  error body ──► THROTTLED code? ──yes──► retry
                        │
                        no
                        ▼
                    fail fast
```
One-line anchor: *classify by payload content, not HTTP status, because the
provider encodes it that way.*

**Q: "Why jitter instead of pure exponential backoff?"**
A: Pure exponential backoff means every client hitting the same rate limit
at the same time retries in lockstep — attempt 2 for everyone lands at
exactly 1 second, attempt 3 at exactly 2 seconds, and so on, so they
re-collide on the same throttle window. Full jitter randomizes each retry
within `[capped/2, capped]` so concurrent retries spread out instead of
synchronizing.
One-line anchor: *jitter turns a synchronized retry storm into a spread-out
one.*

## See also

- `06-queues-streams-ordering-and-backpressure.md` — the `variantLimit`
  guardrail that caps a single scan's own work regardless of retries.
- `03-idempotency-deduplication-and-delivery-semantics.md` — what happens to
  a scan's data if a retry succeeds after a partial read (answer: `readCatalog`
  itself has no partial-write side effects — it only returns data, `runScan`
  does the writing).
- `.aipe/study-networking/` — transport-level detail (TLS, connection
  pooling) that sits below this retry policy, not duplicated here.
