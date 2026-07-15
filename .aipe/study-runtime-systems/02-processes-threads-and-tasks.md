# Processes, threads, and tasks

### Process boundaries, worker threads, and cooperative task scheduling — Industry standard (POSIX processes / Node.js concurrency model)

## Zoom out, then zoom in

```
Zoom out — where process/thread/task decisions get made

┌─ OS / container layer ───────────────────────────────────────────┐
│  Fly machine, one Linux container                                 │
└──────────────────────────┬─────────────────────────────────────────┘
┌─ Process layer ───────────▼────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                   │
│  start-production.js spawns web + worker as OS processes;          │
│  each process runs ONE V8 instance, ONE main thread                │
└──────────────────────────┬─────────────────────────────────────────┘
┌─ Task layer ───────────────▼────────────────────────────────────────┐
│  Inside each process: async functions queued on that process's     │
│  single event loop — no OS threads spawned by app code             │
└──────────────────────────────────────────────────────────────────────┘
```

`01-runtime-map.md` named the two processes. This file is about the layer just below that: what a "thread" is here (there's exactly one per process, doing everything), and what a "task" is (an `async` function on that one thread's event loop) — and why this repo never reaches for a second thread even though Node gives you `worker_threads` for exactly that.

## Structure pass

**Layers:** OS process → V8 main thread → task (an `async` call). Three levels; every one of them is single-occupancy in this repo — one process boundary chosen deliberately (file 01), one thread per process because Node defaults to it, one task running to completion (or an `await` point) before the next task's callback fires.

**Axis: dependency — what does each level depend on to make progress?**

```
  process   → depends on the OS scheduler giving it CPU time
  thread    → depends on the process having a live V8 instance
  task      → depends on the thread's event loop reaching its turn
             AND on whatever I/O it's awaiting completing
```

**Seam:** the boundary between "process" and "thread" is where CPU-bound work would have to cross if this repo ever needed it — Node's `worker_threads` module exists precisely to let CPU-heavy work escape the single main thread without blocking it. MerchGrid never crosses that seam because nothing here is CPU-bound (see Move 2's "what's missing" section) — the checks engine (`@merchgrid/catalog-checks`) runs synchronously but on catalogs capped at a few thousand variants, well under the threshold where blocking the event loop for milliseconds becomes a real problem.

## How it works

### Move 1 — the mental model

If you've ever debugged "why did my React state update feel delayed" you already know the event-loop intuition: JavaScript runs one thing at a time on one thread, and everything else — network calls, timers — gets handled by yielding back to that same thread when the result is ready. Node's server-side runtime is the identical model, just with `fetch`/DB calls instead of DOM events as the async sources.

```
Pattern — one thread, cooperative task scheduling

  ┌─────────────────────── single thread ───────────────────────┐
  │                                                                │
  │   task A runs ──► hits `await` ──► yields                     │
  │                                       │                         │
  │                          thread free to run task B             │
  │                                       │                         │
  │   task A resumes ◄── I/O completes ◄──┘                         │
  │                                                                │
  └────────────────────────────────────────────────────────────────┘
```

Nothing runs *in parallel* on this thread — task A and task B interleave, they never overlap. The illusion of concurrency comes entirely from tasks spending most of their time waiting on I/O, not computing.

### Move 2 — walking the two processes' task models

**The web process's tasks: one per request.** Each Remix loader/action invocation is a task. Two merchants hitting the app at once produce two tasks interleaved on the same thread — fine, because each one spends almost all its wall-clock time awaiting a Prisma query or a Shopify GraphQL call, not computing.

**The worker process's tasks: one scan claim, run serially, by construction — not by an accident of scheduling.**

```javascript
// app/worker.ts:66-92
async function main(): Promise<void> {
  console.log("[worker] scan worker starting");

  while (!shuttingDown) {
    let scanId: string | null = null;
    try {
      scanId = await claimAndRunNext(adminFactory);
    } catch (err) {
      console.error("[worker] error while claiming/running a scan", err);
    }

    if (shuttingDown) break;

    if (scanId) {
      continue;          // more QUEUED work likely — poll again now
    }

    await sleep(POLL_MS); // idle — wait 5s before polling again
  }

  console.log("[worker] scan worker stopped");
}
```
Read this as a state machine, one step at a time: `claimAndRunNext` is `await`ed, meaning the loop body cannot start its next iteration until the current scan (claim + full `runScan` pipeline) is completely done. There is no `Promise.all` fan-out here, no second scan starting while the first is mid-flight. **This is the load-bearing design choice of this whole process:** the worker processes exactly one scan at a time, globally, across every shop using MerchGrid.

**Isolate the kernel — what makes this a poll loop and not just a function call:**
- the `while (!shuttingDown)` condition — drop it and the loop runs exactly once and the process exits, defeating the entire point of "keep draining the queue forever"
- the `try/catch` around `claimAndRunNext` — drop it and one bad scan (or one transient DB hiccup during the claim) throws out of `main()`, and the `.catch` at the bottom (`worker.ts:94-97`) calls `process.exit(1)`, killing the *entire* worker for every other shop's queued work
- the `sleep(POLL_MS)` on the idle path — drop it and an empty queue becomes a tight, CPU-spinning `while(true)` making database round-trips as fast as the event loop can schedule them

**What's optional hardening, not kernel:** the `continue` fast-path when a scan was just claimed (skips the 5s sleep so a backlog drains faster) is a throughput optimization, not correctness-critical — remove it and the worker still works, just slower when catching up.

**Why no `worker_threads` or `cluster` here.** Both exist in Node specifically to escape the single-thread limitation — `worker_threads` for CPU-bound work that would otherwise block the event loop, `cluster` for scaling a single machine's HTTP throughput across multiple cores by forking multiple processes that share a listening socket. MerchGrid needs neither:
- the scan pipeline (`readCatalog` → `normalizeCatalog` → `runChecks`) is I/O-bound (network round-trips to Shopify) with the actual compute (comparing prices, computing margins across a few thousand variants) taking low milliseconds — nowhere near the threshold where it visibly stalls the event loop
- `cluster`-style multi-core web scaling is exactly what `fly.toml`'s comment rules out: more web processes on one machine would still all point at the same single-writer SQLite file, buying nothing

```
Layers-and-hops — where CPU-bound work WOULD have to hop off-thread
(not exercised in this repo)

┌─ main thread ─────┐  would need   ┌─ worker_threads pool ────┐
│  event loop        │──────────────►│  CPU-bound computation    │
│  (blocked if you    │  hop: postMessage,  │  runs on separate    │
│  compute here)      │  structured clone   │  V8 isolate           │
└────────────────────┘                └───────────────────────────┘
```

### Move 3 — the principle

A thread is a scheduling unit; a task is a unit of work waiting to run on one. When your work is I/O-bound, adding threads doesn't make it faster — it just adds coordination overhead for CPU cycles you weren't using anyway. The right question isn't "should I use `worker_threads`" but "is anything here actually saturating a CPU core" — and in MerchGrid, nothing is, yet.

## Primary diagram

```
Process/thread/task inventory, full picture

┌─ web process (1 thread) ─────────┐  ┌─ worker process (1 thread) ──────┐
│  event loop                       │  │  event loop                       │
│   task: loader/action per request │  │  task: claimAndRunNext (serial)   │
│   many tasks interleaved,          │  │  ONE task in flight at a time,    │
│   never overlapping                │  │  by design (awaited in a loop)    │
└────────────────────────────────────┘  └────────────────────────────────────┘
        no worker_threads spawned in either — nothing here is CPU-bound
```

## Elaborate

This is the standard Node.js server model, unmodified: one event loop per process, `async`/`await` as the task abstraction, and threads reached for only when profiling actually shows a CPU-bound hotspot (JSON parsing of huge payloads, image processing, crypto-heavy work). MerchGrid's own crypto (AES-256-GCM session token encryption, `token-crypto.server.ts`) is a candidate you might *expect* to need `worker_threads` for — but Node's built-in `crypto` module uses OpenSSL under the hood, which does its own work off the main thread via the libuv thread pool, not via JS-level `worker_threads`. That's a different escape hatch than this file covers (see file 03 for libuv's role).

## Interview defense

**Q: "If Node is single-threaded, how are two shops' HTTP requests handled 'at the same time'?"**
A: They're not handled in parallel — they're interleaved. Each request handler spends nearly all its time `await`ing I/O (DB, Shopify API), and the event loop runs a different task's synchronous portion while the first waits. It feels concurrent because I/O latency dwarfs JS execution time.
One-line anchor: concurrency without parallelism — many tasks in flight, one thread executing any given instant.

**Q: "Would this app benefit from `worker_threads`?"**
A: Only if profiling showed a CPU-bound hotspot blocking the event loop — and nothing in this repo's checks engine or normalization does; it's all comparisons and arithmetic over a bounded (≤ a few thousand variant) array. The bottleneck here is the Shopify API round-trip and the single SQLite writer, neither of which more JS threads would help.
One-line anchor: threads fix CPU contention, not I/O latency — and this repo's contention is entirely I/O.

**Q: "What's the worst-case blast radius of an unhandled error inside the worker's task?"**
A: The `try/catch` inside the loop (`worker.ts:71-78`) catches per-scan failures so one bad scan doesn't kill the process. But an error thrown *outside* that try (a bug in the loop's own control flow) propagates to `main().catch(...)` (`worker.ts:94-97`), which calls `process.exit(1)` — taking down every other shop's queued scan with it. The kernel part people forget: the try/catch's placement, not its mere existence, is what decides the blast radius.

## See also

- `01-runtime-map.md` — the process boundary this file's threads/tasks live inside.
- `03-event-loop-and-async-io.md` — the event loop mechanics (microtask/macrotask ordering, timers) this file assumed but didn't unpack.
- `07-backpressure-bounded-work-and-cancellation.md` — why the worker's serial, one-scan-at-a-time task model is also this repo's concurrency limiter.
