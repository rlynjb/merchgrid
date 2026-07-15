# Exponential Backoff with Jitter

### Retry-with-backoff — industry standard resilience pattern

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Service layer ────────────────────────────────────────────┐
  │  readCatalog() loop  →  runQuery()                          │
  │                          ★ RETRY POLICY LIVES HERE ★         │ ← we are here
  └──────────────────────────┬──────────────────────────────────┘
                              │ admin.graphql(query)
  ┌─ Provider layer ───────────▼──────────────────────────────────┐
  │  Shopify Admin API — cost-throttled; a busy call comes back   │
  │  as HTTP 200 + a THROTTLED GraphQL error, not a rejected call │
  └────────────────────────────────────────────────────────────────┘
```

Shopify's Admin API doesn't reject an over-budget call outright — it hands back an HTTP 200 with a GraphQL error whose `extensions.code` says `"THROTTLED"`. That's a signal to slow down, not a failure to give up on. `runQuery` (`app/app/services/shopify/catalog-reader.server.ts:200-241`) is the code that reads that signal and decides what to do next: wait, and try again — but not naively.

## The structure pass

**Axis: failure — where does a bad response get classified, and who decides retry vs. give up?**

```
  Tracing "who decides this failed for good" down the stack

  ┌─ Shopify API ────────────────────────────┐
  │ returns THROTTLED error, OR a genuine     │  → PROVIDER just reports
  │ query error, OR rejects the call outright │     what happened, no opinion
  └──────────────────┬───────────────────────┘
                      │
  ┌─ runQuery() ───────▼───────────────────────┐
  │ isThrottledErrorBody(body) → retry          │  → CODE classifies:
  │ genuine error → throw immediately           │     transient vs. terminal
  └──────────────────┬───────────────────────────┘
                      │
  ┌─ readCatalog() ─────▼───────────────────────┐
  │ just awaits runQuery — has no idea whether  │  → CODE is UNAWARE
  │ 1 attempt happened or 5                     │     retries happened at all
  └──────────────────┬───────────────────────────┘
                      │
  ┌─ runScan() ──────────▼───────────────────────┐
  │ catches whatever final error survives,       │  → CODE only sees
  │ maps to generic FAILED + safe message         │     "it worked" or "it didn't"
  └────────────────────────────────────────────────┘
```

The seam that matters is `isThrottledErrorBody` itself (`catalog-reader.server.ts:192-198`) — that's the one place in the whole pipeline where the axis (retryable vs. terminal) actually gets decided. Above it, nobody even knows retries are a concept; below it, Shopify has no opinion about what should happen next. Get the classification wrong at that one seam and everything downstream is affected: too permissive, and a permanently broken query retries four times before finally surfacing an error the caller could have had instantly; too strict, and a routine throttle blip fails the whole scan.

## How it works

**The mental model:** you've written a `fetch()` wrapped in a `try/catch` with a retry loop before. This is that, with two refinements that are easy to skip and expensive to skip: it *classifies* the failure before deciding to retry (not every error deserves a second attempt), and it *randomizes* the wait time instead of always waiting exactly the same amount — so that many callers backing off from the same throttling event don't all wake up and retry in lockstep, recreating the exact spike that got them throttled in the first place.

```
  Pattern — classify, then backoff-with-jitter, then retry or give up

  call Shopify
       │
       ▼
  ┌─────────────┐   no error / success  →  return
  │  got a       │
  │  response?   │
  └──────┬───────┘
         │ error
         ▼
  ┌───────────────────┐   genuine error   →  THROW immediately
  │ THROTTLED, or a    │   (not retryable)     (don't waste the retry budget)
  │ rejected call?     │
  └──────┬───────────┘
         │ yes, and attempts remain
         ▼
  sleep( jittered_backoff(attempt) )  ← randomized, not fixed
       │
       ▼
  attempt += 1, LOOP BACK to "call Shopify"
```

### The skeleton — four parts, each load-bearing

- **The classifier (`isThrottledErrorBody`, lines 192-198).** This is the part that decides whether an error is worth a second try at all. Remove it — retry everything indiscriminately — and a malformed query (unknown field, bad argument) burns through the entire retry budget failing identically every time, adding up to several seconds of pure waste before the *same* error finally surfaces. Remove it the other way — retry nothing — and a routine `THROTTLED` response (an expected, designed-for condition on a cost-throttled API) fails the entire scan on the first hiccup.
- **Exponential growth (`RETRY_BASE_DELAY_MS * 2 ** attempt`, line 178).** Each retry waits longer than the last — 500ms, then 1000ms, then 2000ms, then 4000ms — instead of hammering the same busy endpoint at a fixed interval. Remove the exponent and you're back to fixed-interval polling against something that just told you it's overloaded.
- **The cap (`RETRY_MAX_DELAY_MS = 8_000`, line 178) — and here's the detail worth being blunt about.** With the shipped default `DEFAULT_MAX_RETRIES = 4` (line 160), the loop only ever reaches `attempt = 0, 1, 2, 3` before the retry budget (checked as `attempt < policy.maxRetries`) runs out — which means the computed delays are 500, 1000, 2000, and 4000ms, and the 8-second cap **never actually binds** under default settings (`500 * 2**3 = 4000`, still under 8000; it would first bind at `attempt = 4`, which the default budget never reaches). The cap isn't dead code — it's hardening for a caller that raises `maxRetries` (a test does exactly this via `RunScanDeps.catalogMaxRetries`) — but as shipped, it's a safety net that has never once been exercised. That's worth knowing before you assume every line in a retry policy is pulling equal weight under production traffic.
- **Full jitter (`capped / 2 + Math.random() * (capped / 2)`, lines 176-184).** Instead of always waiting exactly the computed backoff, the delay is randomized within `[capped/2, capped]`. Remove this and every caller throttled by the same event computes the *identical* delay and wakes up at the *identical* moment — a synchronized retry spike hitting Shopify at once, which is the thundering-herd failure this exact randomization exists to prevent.

### The code, with the execution trace

`app/app/services/shopify/catalog-reader.server.ts:200-241`, the retry loop itself:

```ts
async function runQuery(admin, query, variables, policy) {
  let attempt = 0;
  for (;;) {
    let body;
    try {
      const response = await admin.graphql(query, { variables });
      body = await response.json();
    } catch {
      // network blip / transient 5xx — treated like a throttle
      if (attempt < policy.maxRetries) {
        await policy.sleep(computeRetryDelayMs(attempt));
        attempt += 1;
        continue;
      }
      throw new Error("...failed after retries.");
    }
    if (body?.errors?.length > 0) {
      if (isThrottledErrorBody(body) && attempt < policy.maxRetries) {
        await policy.sleep(computeRetryDelayMs(attempt));
        attempt += 1;
        continue;                              // ← classified retryable
      }
      throw new Error("...returned errors.");   // ← classified terminal, no wait
    }
    return body;
  }
}
```

```
  Execution trace — a call that gets THROTTLED four times in a row

  attempt │ delay range (ms)      │ what happens
  ────────┼───────────────────────┼──────────────────────────────
     0    │ [250, 500]             │ THROTTLED → sleep → attempt=1
     1    │ [500, 1000]            │ THROTTLED → sleep → attempt=2
     2    │ [1000, 2000]           │ THROTTLED → sleep → attempt=3
     3    │ [2000, 4000]           │ THROTTLED → sleep → attempt=4
     4    │ (never reached:        │ attempt < maxRetries(4) is FALSE
          │  guard fails first)    │ → throw immediately, no 5th sleep
```

Five total calls maximum (the initial attempt plus four retries), roughly 3.75–7.5 seconds of cumulative worst-case backoff before giving up — a real, bounded number, even though nothing in this repo has ever logged how often this path actually fires in production. See `01-bounded-catalog-read.md` for the sibling mechanism in the same file: this bounds *how patient* the app is about a slow provider; that bounds *how much* the app is willing to read from it. Neither one trusts the far end to self-limit.

**The principle:** a retry policy is really a failure-classification problem wearing a scheduling costume. Getting the backoff math right (exponential, jittered, capped) is the easy 80%; the part that actually protects the system is deciding *which* failures deserve a second attempt at all, and doing that classification at the narrowest possible seam — one function, one job — so every layer above it can stay ignorant of retries entirely.

## Primary diagram

```
  Exponential backoff with jitter — full recap

  admin.graphql(query) ──► Shopify Admin API
        │                        │
        │                        ▼
        │                 THROTTLED? genuine error? network blip?
        │                        │
        ▼                        ▼
  isThrottledErrorBody(body) ──► retryable  ──► sleep(jittered exp. backoff)
        │                                              │
        │ (genuine error)                              ▼
        ▼                                        attempt += 1, retry
     throw immediately                          (up to maxRetries=4 times)
     (no wasted wait)                                   │
                                                          ▼
                                          exhausted → throw "...failed after retries."
```

## Elaborate

This is the canonical retry-with-jitter pattern described in the AWS Architecture Blog's "Timeouts, retries, and backoff with jitter" and echoed throughout the Google SRE book — the shape shows up anywhere a client talks to a rate-limited or occasionally-overloaded service: a database driver's connection retry, a job queue's failed-task requeue, an HTTP client library's built-in retry middleware. The specific twist here — treating `THROTTLED` as retryable but a well-formed query error as not — is the same judgment call every one of those libraries has to make: retrying blindly wastes time on errors that will never succeed; never retrying throws away resilience against errors that were only ever transient.

What to read next: `01-bounded-catalog-read.md` for the sibling bounded-work mechanism in the same file; `.aipe/study-networking/` for the transport-layer view of retry/timeout semantics if you want the HTTP-protocol angle instead of the cost/latency angle this file takes.

## Interview defense

**Q: Why jitter the delay instead of just backing off exponentially?**
A: Because a fixed, deterministic backoff means every client throttled by the same event computes the identical wait and wakes up at the identical instant — which recreates the exact traffic spike that caused the throttling in the first place. One-line anchor: *synchronized retries recreate the outage they're recovering from.*

```
  no jitter — synchronized                with jitter — spread out
  ┌───┬───┬───┬───┐                       ┌─┬──┬───┬─┬────┐
  │   │   │   │   │  all wake up          │ │  │   │ │    │  wake-ups spread
  │   │   │   │   │  at the SAME time     │ │  │   │ │    │  across a window
  └───┴───┴───┴───┘                       └─┴──┴───┴─┴────┘
        ▲ retry spike hits provider              ▲ load smoothed out
          at once → re-throttled
```

**Q: What's the part of this mechanism people forget to build, or build and never verify?**
A: The classifier. It's tempting to write "on any error, retry" — which silently converts every permanent bug into a slow permanent bug (four wasted backoff cycles before the real error surfaces). The forgotten-but-verified detail in *this* codebase specifically: the 8-second cap has never actually bound under the shipped `maxRetries=4` default — it only exists for a caller that raises the retry budget. Naming that is the signal you actually read the arithmetic instead of assuming every constant in a retry policy does equal work.

**Q: How would you verify this policy behaves correctly under real Shopify throttling, today?**
A: You can't from evidence in this repo — there's no logging or metric anywhere counting how often `THROTTLED` responses actually occur in production, and no test exercises the `RETRY_MAX_DELAY_MS` cap (it would require overriding `maxRetries` past 4, which only the test-only `catalogMaxRetries` override supports). The real answer: add a counter/log line inside the retryable branch of `runQuery`, and a fixture-driven test that forces `attempt` past 4 to actually exercise the cap once.

## See also

- `01-bounded-catalog-read.md` — the sibling mechanism in the same file, bounding read size instead of retry patience.
- `.aipe/study-networking/` — transport-level retry/timeout semantics, if you want the protocol view.
- `audit.md` → lens 3 (latency/throughput — this is the dominant tail-latency source), lens 5 (I/O and network bottlenecks).
