# Backpressure, bounded work, and cancellation

### Concurrency limits, overload protection, and graceful shutdown — Industry standard, applied throughout the scan pipeline

## Zoom out, then zoom in

```
Zoom out — where bounded-work and cancellation decisions live

┌─ Business-rule layer ────────────────────────────────────────────────┐
│  ACTIVE_STATUSES check: one active scan per shop                      │
└──────────────────────────┬───────────────────────────────────────────────┘
┌─ Pipeline layer ─────────────▼───────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                         │
│  catalogVariantLimit — bounds how much ONE scan reads                    │
│  maxRetries + exponential backoff — bounds how long a retry sequence runs │
│  MAX_PAGE_SIZE — bounds how much ONE request returns                     │
│  single worker process — bounds GLOBAL scan concurrency to exactly 1     │
└──────────────────────────┬───────────────────────────────────────────────┘
┌─ Process-lifecycle layer ────▼───────────────────────────────────────────┐
│  SIGINT/SIGTERM → supervisor forwards → worker's own cooperative drain   │
└────────────────────────────────────────────────────────────────────────────┘
```

Every one of this repo's other concepts (memory, event loop, shared state) eventually points back to a bound *somewhere*. This file collects every explicit limit in one place — what it bounds, what happens when the bound is hit, and how the whole system shuts down cleanly instead of dropping work mid-flight.

## Structure pass

**Layers:** the business rule ("one scan per shop") → the pipeline's own resource limits (variant count, retry count, page size) → the process's shutdown sequencing. Each layer bounds a different kind of unboundedness — merchant behavior, catalog size, network flakiness, and process lifetime, respectively.

**Axis: guarantees — is the bound a hard ceiling or a best-effort cooperative one?**

```
  catalogVariantLimit    → HARD ceiling — enforced by the read loop
                            itself, checked before every sub-query

  maxRetries              → HARD ceiling — a for(;;) loop with an
                            explicit exit condition (attempt >= maxRetries)

  MAX_PAGE_SIZE            → HARD ceiling — clamped with Math.min
                            regardless of what the caller requests

  worker shutdown          → COOPERATIVE — checked at specific safe
                            points (between scans, during idle sleep),
                            NOT a hard mid-operation abort
```

**Seam:** the boundary between "hard ceiling enforced by the code doing the work" and "cooperative checkpoint checked between units of work" is the one to watch — a hard ceiling can never be exceeded even by a bug elsewhere; a cooperative checkpoint can only ever be as responsive as the gaps between its checkpoints are short. The worker's shutdown is only as fast as its longest single scan (or single retry backoff) takes to finish.

## How it works

### Move 1 — the mental model

Every rate-limited API client you've built already has this shape: cap how much you request in one go, back off and retry on a 429, and give up after N attempts rather than retrying forever. MerchGrid applies that same discipline in four separate, independent places — this section is a tour of all four, plus the shutdown sequence that has to interact correctly with whichever one happens to be in flight.

```
Pattern — bounded work, four independent ceilings

  merchant behavior  ──►  1 active scan per shop (business rule)
  catalog size        ──►  catalogVariantLimit (soft-cap, hard-enforced)
  network flakiness    ──►  maxRetries + capped exponential backoff
  API response size     ──►  MAX_PAGE_SIZE (query result clamp)
  global scan throughput ──►  exactly 1 worker process (structural)
```

### Move 2 — walking each bound, and the shutdown that has to respect all of them

**Bound #1 — one active scan per shop, `app/app/services/scan/queue.server.ts:14-19, 63-68`.** `ACTIVE_STATUSES` (`QUEUED`, `READING_CATALOG`, `RUNNING_CHECKS`, `PREPARING_RESULTS`) defines "in flight"; `enqueueScan` throws `ActiveScanError` if the shop already has one. This is a form of backpressure at the *business* level — it isn't protecting a resource from overload directly, it's protecting the merchant from confusing double-runs and protecting the pipeline from needing to reason about two concurrent scans for the same shop's data. (File 04 already covered the TOCTOU gap in this specific check — it's the same mechanism, viewed here for what it bounds rather than how it can race.)

**Bound #2 — `catalogVariantLimit`, enforced inside `readCatalog`, `app/app/services/shopify/catalog-reader.server.ts:400-452`.** Walked in full in file 05 (memory) — the same bound is *also* a bounded-work mechanism: it caps how many GraphQL round-trips one scan can issue, not just how much memory it uses. A merchant with an enormous catalog gets a `partial: true` result rather than a scan that runs indefinitely.

**Bound #3 — retry ceiling with capped exponential backoff, `app/app/services/shopify/catalog-reader.server.ts:160-184, 200-241`.** This is the load-bearing skeleton to know cold:

```
Isolate the kernel — a bounded retry loop needs exactly these parts:

  attempt counter          → without it, there's no way to know when
                             to stop; the loop retries forever
  a stop condition           → `attempt < policy.maxRetries` — without
                             it, a persistently failing call retries
                             infinitely, burning the event loop and
                             Shopify's rate-limit budget forever
  a growing (capped) delay    → without capping, exponential growth
                             (500ms, 1s, 2s, 4s, 8s, 16s...) eventually
                             makes each retry wait for MINUTES
  jitter                      → without it, many concurrent retries
                             (across shops) wake up in lockstep and
                             hammer Shopify's API at the same instant
```

```javascript
// app/app/services/shopify/catalog-reader.server.ts:206-224 (condensed)
let attempt = 0;
for (;;) {
  try {
    const response = await admin.graphql(query, { variables });
    body = await response.json();
  } catch {
    if (attempt < policy.maxRetries) {          // ← the stop condition
      await policy.sleep(computeRetryDelayMs(attempt));
      attempt += 1;
      continue;
    }
    throw new Error("Failed to read catalog from Shopify: ...");  // ← gives up
  }
  // ...
}
```
Total worst-case wait across all retries for one query, with the defaults (`maxRetries: 4`, base 500ms, cap 8000ms): roughly 500+1000+2000+4000ms of backoff (jittered), well under the 5-second force-exit fallback in the supervisor's own shutdown path (see below) — worth knowing precisely if `maxRetries` or the base delay is ever tuned up, because it changes how long a shutdown might have to wait for a mid-retry scan to finish.

**Bound #4 — `MAX_PAGE_SIZE`, `app/app/services/scan/scan-api.server.ts:27-28, 240-245`.**

```javascript
// app/app/services/scan/scan-api.server.ts:27-28, 240-245
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// ...
const pageSize = Math.min(
  opts.pageSize && opts.pageSize > 0 ? Math.floor(opts.pageSize) : DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
);
```
`Math.min` here is doing the actual clamping — whatever a caller (a route handler passing along a query param) requests, the resolved `pageSize` can never exceed 200. This protects the results-page UI's own request/response cycle from an unbounded query, independent of every other bound in this file — it's the one bound that guards against a caller-supplied number rather than an upstream API's response size.

**Bound #5 — the structural one: exactly one worker process, globally.** File 01/02 already established this as the runtime topology; the *bounded-work* framing of the same fact is that global scan concurrency is hard-capped at 1, not per-shop but system-wide, purely because there's only one `while` loop in existence draining the queue. This is the least "designed" bound in the list — nobody wrote a semaphore or a concurrency-limit config value — but it's the most consequential one (see file 08's ranked findings): every other shop's queued scan waits behind whichever one the single worker happens to be running.

**Cancellation — the two-layer graceful shutdown, `app/start-production.js:89-136` and `app/worker.ts:32-92`.** This is where "bounded work" and "cancellation" meet: a shutdown signal has to be honored *without* corrupting an in-flight scan.

```
Layers-and-hops — a SIGTERM's path through the system

┌─ Fly machine supervisor ─┐  sends SIGTERM   ┌─ start-production.js ──┐
│  (deploy, restart, etc.)  │─────────────────►│  forwardSignal()         │
└───────────────────────────┘                  └────────────┬─────────────┘
                                          hop: child.kill(signal)
                                   ┌──────────────┴──────────────┐
                                   ▼                              ▼
                          ┌─ web process ──┐             ┌─ worker process ──┐
                          │ remix-serve's    │             │ worker.ts's OWN    │
                          │ own SIGTERM       │             │ SIGINT/SIGTERM     │
                          │ handling           │             │ handler fires       │
                          └──────────────────┘             └────────┬───────────┘
                                                                     │ sets shuttingDown=true,
                                                                     │ cancels idle sleep if any
                                                                     ▼
                                                       loop finishes CURRENT
                                                       scan (if mid-scan),
                                                       then exits cleanly
```

Step by step: the supervisor's own `SIGINT`/`SIGTERM` handlers (`start-production.js:134-135`) call `forwardSignal`, which calls `stopAll(signal)` (`start-production.js:93-103`) — this sends the *same* signal to both children via `child.kill(signal)`, then schedules a 5-second fallback (`setTimeout(() => process.exit(exitCode), 5000).unref()`) in case a child ignores the signal entirely (stuck in a non-interruptible operation). Meanwhile, `worker.ts`'s *own* `SIGINT`/`SIGTERM` handlers (`worker.ts:63-64`) — registered independently inside the worker process itself, not by the supervisor — call `requestShutdown` (`worker.ts:55-61`), which sets `shuttingDown = true` and cancels any in-progress idle sleep (file 03 walked this cancellation mechanism in full).

**The critical design choice: shutdown is checked only at safe points, never mid-operation.** Look again at the loop:

```javascript
// app/worker.ts:69-89 (condensed)
while (!shuttingDown) {
  scanId = await claimAndRunNext(adminFactory);  // ← NOT interrupted if
                                                   //   shuttingDown flips
                                                   //   mid-call
  if (shuttingDown) break;                        // ← checked HERE, after
  if (scanId) continue;
  await sleep(POLL_MS);                            // ← cancelable if idle
}
```
If `shuttingDown` becomes `true` while `claimAndRunNext` is mid-flight — say, mid-retry-backoff inside `readCatalog`, or mid-`$transaction` persisting findings — the loop does **not** abort that call. It lets the current scan finish (or fail) completely, checks `shuttingDown` only *after* `claimAndRunNext` resolves, and only then exits. **What breaks if shutdown instead force-aborted an in-flight scan:** a scan interrupted mid-`readCatalog` would leave the `Scan` row stuck at `READING_CATALOG` forever (no code path moves it to `FAILED` on a killed process — that only happens inside `runScan`'s own `try/catch`, which never gets to run if the process is killed out from under it); interrupted mid-`$transaction` in `runner.server.ts:187-207` would be safe (SQLite rolls back an incomplete transaction), but interrupted mid-GraphQL-call would simply waste the in-flight request with no cleanup. Cooperative, checkpoint-based cancellation avoids all of that — at the cost of shutdown latency bounded by "however long the current scan takes," not by a fixed timeout of the worker's own choosing (only the *supervisor's* 5-second fallback provides a true hard ceiling, and that one exits the supervisor process itself, relying on Fly's machine-level teardown to actually stop anything still running).

### Move 3 — the principle

Every unbounded-in-principle thing this repo touches — catalog size, retry attempts, page requests, shutdown timing — has an explicit ceiling except the one dimension (worker count) where the ceiling is structural rather than configured. The tell for "is this actually bounded" is always the same question: is there a loop here that could, under some real input, run forever or grow forever — and if so, where exactly does it check?

## Primary diagram

```
Every bound in this repo, one frame

  merchant     catalog       Shopify        page          worker
  concurrency  size          retries        requests      concurrency
  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐
  │ 1 active │  │ variant  │  │ maxRetries │  │ MAX_PAGE  │  │ exactly 1 │
  │ scan per │  │ Limit    │  │ + capped   │  │ _SIZE=200 │  │ process,  │
  │ shop     │  │ (5000)   │  │ backoff    │  │ (clamped) │  │ globally  │
  │ (TOCTOU, │  │ (hard,   │  │ (hard,     │  │ (hard,    │  │ (struct-  │
  │ accepted)│  │ enforced)│  │ enforced)  │  │ enforced) │  │ ural)     │
  └─────────┘  └──────────┘  └───────────┘  └──────────┘  └───────────┘
        all of the above must be respected by the shutdown sequence:
        SIGTERM → supervisor forwards → worker finishes current scan
        → exits; 5s supervisor fallback as the true hard ceiling
```

## Elaborate

The overall shape here — cooperative cancellation checked at safe points, a hard fallback timeout as a last resort — is the same pattern most graceful-shutdown implementations converge on (Kubernetes' `preStop` hook + `terminationGracePeriodSeconds` is the same idea at the orchestrator level: ask nicely, then kill after a grace period). What's worth carrying forward: MerchGrid's version doesn't have a per-worker timeout of its own — the 5-second fallback belongs to the *supervisor*, and it exits the supervisor process rather than force-killing the children directly. In this specific deployment, that's fine because a supervisor exit is itself the signal Fly needs to tear down and restart the whole machine — but it's a detail worth knowing precisely rather than assuming "5 seconds" is a hard per-scan cancellation timeout, because it isn't one.

## Interview defense

**Q: "What happens to a scan that's mid-retry-backoff when SIGTERM arrives?"**
A: Nothing interrupts it. `shuttingDown` is set, but the loop only checks it after `claimAndRunNext` (and everything inside it, including any in-flight retry backoff) fully resolves. The scan either completes or fails through its own normal error handling; shutdown just means the loop won't start a *new* scan afterward.
One-line anchor: cancellation here is "don't start the next thing," not "abort the current thing."

**Q: "Name the load-bearing part of the retry loop people forget."**
A: The stop condition (`attempt < policy.maxRetries`) paired with jitter. People remember "exponential backoff" but forget that without a hard attempt ceiling, a persistently-throttled endpoint retries forever, and without jitter, many concurrent retries (across different shops' scans, if concurrency ever grows) synchronize and slam the API at the same instant instead of spreading out.

**Q: "Where's the true hard ceiling on shutdown time, and what does it actually do?"**
A: The supervisor's 5-second `setTimeout(() => process.exit(exitCode), 5000).unref()` in `stopAll`. But it exits the *supervisor*, not the children directly — it's a fallback for "don't hang forever if a child ignores its signal," relying on the fact that a supervisor exit is itself the trigger for Fly to tear down and restart the whole machine, taking any still-running child down with it at the container level.

## See also

- `03-event-loop-and-async-io.md` — the cancelable-sleep mechanism (`cancelIdleSleep`) this file's shutdown walkthrough builds on.
- `04-shared-state-races-and-synchronization.md` — the same "one active scan per shop" check, from the race-condition angle rather than the bounded-work angle.
- `08-runtime-systems-red-flags-audit.md` — where "exactly one worker, globally" ranks as this repo's most consequential structural bound.
