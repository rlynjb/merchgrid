# Clocks, Coordination, and Leadership

Wall-clock ordering / leader election / leases — Industry standard —
**leadership and consensus not yet exercised**

## Zoom out, then zoom in

```
  Zoom out — where clocks and coordination sit

  ┌─ Service layer ─────────────────────────────────────────────┐
  │  claimAndRunNext() orders by Scan.createdAt (wall clock)      │
  │  ★ NO LEADER ELECTION, NO LEASE, NO LOCK ANYWHERE HERE ★     │ ← we are here
  └───────────────────────┬────────────────────────────────────────┘
                          │ implicit: "the one worker process IS the leader"
  ┌─ Deploy layer ────────▼────────────────────────────────────────┐
  │  exactly ONE worker process (start-production.js spawns it once)│
  └──────────────────────────────────────────────────────────────────┘
```

Two different questions live under "clocks and coordination," and this
repo answers one of them and doesn't need to answer the other yet. First:
*does anything here rely on wall-clock time for ordering, and is that
safe?* Yes, and yes — for reasons specific to having one worker. Second:
*is there a leader-election or lease mechanism anywhere?* No — because
there's only ever one process that could be leader, so electing one is a
solved problem by construction. Both deserve to be named precisely rather
than either ignored or apologized for.

## Structure pass — layers, axis, seams

**Layers:** the wall clock each process reads locally → the `createdAt`
timestamps written to `Scan` rows → the ordering decision made from those
timestamps.

**The axis: guarantees — is ordering promised, or best-effort?**

```
  Guarantees axis for time-based ordering here

  single-process time reads   →  monotonic, trivially consistent
                                  (one clock, one process, no skew possible)
  Scan.createdAt ordering     →  promised FIFO — see the seam below for why
                                  it's actually safe with only one writer
```

**The seam: wall-clock ordering is only safe because writes to `createdAt`
are never concurrent from two different clocks.** In a genuinely
distributed system, using each node's local wall clock to order events
across nodes is a classic correctness bug — clock skew between machines can
make event B's timestamp earlier than event A's even though A happened
first (this is precisely the problem Lamport clocks and vector clocks
solve). That bug requires *multiple writers with different clocks*. This
repo has one writer path for `Scan.createdAt` (Prisma's `@default(now())`,
evaluated wherever the write happens) and, more importantly, one single
worker consuming it — so even if clock skew existed, there'd be no second
consumer to disagree with about ordering. The seam is inert today
precisely because there's nothing on the other side of it.

## How it works

### Move 1 — the mental model

You've written a sort by `createdAt` on a list of rows from one Postgres
table before — trivial, because the database assigned every timestamp from
its own single clock. That's exactly what's happening here: `Scan.createdAt`
comes from wherever the row is created (the web process, via Prisma's
`@default(now())`), and the *only* consumer that ever reads it for ordering
is one worker process. There's no second clock to disagree with.

```
  Pattern: this repo's actual clock topology

  ┌──────────────┐   write createdAt    ┌──────────────┐
  │ web process   │ ───────────────────► │  Scan rows    │
  │ (1 clock)     │                      │  in SQLite    │
  └──────────────┘                      └──────┬───────┘
                                                │ orderBy createdAt asc
                                                ▼
                                       ┌──────────────┐
                                       │ worker (1)    │  ← only ONE reader
                                       │               │    of this ordering
                                       └──────────────┘
```

### Move 2 — where a real clock problem would appear, and where a real
leadership problem would appear

**Wall-clock ordering — where it's used, and why it's currently safe.**
`claimAndRunNext` (`app/app/services/scan/worker-core.server.ts:34-38`)
orders strictly by `createdAt asc`. If a second application server ever
wrote `Scan` rows from a *different* machine with clock drift relative to
the first (imagine a future multi-region write path), two scans enqueued
moments apart in real time could get `createdAt` values in the wrong
relative order, and "oldest first" would stop meaning what it's supposed
to. **What breaks without a fix at that point:** a merchant whose scan was
actually requested first could be served after a merchant who requested
second, with no way to detect it happened. **The standard fix** at that
scale is not "synchronize clocks harder" (NTP only gets you to
millisecond-ish agreement, not a correctness guarantee) — it's a logical
clock: a Lamport timestamp or a monotonically increasing sequence number
assigned by a single authority (e.g. an autoincrementing ID, or a
centralized sequencer), so ordering is derived from causality/sequence
rather than from wall time at all. This repo doesn't need that yet because
there is exactly one writer of `Scan.createdAt` that matters for ordering
purposes and exactly one reader of the ordering.

**The injectable clock for test determinism, a different clock concern
entirely** (`app/app/services/scan/runner.server.ts:14-16,28-30,128`):

```ts
export interface RunScanDeps {
  /** Injectable ISO-8601 clock, used only for finding `detectedAt` values, so tests are deterministic. */
  now?: () => string;
}
function defaultNowIso(): string { return new Date().toISOString(); }
...
const ctx: CatalogCheckContext = { ..., now: (deps?.now ?? defaultNowIso)() };
```
This isn't a distributed-clock mechanism at all — it's dependency injection
for testability, letting a test pin `detectedAt` to a fixed value instead
of asserting against `Date.now()`. Worth distinguishing from the ordering
question above precisely because both involve "the current time" but solve
completely different problems: one is about coordinating truth across
processes, the other is about making a single process's output
deterministic for a test.

**Leadership — why there's nothing to elect.** A "leader" in distributed
systems exists to answer one question: *when multiple nodes COULD do a
piece of work, which one actually does it, so it isn't done twice or not at
all?* `claimAndRunNext` is exactly the kind of operation that needs a
leader (or an equivalent locking mechanism) the moment more than one node
can run it — and the code's own docstring
(`app/app/services/scan/worker-core.server.ts:22-28`) names this precisely:
*"this is intentionally not an atomic claim-then-lock. With exactly one
worker process consuming the queue, 'find the oldest QUEUED scan' can
never race with another claimer."* There is one worker process, spawned
exactly once by `start-production.js:84-87`
(`worker: spawnChild("worker", process.execPath, ["build/worker.js"])`), so
the "leader" is trivial — it's whichever process exists, because there is
only ever one.

```
  Layers-and-hops — leadership, as it would need to exist at N workers
  (HYPOTHETICAL — none of this exists in the repo today)

  ┌─ worker A ───┐   hop: acquire lease/lock       ┌─ coordination ──┐
  │ tries claim   │ ────────────────────────────► │ (e.g. row-level  │
  └──────────────┘                                 │  SELECT ... FOR  │
  ┌─ worker B ───┐   hop: acquire lease/lock       │  UPDATE, or a     │
  │ tries claim   │ ────────────────────────────► │  distributed lock │
  └──────────────┘                                 │  service)         │
                                                    └──────────────────┘
                          only ONE worker's claim succeeds per scan row
```

The concrete fix, named by the same docstring: an atomic conditional
update — `UPDATE Scan SET status='READING_CATALOG' WHERE id=? AND
status='QUEUED'`, checking the affected-row count — rather than the
current plain `findFirst`. That's a per-row optimistic lock, not a
cluster-wide leader election; it's sufficient here because the coordination
problem is "don't double-claim a row," not "elect one process to own all
scheduling decisions forever," which is a meaningfully lighter-weight
problem than what Raft/etcd/Zookeeper solve.

### Move 3 — the principle

Wall-clock ordering and leader election are both mechanisms for making
*multiple* independent actors agree on "what happened first" and "whose
turn is it." The moment there is genuinely only one actor, both mechanisms
collapse to a no-op — not because the underlying problem was solved, but
because the problem the mechanism exists to solve (disagreement between
multiple parties) can't occur with one party. The risk is treating "it
works with one worker" as evidence the mechanism is unnecessary in general,
rather than recognizing it's unnecessary specifically *because* of the
one-worker constraint, which is exactly the constraint that changes first
if this system ever scales out.

## Primary diagram

```
  Clocks and leadership — today vs. what N workers would need

  ┌─ TODAY ────────────────────────────────┐  ┌─ AT N WORKERS (hypothetical) ─┐
  │ 1 worker process                         │  │ N worker processes              │
  │ ordering: createdAt asc (safe — 1 writer,│  │ ordering: needs a logical clock  │
  │   1 reader of the order)                  │  │   or single sequencer if writes  │
  │ "leader": trivial — the only process is   │  │   ever come from multiple nodes  │
  │   the leader by construction              │  │ claim: needs atomic conditional  │
  │ claim: plain findFirst (safe — no second  │  │   UPDATE or a lease/lock so two   │
  │   claimer can ever race it)               │  │   workers can't double-claim      │
  └─────────────────────────────────────────────┘  └───────────────────────────────────┘
```

## Elaborate

This is the same reasoning behind why a single-threaded Node.js event loop
never needs a mutex — the absence of true concurrency makes the whole class
of coordination bug structurally impossible, not merely unlikely. The
parallel here is at the process level instead of the thread level: one
worker process makes claim-races and clock-skew-driven misordering
structurally impossible, the same way. The moment that invariant changes
(a second worker, a second write path for `Scan.createdAt`), the mechanisms
this file describes as hypothetical become mandatory — see
`06-queues-streams-ordering-and-backpressure.md` for the specific claim
fix, and `05-replication-partitioning-and-quorums.md` for the storage-side
changes that would accompany scaling workers.

## Interview defense

**Q: "Is there a leader-election mechanism in this system?"**
A: No, and there doesn't need to be one — there's exactly one worker
process, spawned once by the deploy supervisor. Leader election exists to
adjudicate between multiple candidates; with one candidate, there's nothing
to adjudicate. The code's own comment names this explicitly as the reason
the queue claim is a plain `findFirst` instead of an atomic conditional
update.
```
  1 worker  →  "leader" is trivial (the only process)
  N workers →  needs atomic claim OR real leader election
```
One-line anchor: *the absence of a mechanism here is a consequence of the
one-worker constraint, not evidence the mechanism is unnecessary in
general.*

**Q: "Would wall-clock ordering here survive adding a second app server
that also writes Scan rows?"**
A: Only if both servers' clocks stayed tightly synchronized, which is never
a safe assumption to build correctness on. The actual fix at that point is
a logical ordering mechanism — a single auto-incrementing sequence, or a
Lamport-style logical clock — rather than trying to synchronize wall clocks
harder. Right now it's safe because there's one writer whose clock nothing
else needs to agree with.
One-line anchor: *never build cross-node ordering guarantees on wall-clock
agreement; that's what logical clocks are for.*

## See also

- `06-queues-streams-ordering-and-backpressure.md` — the specific
  non-atomic claim this file's leadership discussion is about.
- `05-replication-partitioning-and-quorums.md` — the storage-layer changes
  that accompany scaling past one worker/one writer.
- `.aipe/study-runtime-systems/` — the single-threaded-event-loop parallel
  this file's Elaborate section draws on, at the process-execution level.
