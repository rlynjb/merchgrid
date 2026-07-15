# Timeouts, retries, pooling, and backpressure
## Industry standard: resilience mechanics for unreliable networks

## Zoom out, then zoom in

This is the file where this repo's networking code is most deliberately engineered — and also where its one real gap lives. `catalog-reader.server.ts` implements a genuine retry policy against Shopify's cost-throttled Admin API: exponential backoff, full jitter, a distinction between "retry this" and "fail immediately." What it does *not* implement is a wall-clock timeout around any individual call — the retry budget bounds attempt *count*, not attempt *duration*. Both halves matter equally to this file's teaching.

```
  Zoom out — where resilience mechanics live on the map

  ┌─ Browser ─────────────────────────────────────────────┐
  │  fixed 2500ms poll interval (not a retry — see 06)      │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Remix action ───────────▼────────────────────────────────┐
  │  409 backpressure: ActiveScanError, one scan/shop            │
  └───────────────────────┬──────────────────────────────────────┘
  ┌─ worker.ts ────────────────▼──────────────────────────────────┐
  │  POLL_MS=5000 idle loop (in-process, no network)                │
  └───────────────────────┬──────────────────────────────────────────┘
  ┌─ catalog-reader.server.ts ★ THIS CONCEPT ★ ─▼─────────────────┐
  │  retries + backoff + jitter, on Shopify's THROTTLED errors       │
  │  NO explicit per-call timeout — the gap named honestly below     │
  └────────────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: failure containment — where does a failure originate, and where does it stop propagating?**

- A rejected `admin.graphql()` promise (network blip, transient 5xx) or a `THROTTLED` GraphQL error body both get caught inside `runQuery()` and retried up to `maxRetries` — failure is contained at the single call site, invisible to `readCatalog()`'s caller.
- A genuine query error (bad field, bad argument) is deliberately **not** retried — it fails immediately and propagates up as a thrown `Error` with a sanitized message, because retrying a request that will never succeed just adds latency for nothing.
- Failure that escapes `readCatalog()` entirely propagates to `runScan()`, which (per the project context) wraps the whole pipeline so a failure marks the `Scan` row `FAILED` rather than crashing the worker process.
- A failure in `worker-core.server.ts`'s `adminFactory` call (e.g., a shop that uninstalled mid-queue) is caught locally and turned into a `FAILED` scan rather than propagating — the "poison-pill guard" — specifically so one broken scan can't block every other shop's queue forever.
- What is **not** contained anywhere: a call that neither resolves nor rejects — a genuine network hang. Nothing in this file's retry loop would notice; it would simply wait forever inside `await admin.graphql(...)`. Named explicitly, not glossed over, in Move 2 and again in `08-networking-red-flags-audit.md`.

## How it works

### Move 1 — the mental model

You know the shape of exponential backoff from any rate-limited API you've called before: fail, wait a bit, fail again, wait longer, eventually give up. The one piece worth being precise about is *jitter* — without it, every client retrying the same throttled endpoint would all wake up and retry at the exact same moment, recreating the exact spike that got them throttled in the first place.

```
  Pattern — retry loop with capped exponential backoff + full jitter

  attempt = 0
  loop:
    result = call()
    if result is success:            return result
    if result is retryable AND attempt < maxRetries:
      delay = randomBetween(cap/2, cap)   // cap doubles each attempt, capped at MAX_DELAY
      sleep(delay)
      attempt += 1
      continue
    else:
      throw safe_error                     // retries exhausted, or non-retryable
```

### Move 2 — walking the load-bearing skeleton

**Isolating the kernel.** The retry mechanism in `catalog-reader.server.ts` has exactly three load-bearing parts: an **attempt counter bounded by `maxRetries`**, a **backoff-delay function**, and a **predicate that decides what's retryable**. Everything else (jitter, the specific base/cap constants) is hardening layered on top of that kernel.

**Part 1 — the attempt cap.** `runQuery()` (`catalog-reader.server.ts:200-241`) loops `for (;;)`, but every retryable branch checks `attempt < policy.maxRetries` before looping again (lines 216, 227) — `DEFAULT_MAX_RETRIES = 4` (line 160), so up to 4 retries on top of the initial call, 5 attempts total, matching the doc comment on `ReadCatalogOptions.maxRetries` (lines 27-31). **What breaks if this cap is removed:** a shop whose access token was revoked, or whose store is genuinely down, turns every scan attempt into an infinite retry loop — the worker never advances to the next queued scan, because `claimAndRunNext()` awaits `runScan()` to completion before claiming again.

**Part 2 — the backoff-delay function.** `computeRetryDelayMs(attempt)` (lines 175-184):

```ts
function computeRetryDelayMs(attempt: number): number {
  const capped = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return capped / 2 + Math.random() * (capped / 2);
}
```

With `RETRY_BASE_DELAY_MS = 500` and `RETRY_MAX_DELAY_MS = 8_000` (lines 161-162), here's the execution trace across the four retries a default run allows:

```
  Execution trace — computeRetryDelayMs across attempts 0..3

  attempt=0:  capped = min(500,   8000) =  500  →  delay ∈ [ 250,  500] ms
  attempt=1:  capped = min(1000,  8000) = 1000  →  delay ∈ [ 500, 1000] ms
  attempt=2:  capped = min(2000,  8000) = 2000  →  delay ∈ [1000, 2000] ms
  attempt=3:  capped = min(4000,  8000) = 4000  →  delay ∈ [2000, 4000] ms
```

**What breaks if the cap doubling is removed** (i.e., a flat delay every attempt): a persistently throttled call retries at the same rate forever instead of backing off, which is exactly the behavior that keeps a rate limiter throttling you — you never give the upstream time to recover.

**Part 3 — full jitter.** The `capped / 2 + Math.random() * (capped / 2)` shape is "full jitter within the top half of the range" — the comment at lines 181-183 names why: "so retries from concurrent requests don't all wake up in lockstep." **What breaks if jitter is removed:** every concurrent scan hitting the same throttle limit retries at the exact same moment, recreating a burst against Shopify's API right as it's trying to recover from the last one — a self-inflicted thundering herd.

**Part 4 — the retryable-vs-not predicate.** `isThrottledErrorBody()` (lines 192-198) checks specifically for `extensions.code === "THROTTLED"` on a GraphQL error — Shopify's own signal that this was cost-throttling, not a genuine query problem. A rejected promise (network blip) is treated the same as throttled (line 213-220); a well-formed error body *without* a `THROTTLED` code fails immediately (lines 226-236), with a sanitized message that deliberately never leaks the original GraphQL error text (comment, lines 232-233) — a real defensive choice, since Shopify's raw error bodies can include schema internals that shouldn't reach logs or end users.

```
  Layers-and-hops — one throttled call, full retry cycle

  ┌─ readCatalog loop ──┐  attempt 0        ┌─ Shopify Admin API ─┐
  │  runQuery()          │──────────────────►│  200 + THROTTLED err │
  │                       │◄── retryable ─────│                      │
  └──────────┬────────────┘                   └──────────────────────┘
             │ sleep(250-500ms), attempt=1
             ▼
  ┌─ runQuery() retry ───┐  attempt 1        ┌─ Shopify Admin API ─┐
  │                       │──────────────────►│  200 + success        │
  │                       │◄── data ───────────│                      │
  └────────────────────────┘                   └──────────────────────┘
```

**What's absent — a per-call wall-clock timeout.** Nowhere in `runQuery()` is there an `AbortController`, a `Promise.race` against a timer, or any bound on how long a single `await admin.graphql(...)` is allowed to take before it's treated as failed. The retry loop only reacts to a call that *resolves* (with a `THROTTLED` body or a genuine error) or *rejects* — a call that simply never settles (Shopify's servers accept the connection and never respond) would hang the entire scan indefinitely, with no retry, no timeout, no signal to the worker that anything is wrong. This is a real gap, carried forward to `08-networking-red-flags-audit.md` as the top-ranked finding, not something to explain away.

**Backpressure — admission control, not a network mechanism, but the same failure-family.** `enqueueScan()` (`app/app/services/scan/queue.server.ts:44-70`) enforces one active scan per shop, throwing `ActiveScanError` (surfaced as `409`, per `05-http-semantics-caching-and-cors.md`) rather than letting a merchant queue unbounded concurrent scans against their own catalog. `variantLimit` (default 5,000, from `ShopSettings.catalogVariantLimit`) is the other backpressure lever — a data-volume cap that bounds how much of Shopify's API a single scan is allowed to consume, truncating with `partial: true` rather than reading unbounded (`catalog-reader.server.ts:378-390`).

**Pooling — implicit, not configured.** No file in this repo sets a custom HTTP `Agent`, connection-pool size, or idle-socket timeout for the outbound calls to Shopify. Whatever pooling exists is `undici`'s (Node's built-in `fetch` implementation) default behavior, inherited by the Shopify SDK's `admin.graphql()` client. At this app's current scale — one worker process, one scan running at a time — that default is almost certainly fine; it's still worth naming as unconfigured rather than assuming it's tuned.

**Two poll loops, two different resilience stories.** The browser's `setInterval` poll (`app.scans.$id.tsx:514`, walked fully in `06-websockets-sse-streaming-and-realtime.md`) has no retry logic at all — if one `revalidate()` call fails, Remix's own error boundary handles it, and the next tick just tries again on schedule. The worker's `POLL_MS = 5000` loop (`worker.ts:24, 78-91`) wraps `claimAndRunNext()` in a `try/catch` that logs and keeps looping (lines 80-84) specifically so "a bad scan... must never kill the whole worker process" (comment, lines 80-81) — the worker's resilience story is about process-level survivability, not retrying a specific failed call.

### Move 3 — the principle

Retry logic that bounds attempt *count* and backs off with jitter solves "don't make a throttled upstream worse." It does nothing for "don't hang forever" — that needs an independent wall-clock timeout, because a promise that never settles doesn't trigger any of the retry paths built to handle rejection or an error body. The two mechanisms look like the same category of hardening and aren't; a system can have excellent retry logic and still be one hung TCP connection away from a stuck worker.

## Primary diagram

```
  The full resilience picture for one outbound Shopify call

  ┌─ readCatalog() loop ──────────────────────────────────────────┐
  │  for each products page / variant sub-page:                    │
  │    runQuery(admin, query, vars, policy)                          │
  └───────────────────────┬─────────────────────────────────────────┘
                          │
  ┌─ runQuery() ────────────▼─────────────────────────────────────────┐
  │  try:  admin.graphql(...)                                           │
  │    reject → retryable, attempt<maxRetries → backoff+jitter → retry  │
  │    reject → attempts exhausted → throw safe error                    │
  │  body.errors present:                                                 │
  │    THROTTLED, attempt<maxRetries → backoff+jitter → retry             │
  │    THROTTLED, exhausted → throw safe error                            │
  │    non-THROTTLED (genuine error) → throw safe error IMMEDIATELY       │
  │  ⚠ no wall-clock timeout wraps this await — a hang is invisible here  │
  └────────────────────────────────────────────────────────────────────┘

  ┌─ backpressure, one layer up ────────────────────────────────────────┐
  │  enqueueScan(): 1 active scan/shop (409 if violated)                   │
  │  readCatalog(): variantLimit budget (partial:true if truncated)        │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Exponential backoff with jitter is the same mechanism AWS SDKs, gRPC clients, and most production HTTP clients ship by default — this repo hand-rolled a small, well-scoped version of it rather than pulling in a retry library, which is a reasonable call for one call site with one specific failure mode (Shopify's `THROTTLED` signal) to react to. The missing timeout is the piece a general-purpose retry library usually bundles for free (most ship a default request timeout); rolling your own retry logic means you own remembering to add that half yourself.

## Interview defense

**Q: Walk me through what happens when Shopify throttles a catalog read.**
`runQuery()` gets back an HTTP 200 with a GraphQL error body carrying `extensions.code: "THROTTLED"`. `isThrottledErrorBody()` recognizes it, and if `attempt < maxRetries` (default 4), it sleeps for a capped-exponential, fully-jittered delay and retries the same query — up to 5 total attempts before giving up with a sanitized error. Anchor: `catalog-reader.server.ts:192-241`.

**Q: What's the one gap you'd flag in this retry design?**
No per-call wall-clock timeout. The retry loop only reacts to a promise that resolves or rejects — a call that hangs (connection accepted, response never sent) triggers neither branch and blocks the scan indefinitely. Fix: wrap `admin.graphql(...)` in an `AbortController`-based timeout so a hang becomes a rejection the existing retry path already knows how to handle. Anchor: `catalog-reader.server.ts:210-213` (the `await admin.graphql` call site with no timeout around it).

## See also

- `01-network-map.md` — where this retry loop sits on the full hop chain
- `03-tcp-udp-connections-and-sockets.md` — the unconfigured connection pooling this retry loop runs on top of
- `06-websockets-sse-streaming-and-realtime.md` — the browser's poll loop, contrasted against the worker's own poll loop here
- `08-networking-red-flags-audit.md` — the missing-timeout gap, ranked against every other finding in this guide
