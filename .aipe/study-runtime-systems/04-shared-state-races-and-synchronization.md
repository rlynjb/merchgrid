# Shared state, races, and synchronization

### Race conditions, TOCTOU, and cross-process synchronization — Industry standard (concurrency control), applied at the process/database boundary

## Zoom out, then zoom in

```
Zoom out — where shared state lives in this repo

┌─ Process layer ───────────────────────────────────────────────────┐
│  web process (many concurrent request tasks, one thread)           │
│  worker process (one task at a time, one thread)                   │
│  → NO shared memory between these two — separate V8 heaps          │
└──────────────────────────┬──────────────────────────────────────────┘
┌─ Storage layer ─────────────▼────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                     │
│  the ONE thing both processes actually share: /data/prod.sqlite      │
│  the `Scan.status` column IS the shared mutable state                │
└────────────────────────────────────────────────────────────────────────┘
```

Inside a single process, you never need a lock — the event loop already guarantees only one task's synchronous code runs at a time (file 02/03). The interesting race conditions in this repo all live at the one place two independent processes (or two concurrent requests within the *same* process) touch the *same* row without a hard database-level guard. There are exactly two of these, and the code names both of them in comments — this file walks what they are, why they're accepted, and what would have to change to close them.

## Structure pass

**Layers:** in-process task ordering (guaranteed serial by the event loop) → cross-request/cross-process access to the same DB row (NOT guaranteed serial unless the query itself is atomic). This is the seam that matters here.

**Axis: control — who has the final say on whether a check-then-act sequence stays consistent?**

```
  single-threaded JS  → the event loop; two tasks in the SAME process
                        never truly interleave mid-statement, only at
                        await points — but a check-then-act split
                        ACROSS two await points is NOT protected

  the database         → SQLite's own locking (one writer at a time),
                        but ONLY for a single statement — a
                        findFirst-then-create pair is two statements,
                        and nothing prevents another request's pair
                        from interleaving between them
```

**Seam — the load-bearing one in this file:** any place a "read, decide, then write" sequence spans more than one database statement is a seam where SQLite's per-statement locking stops helping you, and you're back to needing your own atomicity (a single conditional `UPDATE`, a transaction, or a unique index). Two of this repo's core flows sit exactly on that seam.

## How it works

### Move 1 — the mental model

You've hit this exact shape in frontend code: check `if (!isSubmitting) { setIsSubmitting(true); submit() }` — and if two click handlers fire close enough together, both can read `isSubmitting` as `false` before either sets it `true`. That's a TOCTOU (time-of-check-to-time-of-use) race, and it's the identical shape here, just with a database row standing in for React state, and "two HTTP requests" standing in for "two click handlers."

```
Pattern — TOCTOU: the gap between check and act

  request A:  check "any active scan?" ──► NO ──┐
                                                    │  both see "NO" —
  request B:  check "any active scan?" ──► NO ──┤  gap wasn't closed
                                                    │
  request A:  create scan ───────────────────────┘
  request B:  create scan ─────────────────────────► duplicate!
```

### Move 2 — the two races this repo actually has, and the one it deliberately doesn't need to guard

**Race #1 — `enqueueScan`'s active-scan check, `app/app/services/scan/queue.server.ts:44-78`.** The code is explicit about this one:

```javascript
// app/app/services/scan/queue.server.ts:54-68
// NOTE (TOCTOU): the "is a scan already active" check and the create below
// are not atomic — under true concurrent requests for the same shop, two
// callers could both pass the check and both create a scan. This is
// acceptable for MVP: the API layer serializes requests per merchant
// session in practice, and there is a single worker process consuming the
// queue, so a duplicate QUEUED row is a low-probability, low-impact edge
// case rather than a correctness hazard. Future hardening: a partial
// unique index (e.g. one row per shopId where status is non-terminal)
// enforced at the DB level would close this race properly.
const active = await getActiveScan(shopId);
if (active) {
  throw new ActiveScanError(/* ... */);
}
return prisma.scan.create({ /* status: "QUEUED" */ });
```
Step by step: `getActiveScan` runs one `SELECT`, resolves, and *then* `prisma.scan.create` runs a separate `INSERT` — two round-trips to SQLite, with an `await` boundary between them where the event loop is free to run a second, concurrent request's `enqueueScan` call for the *same* shop. If that second call's `SELECT` also lands before the first call's `INSERT` commits, both callers see "no active scan," both proceed to `create`, and the shop ends up with two `QUEUED` scans — violating the "one active scan per shop" business rule (FR-SCAN-002, per the code comment).

**Why this is accepted, not fixed:** the comment names the actual mitigating factors — a merchant's requests are effectively serialized by their own UI (you can't double-click "Scan" from one browser tab meaningfully often enough to matter), and even if a duplicate row landed, the single worker process (see below) processes scans one at a time regardless, so a duplicate is wasted work, not corrupted results. The **constructive fix already named in the comment**: a partial unique index at the DB level (`WHERE status IN (non-terminal statuses)`) would make the second `INSERT` fail outright — turning a logic-level TOCTOU into a database-enforced invariant that survives any amount of concurrency, including a future second web process.

**Race #2 (the one that isn't a race here, but would be with a second worker) — `claimAndRunNext`'s claim, `app/app/services/scan/worker-core.server.ts:22-38`.**

```javascript
// app/app/services/scan/worker-core.server.ts:22-38
/**
 * Single-worker model: this is intentionally not an atomic
 * claim-then-lock. With exactly one worker process consuming the queue,
 * "find the oldest QUEUED scan" can never race with another claimer. If a
 * second worker process is ever introduced, this needs to become an atomic
 * conditional update (e.g. `UPDATE Scan SET status='READING_CATALOG' WHERE
 * id=? AND status='QUEUED'`, checking the affected-row count) rather than a
 * plain findFirst, to avoid two workers claiming the same scan.
 */
export async function claimAndRunNext(adminFactory, deps) {
  const scan = await prisma.scan.findFirst({
    where: { status: "QUEUED" },
    orderBy: { createdAt: "asc" },
    include: { shop: true },
  });
  // ...
}
```
This is a `findFirst` with no accompanying `UPDATE ... WHERE status = 'QUEUED'` conditional write — a classic non-atomic claim pattern. The comment is doing the useful thing well: naming *exactly* the condition under which this becomes a real bug (a second worker process) and *exactly* the fix (a conditional `UPDATE` with an affected-row check, the same "compare-and-swap" idea Atomics/`compareExchange` gives you at the memory level, just expressed as a SQL predicate instead). Right now, with the single-worker topology file 01/02 established, there is only ever one caller of `findFirst` in existence — it cannot race with itself.

**What genuinely doesn't need a lock here: in-process state.** `worker.ts`'s `shuttingDown`, `idleSleepTimeout`, and `cancelIdleSleep` module-scope variables (`worker.ts:32-37`) are read and written from multiple places (`main()`'s loop, the signal handlers, `sleep()`'s executor) but never need a mutex — because file 02/03 already established that only one of those callbacks' *synchronous* portions ever runs at a time on this one thread. A signal handler firing mid-`await` doesn't interrupt the currently-running synchronous code; it queues as its own task and runs at the next available turn. Single-threaded execution is itself a synchronization primitive, for anything that stays inside one process.

**The real cross-process synchronization primitive: SQLite's own file lock.** Both the web and worker processes are separate OS processes with separate heaps — nothing in *application* code coordinates them. What actually prevents the two from corrupting the file is SQLite's own locking (a writer holds an exclusive lock for the duration of a write transaction; readers get a consistent snapshot). That's the mechanism `01-runtime-map.md`'s structure pass flagged as "control flips from process-level to storage-engine-level" — and it's why the two TOCTOU notes above are about *application-level* check-then-act sequences, not about SQLite corrupting data. SQLite guarantees each individual statement is atomic; it does nothing to guarantee a *sequence* of statements looks atomic to a concurrent caller unless you wrap them in a transaction or write a single conditional statement.

### Move 3 — the principle

A lock (or its cross-process equivalent — a unique index, a conditional `UPDATE`) is only needed at the seam where a check-then-act sequence crosses an `await` boundary that another caller could interleave into. Single-threaded execution already gives you that guarantee *within* a process; it buys you nothing *across* processes or across two separate database statements. The skill is spotting exactly which check-then-act sequences in your code have that gap — this repo's own comments are a good model for how to document "yes, this races, here's why it's fine today, here's the exact fix if the assumption changes."

## Primary diagram

```
Shared state across the whole repo, one frame

┌─ web process (many tasks) ──────┐   ┌─ worker process (one task) ────┐
│  enqueueScan:                     │   │  claimAndRunNext:                 │
│   SELECT active? ──►(await gap)──►│   │   findFirst QUEUED                │
│   INSERT new scan                 │   │   (safe: only ONE caller exists)  │
│   ⚠ TOCTOU — accepted, documented │   │   ⚠ would race with 2nd worker    │
└─────────────┬──────────────────────┘   └─────────────┬─────────────────────┘
              │                                          │
              └──────────────────┬───────────────────────┘
                                  ▼
                    /data/prod.sqlite — single-writer lock
                    (atomic per-statement; NOT atomic across
                     the multi-statement sequences above)
```

## Elaborate

This is the same lesson every "one row, two writers" system teaches, from a bank-balance race condition to a shopping-cart double-submit: the fix is never "add a `try/catch`," it's collapsing a check-then-act pair into one atomic operation the storage layer itself enforces — a unique constraint, an `UPDATE ... WHERE` guard with an affected-rows check, or a transaction wrapping both statements. What's worth carrying forward from this repo specifically: naming the exact condition that would turn an accepted risk into a real bug (`worker-core.server.ts`'s comment naming "a second worker process" as the trigger) is more valuable than either fixing it prematurely or leaving it silently unaddressed.

## Interview defense

**Q: "Find the race condition in `enqueueScan`."**
A: `getActiveScan` and `prisma.scan.create` are two separate statements with an `await` gap between them. Two concurrent calls for the same shop can both read "no active scan" before either one's `create` commits, producing two `QUEUED` rows for one shop.
```
  call A: SELECT (none) ──────────► INSERT
  call B:      SELECT (none) ─────────────► INSERT   ← duplicate
```
One-line anchor: check-then-act across an `await` boundary is a race unless the storage layer makes the whole sequence atomic.

**Q: "Why is `claimAndRunNext`'s non-atomic `findFirst` acceptable when the enqueue race isn't fully fixed either?"**
A: Both are accepted for the same underlying reason (single-worker/low-concurrency MVP), but `claimAndRunNext`'s comment is stronger: it's not just low-probability, it's *impossible* today, because there is exactly one caller of that function in the entire system. The enqueue race is merely low-probability — two concurrent HTTP requests for the same shop genuinely can happen. The fix path differs too: enqueue needs a DB-level unique constraint; the claim needs an atomic conditional `UPDATE` the day a second worker is introduced.

**Q: "Why doesn't `worker.ts`'s shared `shuttingDown` flag need a lock?"**
A: Because everything reading or writing it lives in the same single-threaded process — the event loop guarantees only one callback's synchronous code executes at a time. A signal handler doesn't preempt in-flight synchronous code; it's just another task queued to run at the next turn. Locks solve races between things that can truly run at the same instant; nothing in one Node process can.

## See also

- `01-runtime-map.md` — the process boundary that makes "in-process" vs "cross-process" the load-bearing distinction in this file.
- `02-processes-threads-and-tasks.md` — why single-threaded execution is itself a synchronization guarantee, for anything that stays inside one process.
- `07-backpressure-bounded-work-and-cancellation.md` — how "one active scan per shop" and "one worker globally" double as both a business rule and a concurrency limiter.
- `study-database-systems` — SQLite's own transaction/locking model underneath the TOCTOU discussion here.
