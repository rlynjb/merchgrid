# The event loop and async I/O

### Event loop phases, timers, and non-blocking I/O — Industry standard (Node.js / libuv event loop)

## Zoom out, then zoom in

```
Zoom out — where the event loop sits

┌─ Process layer (file 02) ────────────────────────────────────────┐
│  one Node process, one main thread                                │
└──────────────────────────┬──────────────────────────────────────────┘
┌─ Event loop layer ─────────▼──────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                       │
│  timers (setTimeout) · pending callbacks · poll (I/O) · check          │
│  Node dispatches: worker.ts's sleep, catalog-reader's retry backoff,   │
│  every Prisma call, every Shopify GraphQL fetch                        │
└──────────────────────────┬──────────────────────────────────────────────┘
┌─ I/O layer ─────────────────▼────────────────────────────────────────────┐
│  SQLite file · Shopify Admin GraphQL API (HTTPS)                        │
└────────────────────────────────────────────────────────────────────────────┘
```

File 02 established that each process has one thread running one task at a time. This file is about the mechanism that makes that thread *look* concurrent: the event loop, and specifically the two async primitives MerchGrid leans on hardest — timers (`setTimeout`-based sleep/backoff) and network I/O (GraphQL calls, Prisma queries) — both of which get handed off to libuv and only re-enter your JS callback when they're done.

## Structure pass

**Layers:** JS call stack → event loop phases (timers, poll, check) → libuv thread pool / OS async I/O. Node's own internals, not something this repo builds — but the repo's code has to be shaped around how this works, and two files show that shaping clearly: `worker.ts`'s cancelable sleep, and `catalog-reader.server.ts`'s retry backoff.

**Axis: guarantees — sync or async, and what's promised about timing?**

```
  setTimeout(fn, ms)   → "no earlier than ms" — NOT "exactly at ms."
                          If the event loop is busy, fn runs late.

  await admin.graphql() → "eventually resolves or rejects" — no
                          fixed latency; depends on Shopify's response
                          time AND libuv's poll phase picking it up

  Prisma query (SQLite) → mostly fast (local file), but still routed
                          through the same async machinery — SQLite
                          reads/writes are not literally instantaneous
                          to the JS thread even though the file is local
```

**Seam:** the boundary between "your `await`" and "libuv's poll phase" is where cancellation gets hard — once a `fetch`/GraphQL call or a SQLite query is in flight, JS code has no built-in way to abort it mid-flight without extra machinery (`AbortController`, which this repo doesn't use — see file 07). That's why `worker.ts`'s shutdown logic checks the `shuttingDown` flag *between* tasks rather than trying to interrupt one.

## How it works

### Move 1 — the mental model

You've built a `fetch()` with loading/success/error states in React. Same primitive here, just server-side: `await admin.graphql(...)` doesn't block the thread while waiting — it registers a callback, yields control, and the event loop calls that callback back once the HTTP response lands. `setTimeout` is the same idea for time itself: "call this back no sooner than N ms from now," not "pause the thread for N ms."

```
Pattern — the event loop's relevant phases for this repo

  ┌───────────────────────────────────────────────────────────┐
  │  timers phase   → setTimeout callbacks whose delay elapsed  │
  │       │            (worker.ts's sleep, retry backoff)       │
  │       ▼                                                     │
  │  poll phase     → I/O callbacks: GraphQL responses,         │
  │       │            Prisma/SQLite results arrive here         │
  │       ▼                                                     │
  │  check phase    → setImmediate (not used in this repo)      │
  │       │                                                     │
  │       └──────────────► loop repeats, forever, one thread    │
  └───────────────────────────────────────────────────────────┘
```

### Move 2 — the two load-bearing timer patterns in this repo

**Cancelable idle sleep — `worker.ts:39-53`.** This is the pattern to know cold, because it's the one place this repo builds a *cancelable* timer instead of a plain `await sleep(ms)`.

```javascript
// app/worker.ts:39-53
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    idleSleepTimeout = setTimeout(() => {
      idleSleepTimeout = null;
      cancelIdleSleep = null;
      resolve();
    }, ms);
    cancelIdleSleep = () => {
      if (idleSleepTimeout) clearTimeout(idleSleepTimeout);
      idleSleepTimeout = null;
      cancelIdleSleep = null;
      resolve();      // ← resolves the SAME promise early
    };
  });
}
```
Walk it step by step: the `Promise` executor schedules a `setTimeout`, and *also* stashes a second function, `cancelIdleSleep`, in module scope — closing over the same `resolve`. Normally, after 5000ms, the timer fires and resolves the promise. But if `requestShutdown` (`worker.ts:55-61`) runs first — because a `SIGTERM` arrived while the worker was idling — it calls `cancelIdleSleep()`, which does `clearTimeout` (so the original timer never fires) and calls the *same* `resolve` itself, immediately. Either path resolves the one promise exactly once; nothing double-resolves because `cancelIdleSleep` nulls itself out as its first act.

**What breaks if you remove the cancel path:** without it, a `SIGTERM` arriving right after the worker started a 5-second idle sleep would have to wait out the full 5 seconds before the loop even checks `shuttingDown` again — a real, if small, delay on every graceful shutdown. With it, shutdown during an idle sleep is near-instant.

**Retry backoff — `app/app/services/shopify/catalog-reader.server.ts:160-184`.** Same `setTimeout`-based sleep primitive, used for a different purpose: spacing out retries against Shopify's cost-throttling.

```javascript
// app/app/services/shopify/catalog-reader.server.ts:175-184
function computeRetryDelayMs(attempt: number): number {
  const capped = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** attempt,   // exponential: 500, 1000, 2000, 4000...
    RETRY_MAX_DELAY_MS,                   // capped at 8000ms
  );
  // Full jitter within [capped / 2, capped] so retries from concurrent
  // requests don't all wake up in lockstep.
  return capped / 2 + Math.random() * (capped / 2);
}
```
This `sleep` is *injectable* — it's a field on `ReadCatalogOptions` (`catalog-reader.server.ts:36`), defaulting to a real `setTimeout`-based `defaultSleep` (`catalog-reader.server.ts:164-166`) but overridable by a caller. `test/catalog-reader.test.ts:418,435,450` pass `sleep: async () => {}` — a no-op that resolves instantly — so the retry-exhaustion test path (`maxRetries: 2`, line 451) runs in milliseconds instead of waiting out real exponential backoff. This is the event loop made *testable*: because the timer is behind an injected function rather than a hardcoded `setTimeout` call, a test can swap out "real elapsed time" for "resolve immediately" without touching the retry logic itself.

**The retry loop itself is a `for (;;)` with an `await` inside, not a recursive call:**

```javascript
// app/app/services/shopify/catalog-reader.server.ts:200-241 (condensed)
async function runQuery(admin, query, variables, policy) {
  let attempt = 0;
  for (;;) {
    // ... issue the GraphQL call, catch network errors ...
    if (isThrottledErrorBody(body) && attempt < policy.maxRetries) {
      await policy.sleep(computeRetryDelayMs(attempt));  // yields the thread here
      attempt += 1;
      continue;
    }
    return body;  // success or a non-retryable error thrown above
  }
}
```
Each `await policy.sleep(...)` is a real yield point: the event loop is free to run other tasks (another shop's HTTP request, another scan's DB write) while this one retry backs off. That's the entire payoff of `async`/`await` over a blocking sleep — a slow, retrying Shopify call in the worker process never freezes anything else on that same thread.

**Where Prisma fits in.** Every `prisma.scan.findFirst`, `prisma.finding.findMany`, etc. across `worker-core.server.ts`, `runner.server.ts`, and `scan-api.server.ts` is `await`ed. Prisma's query engine talks to SQLite through its own binary/engine process boundary, and that round-trip — even against a local file — goes through the same async machinery: the calling JS code yields at the `await`, and Node's poll phase resumes it once the engine responds. Locally fast doesn't mean synchronous; it's still a real yield point where another task on the same thread could run.

### Move 3 — the principle

Async I/O's entire value proposition is turning "wait for a slow thing" into "do something else while waiting" — on one thread, no extra hardware required. The corollary this repo demonstrates well: if your sleep/backoff primitive isn't swappable, it isn't testable without burning real wall-clock time in your test suite. Injecting `sleep` here isn't over-engineering — it's what makes `test/catalog-reader.test.ts`'s retry-exhaustion test run in milliseconds instead of tens of seconds.

## Primary diagram

```
Event loop, full picture across this repo's two timer use sites

┌─ single thread, one process ─────────────────────────────────────────┐
│                                                                          │
│  worker.ts main loop                                                    │
│    claimAndRunNext() ──await──► [yields] ──► resumes when DB/GraphQL    │
│                                                 I/O completes             │
│    sleep(5000) ──setTimeout──► [yields] ──► resumes at 5s OR early via  │
│                                                 cancelIdleSleep() on      │
│                                                 SIGINT/SIGTERM             │
│                                                                          │
│  catalog-reader.server.ts runQuery loop                                 │
│    admin.graphql() ──await──► [yields] ──► resumes with response/error  │
│    on THROTTLED: sleep(backoff) ──await──► [yields] ──► resumes, retries│
│                                                                          │
│  while any of the above is yielded, the SAME thread can run:            │
│    - the OTHER process's own tasks (different thread entirely)          │
│    - any other pending task within THIS process (e.g. another loader)   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is textbook Node event-loop usage — nothing exotic, no `setImmediate`, no `process.nextTick` micro-scheduling tricks, no manual libuv thread-pool tuning (`UV_THREADPOOL_SIZE`). That restraint is itself a good sign: the moment you find yourself reaching for `process.nextTick` to "jump the queue," it's usually because something upstream should have been a Promise in the first place. The one place worth studying further if you want to go deeper on Node internals specifically is how Prisma's query engine process communicates back to the JS thread — that's a real process/IPC boundary hiding behind what looks like a plain `await`, and it's outside this repo's own code to control.

## Interview defense

**Q: "Walk me through what happens when the worker's idle sleep is cancelled by a SIGTERM."**
A: `requestShutdown` sets `shuttingDown = true` and calls `cancelIdleSleep()` if it's set. That function does `clearTimeout` on the pending timer (so it never fires later) and calls the same `resolve` the original `setTimeout` callback would have called — resolving the sleep's promise immediately instead of after the full delay. The `main()` loop's `await sleep(POLL_MS)` returns right away, the `while` condition re-checks `shuttingDown`, and the loop exits cleanly.
```
  idle:      [sleep started]────────────5000ms──────────►[resolves]
  SIGTERM:   [sleep started]──►[cancelIdleSleep()]──►[resolves NOW]
```
One-line anchor: the same promise, resolved by whichever path gets there first — a race the code makes deliberately safe by nulling the loser out.

**Q: "Why inject `sleep` into `readCatalog` instead of just calling `setTimeout` directly?"**
A: Testability without real time. A test asserting "after `maxRetries` throttled responses, the call throws a safe error" needs the retry loop's logic exercised, not its literal wall-clock delay. Injecting a no-op `sleep` in tests keeps the production code path (real exponential backoff) unchanged while making the test run in milliseconds.
One-line anchor: if a timing-dependent function isn't parameterized over its timer, its tests either wait for real time or never exercise the timing path at all.

**Q: "Is SQLite access here synchronous or asynchronous from Node's point of view?"**
A: Asynchronous through Prisma — every call is `await`ed and goes through Prisma's query-engine process boundary, which means even a fast local file read is still a real yield point on the event loop, not a blocking call.

## See also

- `02-processes-threads-and-tasks.md` — the single thread this event loop runs on.
- `07-backpressure-bounded-work-and-cancellation.md` — the retry cap (`maxRetries`) and the shutdown-cancellation flow this file's mechanics enable.
- `study-networking` — the Shopify GraphQL retry/backoff pattern from the transport-and-protocol side.
