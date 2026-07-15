# Retry with backoff & circuit breaker

Subtitle: **Retry-with-backoff** — Industry standard (real, grounded in this repo) — and **circuit breaker** — Industry standard (not yet exercised, same file).

## Zoom out, then zoom in

```
  Zoom out — where this concept lives in MerchGrid

  ┌─ UI layer (Remix) ───────────────────────────────────────────┐
  │  app.scans.$id.tsx  →  loader polls scan status               │
  └───────────────────────────┬───────────────────────────────────┘
                              │  enqueue / poll
  ┌─ Service layer ───────────▼───────────────────────────────────┐
  │  queue.server.ts  →  runner.server.ts (pipeline orchestrator)  │
  │        │                    │  catches final failure,          │
  │        │  readCatalog()      │  writes scan.status = FAILED    │
  │        ▼                    │  (runner.server.ts:208-224)      │
  │  catalog-reader.server.ts                                       │
  │   ★ RETRY LIVES HERE ★                                          │ ← we are here
  │   ☐ CIRCUIT BREAKER WOULD LIVE HERE — not present               │
  └───────────────────────────┬───────────────────────────────────┘
                              │  GraphQL query over HTTPS
  ┌─ Provider: Shopify Admin API ──────────────────────────────────┐
  │  cost-throttled GraphQL endpoint                                │
  └───────────────────────────┬───────────────────────────────────┘
                              │  RawCatalog
  ┌─ Engine packages ──────────▼──────────────────────────────────┐
  │  @merchgrid/catalog-core, @merchgrid/catalog-checks             │
  └───────────────────────────┬───────────────────────────────────┘
                              │  findings
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  Prisma → SQLite                                                │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: this file covers two patterns that get lumped together under "resilience" but solve different problems, sitting at the same exact spot in the codebase. **Retry with backoff** assumes a failure is transient — try again shortly, it'll probably clear. **Circuit breaking** assumes a failure is *sustained* — stop trying altogether for a while, because retrying a dead dependency wastes time, wastes the dependency's recovery window, and (in a rate-limited API like Shopify's) can actively make the outage worse. One of these two patterns is real, working code in `catalog-reader.server.ts`. The other does not exist anywhere in this repo. Naming both, and being precise about which is which, is the entire point of this file.

## Structure pass

**Axis: failure — where does it originate, get absorbed, and get reported?**

- **Originates** at the Shopify API boundary: either a rejected promise (network blip) or a well-formed `THROTTLED` error body (cost throttling).
- **Gets absorbed** inside `runQuery` (`catalog-reader.server.ts:200-241`) — up to `maxRetries` attempts, with backoff between them. This is the retry layer, and it is real.
- **Escalates** the moment retries are exhausted: `runQuery` throws one safe, generic `Error`. Nothing about *how many times* it failed, or whether the last ten scans also failed for the same reason, survives past this point.
- **Gets reported** at `runner.server.ts:208-224` — the `catch` block that wraps the whole pipeline. It logs the real error server-side (`console.error`), then writes `scan.status = "FAILED"` with a generic `failureMessageSafe`. Each scan's failure is handled in total isolation from every other scan.

**Seam:** the load-bearing seam for retry is inside `runQuery` — the point where "attempt < maxRetries" flips to "attempt === maxRetries" and the behavior changes from "wait and retry" to "give up." That seam is real and this file grounds it precisely. The seam for a circuit breaker would be a *different*, wider one: a point where failure state from one call (or one `readCatalog` invocation) is checked before a *later, unrelated* call is even attempted. That seam doesn't exist — there's no shared failure counter, no timer, no "open" state, anywhere in this codebase. Each `readCatalog` call, and each retry loop inside it, starts at zero.

## How it works

### Move 1 — the mental model

**Case A — retry with backoff (real).** You know this shape already — it's exactly what `04-rate-limiting-backpressure.md` walks in full: attempt, check for a retryable failure, wait an increasing amount of time, try again, give up after a fixed budget. This file won't re-derive that mechanism; it points at it and focuses on what retry assumes and what it doesn't cover.

**Case B — circuit breaker (not yet exercised).** Think of a household circuit breaker, which is where the name comes from and it's not a stretch here: when a circuit draws too much current, the breaker trips and cuts power immediately, rather than letting the wiring keep drawing current until something melts. The software version does the same job for a failing dependency: after enough consecutive failures, stop even trying to call it — fail immediately, for a cool-down period, then cautiously test whether it's back.

```
  Pattern — the circuit breaker state machine (not present in this repo)

           N consecutive failures
   ┌─────────┐ ───────────────────► ┌────────┐
   │ CLOSED  │                      │  OPEN  │
   │ (calls  │ ◄─────────────────── │ (calls │
   │  flow   │   1 success in       │ fail   │
   │  through)   HALF-OPEN           │ instantly,
   └────┬────┘                      │  no network
        │                           │  hop at all)
        │  cool-down timer elapses  └───┬────┘
        │                               │
        └──────────► ┌─────────────┐ ◄─┘
                      │ HALF-OPEN   │
                      │ (let ONE    │
                      │  probe call │
                      │  through)   │
                      └─────────────┘
```

### Move 2 — the step-by-step walkthrough

**Case A — the retry mechanism, as it actually exists.**

The kernel is `runQuery` (`catalog-reader.server.ts:200-241`), and `04-rate-limiting-backpressure.md` walks every line of it — `isThrottledErrorBody` (`:186-198`) distinguishing retryable throttles from fatal query errors, `computeRetryDelayMs` (`:175-184`) doing exponential backoff (`500ms * 2^attempt`, capped at `8000ms`) with full jitter, and the loop itself retrying up to `maxRetries` (default 4, `DEFAULT_MAX_RETRIES`) before throwing a safe wrapped error. What this file adds is the *downstream* half — what happens after `runQuery` gives up.

```
  Layers-and-hops — failure escalation after retry exhausts

  ┌─ catalog-reader.server.ts ───────────┐  hop: throws generic Error
  │  runQuery exhausts maxRetries         │ ─────────────────────────────►
  │  (:221-223 or :234-236)               │  "Failed to read catalog
  └────────────────────────────────────────┘   from Shopify: ..."
                                                        │
  ┌─ runner.server.ts ────────────────────────────────▼────────────────┐
  │  try { ...pipeline... } catch (err) {   (runner.server.ts:208-224)  │
  │    console.error(...)      ← real error, server-side only           │
  │    scan.status = "FAILED"                                           │
  │    failureMessageSafe = GENERIC_FAILURE_MESSAGE                     │
  │  }                                                                   │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  hop: generic "could not be completed"
  ┌─ UI (app.scans.$id.tsx) ──▼───────────────────────────────────────┐
  │  merchant sees: scan failed, try again                              │
  │  (no trace that it was a Shopify throttle, or how many retries ran) │
  └──────────────────────────────────────────────────────────────────┘
```

Notice what's thrown away at each hop: the retry count, the specific failure reason, and — critically for Case B below — any memory that this shop's *last several* scans also failed the same way. `runner.server.ts`'s `catch` block treats every failure identically regardless of cause, and nothing persists failure history across scans (`Scan` rows record `failureCode: "SCAN_FAILED"` uniformly; there's no query anywhere for "how many of this shop's last N scans failed").

**Case B — the circuit breaker, taught as general knowledge, honestly absent here.**

The skeleton a circuit breaker needs, and what breaks without each part:

```
  Skeleton — circuit breaker kernel

  state: CLOSED | OPEN | HALF_OPEN
  consecutiveFailures: counter
  failureThreshold: N               // drop this → breaker never trips
  cooldownMs: duration              // drop this → breaker never resets,
                                      // permanently blocks a recovered dependency
  lastFailureAt: timestamp          // drop this → can't tell if cooldown elapsed
```

- **Drop the failure counter** and there's nothing to trip on — every call just retries independently forever, which is exactly today's state in this repo.
- **Drop the cooldown timer** and an `OPEN` breaker never gets a chance to test recovery — it fails every call permanently, even after the dependency comes back.
- **Drop the half-open probe** and the breaker either stays fully open (starving a recovered dependency of traffic) or slams back to fully closed and re-floods a barely-recovered dependency with every queued request at once.

```
function callWithBreaker(state, doCall):
  if state.status == OPEN:
    if now() - state.lastFailureAt < state.cooldownMs:
      throw "circuit open — failing fast"     // no network hop happens at all
    state.status = HALF_OPEN                  // cooldown elapsed, allow one probe

  try:
    result = doCall()
    state.consecutiveFailures = 0
    state.status = CLOSED                     // any success in HALF_OPEN closes it
    return result
  catch (err):
    state.consecutiveFailures += 1
    state.lastFailureAt = now()
    if state.consecutiveFailures >= state.failureThreshold:
      state.status = OPEN
    throw err
```

Here's the honest gap, stated precisely rather than hand-waved: **`catalog-reader.server.ts` has no such state anywhere.** There is no `consecutiveFailures` counter that survives across `runQuery` calls, no shared state across the multiple `runQuery` calls made within a single `readCatalog` invocation (one products-page query plus, potentially, several per-product variant sub-queries), and definitely none across separate scans or separate shops. If Shopify's Admin API were down for twenty minutes, every single scan kicked off in that window would independently retry each of its GraphQL calls up to 4 times with up to ~8-second backoff delays each — burning real wall-clock time per scan on a dependency that a circuit breaker would have already learned was down, and failing fast instead. This isn't a defect in what's there — the retry logic that exists is correct and well-built for transient failure. It's a capability that was never added, because MerchGrid runs one scan at a time per shop (`ActiveScanError` in `queue.server.ts` enforces this) and a single-shop, single-scan-at-a-time system under moderate load may simply not have needed it yet. The place it would go is a thin wrapper around `runQuery`, sharing state either per-process (simplest) or in a shared store if scans ever run across multiple worker processes.

### Move 3 — the principle

Retry and circuit breaking answer different questions about the same failure, and neither substitutes for the other: retry answers "is this specific failure likely to clear if I wait a moment?" — it's local, stateless across calls, and blind to history. Circuit breaking answers "has this dependency stopped working altogether, such that continuing to try is actively harmful?" — it's inherently *stateful across calls*, because the whole point is remembering that the last several attempts all failed. A system with excellent retry logic and no circuit breaker is well-defended against blips and completely undefended against outages; that's exactly where this repo sits today.

## Primary diagram

```
  Full recap — Case A (real, this file) vs Case B (absent, this file)

  ┌─ Case A: retry with backoff ────────────────────────────────────┐
  │  catalog-reader.server.ts runQuery (:200-241)                     │
  │  attempt=0 → THROTTLED? → backoff+jitter → attempt=1 → ... → give │
  │  up at maxRetries (default 4) → throw safe Error                  │
  │  STATE: local to one runQuery call. Resets every call.            │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  exhausted retries
                              ▼
  ┌─ runner.server.ts catch block (:208-224) ─────────────────────────┐
  │  logs real error, writes scan FAILED with generic safe message     │
  │  NO memory of this failure carried into the next scan              │
  └───────────────────────────┬───────────────────────────────────────┘
                              │
                              ▼
  ┌─ Case B: circuit breaker — NOT PRESENT ────────────────────────────┐
  │  would sit here, wrapping runQuery or readCatalog:                  │
  │  track consecutive failures across calls → OPEN after N →           │
  │  fail fast (skip retry+backoff entirely) → HALF_OPEN probe →        │
  │  CLOSED on success                                                  │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Exponential backoff with jitter is old, well-proven ground — AWS's 2015 architecture blog post on backoff strategies is the usual citation, and it's the exact "full jitter" formula implemented in this repo's `computeRetryDelayMs`. The circuit breaker pattern is younger in software terms but just as settled — it's cataloged in Michael Nygard's *Release It!* as one of the core "stability patterns," and it's the reason libraries like Polly (.NET), resilience4j (Java), and opossum (Node) exist as dedicated dependencies rather than something every team reimplements from scratch. The two patterns compose in production systems that take resilience seriously: retry handles the common case (a blip clears in milliseconds to seconds), the circuit breaker handles the tail case (the dependency is actually down for minutes), and the breaker is usually the *outer* wrapper — it decides whether to let a call (with its own internal retry loop) through at all. See `04-rate-limiting-backpressure.md` for the full retry/backoff mechanism this file builds on, and for the separate (also real) backpressure mechanism (`variantLimit`) that lives in the same file but answers a scope question, not a failure question.

## Project exercises

### Exercise: add a circuit breaker wrapper around runQuery

- **Exercise ID:** EX-1
- **What to build:** A `CircuitBreakerState` object threaded through one `readCatalog` invocation (module-level or passed in via `ReadCatalogOptions`, matching the existing injectable-policy style) that tracks consecutive `runQuery` failures across every GraphQL call made during that invocation — the products-page query and every per-product variant sub-query. After a configurable threshold of consecutive failures, the breaker opens: subsequent `runQuery` calls in the *same* invocation fail immediately (no network hop, no retry/backoff at all) instead of repeating the full retry cycle against a dependency that's already proven itself down.
- **Why it earns its place:** this is the exact gap named in this file's Interview Defense answer — proving you can both use and extend the existing retry mechanism, without touching its correctness, is a stronger signal than describing the pattern abstractly.
- **Files to touch:** `app/app/services/shopify/catalog-reader.server.ts` (add the breaker state and wrap `runQuery`'s call sites), `app/test/catalog-reader.test.ts` (new test file or new `describe` block).
- **Done when:** a test that simulates sustained throttling — `createFakeAdmin` returning `THROTTLED` for every single call across an entire `readCatalog` run with a large enough product set to trigger multiple `runQuery` calls — shows fewer total network calls (fewer `admin.graphql` invocations) with the breaker than without it, because later calls fail fast instead of each running their own full retry cycle.
- **Estimated effort:** M (2-3 hrs) — the state machine itself is small; getting the test to actually prove "fewer calls happened" (not just "it eventually failed") is the part that takes care.

### Exercise: surface circuit-breaker state on the Scan record for observability

- **Exercise ID:** EX-2
- **What to build:** If EX-1 exists, extend `runner.server.ts` to record whether a scan failed because the circuit breaker was open (vs. a plain retry exhaustion) — a new `failureCode` value distinct from the existing generic `"SCAN_FAILED"` — so an on-call engineer looking at `Scan` rows in Prisma Studio can tell "Shopify was actually down for this shop" apart from "one query happened to fail."
- **Why it earns its place:** a circuit breaker that fails fast but leaves identical, undifferentiated failure records behind is only half a resilience story — the other half is being able to *tell* sustained outages apart from one-off blips after the fact, which is what makes the breaker's existence actionable for whoever's on call.
- **Files to touch:** `app/prisma/schema.prisma` (if a new failure code needs a new enum value or the existing `failureCode` is a free string), `app/app/services/scan/runner.server.ts` (propagate the breaker-open signal into the failure write).
- **Done when:** a scan that fails because the breaker was open produces a visibly different `failureCode` than a scan that fails after exhausting a normal retry budget, provable in a runner-level test with two separate failure injections.
- **Estimated effort:** S-M (1-2 hrs), contingent on EX-1 existing first.

## Interview defense

**Q: Walk me through this codebase's retry logic and name what's missing for production-grade resilience.**
The real mechanism, precisely: `catalog-reader.server.ts`'s `runQuery` (`:200-241`) retries both rejected `admin.graphql()` calls and well-formed `THROTTLED` GraphQL error bodies, using exponential backoff with full jitter (`computeRetryDelayMs`, `:175-184`: `500ms * 2^attempt` capped at `8000ms`, jittered into the top half of that range) up to `maxRetries` (default 4), then throws a safe, non-leaking error. What's missing is a circuit breaker: nothing in this file remembers that the last several calls — within one `readCatalog` invocation, or across separate scans — all failed the same way. Every call starts its failure count at zero, so a sustained Shopify outage gets the exact same treatment as a single transient blip: full retry cycle, every time, for every call, for every scan, until the outage clears on its own.
```
  present: retry (stateless across calls)     absent: circuit breaker (stateful across calls)
  ┌────────────────────┐                       ┌─────────────────────────┐
  │ attempt→backoff→give│                       │ remember: last N calls  │
  │ up (resets each call)│                      │ failed → OPEN → fail    │
  └────────────────────┘                       │ fast, skip retry entirely│
                                                 └─────────────────────────┘
```
One-line anchor: *retry assumes the failure is temporary; a breaker assumes it might not be, and this repo only has the first assumption built.*

**Q: Why would you even need a circuit breaker here — doesn't the retry logic already handle Shopify being unavailable?**
Retry handles it *inefficiently* for a sustained outage, not correctly. If Shopify is down for ten minutes, every scan kicked off in that window pays the full retry-and-backoff cost — up to 4 attempts, each with a growing delay, for every GraphQL call that scan makes — before finally failing. A circuit breaker would notice after the first scan (or the first few calls) that the dependency is down and let every subsequent call fail in milliseconds instead of tens of seconds, freeing up whatever's running these scans (worker processes, request handlers) to do other work instead of waiting out a doomed retry cycle.

**Q: If you added a circuit breaker, where exactly would the state live, and why does that matter?**
It has to live somewhere that's shared across the calls it's meant to protect — which is the whole reason it doesn't exist by accident today. A per-`readCatalog`-invocation object (passed alongside `RetryPolicy`) is the smallest correct version: it catches a Shopify outage that spans multiple GraphQL calls within one scan's read. A cross-scan version needs process-level (or, if scans ever run on multiple workers, externally shared) state, because the whole value of a breaker is remembering failures *past* the boundary of a single call — put the state anywhere narrower than that and it can't do its job.

## See also

- `04-rate-limiting-backpressure.md` — the full retry/backoff mechanism this file's Case A points at, plus the separate `variantLimit` backpressure mechanism.
- `app/app/services/shopify/catalog-reader.server.ts` — `runQuery` (:200-241), `isThrottledErrorBody` (:186-198), `computeRetryDelayMs` (:175-184).
- `app/app/services/scan/runner.server.ts` — the failure-escalation catch block (:208-224) that today treats every downstream failure identically.
- `app/app/services/scan/queue.server.ts` — `ActiveScanError`, the one-active-scan-per-shop constraint that shapes why cross-scan circuit state hasn't been needed yet.
