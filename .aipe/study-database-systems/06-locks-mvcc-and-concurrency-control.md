# Locks, MVCC, and concurrency control

### Pessimistic locking vs. MVCC (industry standard) — Project-specific: `journal_mode=delete` (verified), `app/app/services/scan/worker-core.server.ts`

## Zoom out — the bigger picture

`05` showed one transaction that's correctly scoped, and one race the code accepts. This file is about the mechanism *underneath* both of those: what actually happens when two processes touch the database at the same moment, given this repo's verified, default SQLite configuration.

```
  Zoom out — where concurrency control sits

  ┌─ Two OS processes, one file ────────────────────────────┐
  │  web process (PrismaClient)   worker process (PrismaClient)│
  └─────────┬───────────────────────────────┬──────────────┘
            │                                │
  ┌─ Concurrency control ─▼────────────────────▼──────────────┐
  │  ★ THIS FILE: who blocks whom, and for how long ★            │ ← we are here
  │  verified: journal_mode=delete (NOT WAL), no busy_timeout set│
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Storage (02/03) ──────────▼──────────────────────────────┐
  │  the same B-tree pages, contended                             │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**Concurrency control** is how a database keeps two simultaneous operations from corrupting each other or seeing impossible states. There are two broad families: **pessimistic locking** (block the other operation until you're done — what SQLite's default rollback-journal mode does, at the granularity of the *entire database file*) and **MVCC**, multi-version concurrency control (let readers see an older, consistent snapshot while a writer works on a new version — what Postgres does by default, and what SQLite's WAL mode approximates). This repo runs the first kind, verified, and none of the second — worth being exact about, since "SQLite has WAL mode" is true in general but not true of *this app's actual configuration*.

## The structure pass

**Axis: who can proceed while someone else holds a lock?** Trace it from "one writer" (uncontroversial, always true here) to "one writer AND one reader at the same instant" (where the verified journal mode actually bites).

```
  One axis — "who's blocked, and by what granularity of lock?"

  ┌────────────────────────────────────────────┐
  │ SQLite default (rollback journal — VERIFIED  │  writer takes an EXCLUSIVE lock
  │ this repo's mode via PRAGMA journal_mode)      │  on the WHOLE FILE; readers
  │                                                │  already mid-read get SQLITE_BUSY
  │                                                │  if a writer wants the lock
  └────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ SQLite WAL mode (available, NOT enabled here)│  one writer, MANY concurrent
  │                                                │  readers never blocked — but
  │                                                │  this repo does not use it
  └────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────┐
  │ Postgres/MySQL MVCC (industry default,        │  readers see a consistent
  │ not this repo's engine)                       │  SNAPSHOT; writers don't block
  │                                                │  readers, ever, by design
  └────────────────────────────────────────────────┘

  seam: this repo sits at the TOP row — the most restrictive of the three —
  by default, not by deliberate choice (nothing in the repo sets journal_mode).
```

## How it works

### Move 1 — the mental model

You've used a shared Google Doc where someone else's edit locks a paragraph you're trying to type in — that's pessimistic locking, made concrete: whoever gets there first blocks everyone else from that resource until they're done. MVCC is the opposite feel: like `git`, where you keep working on your own branch (your own snapshot of history) while someone else commits to `main`, and you only reconcile when you explicitly merge. SQLite's default mode is the Google Doc; MVCC (Postgres, or SQLite's own WAL mode) is the `git` branch.

### Move 2 — the load-bearing skeleton

**Isolate the kernel: what a lock actually protects, and at what granularity.** SQLite's rollback-journal mode has exactly one lock that matters here: a database-wide exclusive lock a writer holds for the duration of its transaction. There is no row-level lock, no page-level lock for ordinary application code to reason about — "I'm updating one `Scan` row" and "I'm updating every row in `Finding`" cost the exact same lock: the whole file.

```
  Pattern — SQLite rollback-journal locking granularity

  ┌─────────────────────── /data/prod.sqlite (ONE file) ───────────────────────┐
  │                                                                                │
  │   writer's transaction:  EXCLUSIVE lock on THIS ENTIRE FILE                    │
  │   — not just the Scan row it's updating, not just the Finding table —          │
  │     every table, every index, all of it, for the transaction's duration        │
  │                                                                                │
  └────────────────────────────────────────────────────────────────────────────┘

  contrast: Postgres locks the SPECIFIC ROW (or, with MVCC, doesn't
  block a concurrent reader from an old row version at all)
```

**What breaks when you assume row-level locking here.** If you reasoned about this schema the way you'd reason about Postgres — "the worker updating one `Scan` row won't block the web process reading a totally different `Finding` row" — you'd be wrong under this repo's verified configuration. A writer transaction (the worker's `runScan`, mid-`$transaction`) takes the file-wide exclusive lock; a concurrent reader (a merchant's browser polling `getScanFindings` for a *different* scan entirely) can hit `SQLITE_BUSY` — not because of any actual data conflict, but because SQLite's lock doesn't know the difference between "this row" and "any row."

**Verified: this repo runs the most restrictive of SQLite's three modes, and nothing configures otherwise.**

```
PRAGMA journal_mode;
delete     -- the DEFAULT rollback journal. NOT wal, NOT memory, NOT off.
```

Checked against `busy_timeout` and connection-string parameters across the whole repo — `app/prisma/schema.prisma`, `app/app/db.server.ts`, `.env`, `app/fly.toml` — none set one. That matters because SQLite's default behavior when a lock can't be acquired immediately is to **fail fast** (`SQLITE_BUSY`) rather than wait — a `busy_timeout` pragma is what turns "fail immediately" into "wait up to N milliseconds, then fail." With no `busy_timeout` configured, whatever short internal default the Prisma query engine applies is what this app gets; it isn't a value chosen or reasoned about anywhere in this codebase.

**Why this hasn't caused a visible incident.** Two things save this app in practice, both worth naming honestly: (1) writes are genuinely rare and short — a scan's whole findings-write transaction is one batch operation, not a long-running one, so the exclusive-lock window is brief; (2) the web process's reads (`getScanFindings`, `getScanSummary`) are typically for a *different* scan than whatever the worker happens to be writing at that instant, so actual collisions are infrequent even though the *lock* doesn't distinguish "different scan" from "same scan." Low collision frequency is a property of this app's traffic shape today, not a guarantee the locking model provides — it's exactly the kind of thing that changes if scan volume grows.

**The multi-worker case the code itself flags as out of scope.** `claimAndRunNext`'s own comment names precisely what would break if concurrency were ever introduced here on purpose:

```ts
// app/app/services/scan/worker-core.server.ts:22-28
// Single-worker model: this is intentionally not an atomic
// claim-then-lock. With exactly one worker process consuming the queue,
// "find the oldest QUEUED scan" can never race with another claimer. If a
// second worker process is ever introduced, this needs to become an atomic
// conditional update (e.g. `UPDATE Scan SET status='READING_CATALOG' WHERE
// id=? AND status='QUEUED'`, checking the affected-row count) rather than a
// plain findFirst, to avoid two workers claiming the same scan.
```

This is the correct engineering instinct even without row-level locking or MVCC: a **conditional update with an affected-row check** (`UPDATE ... WHERE id=? AND status='QUEUED'`, then look at how many rows changed) is how you build an atomic claim on top of a database that gives you whole-file locking, not row-level locking — the `WHERE status='QUEUED'` clause makes the update a no-op (0 rows affected) if another process already claimed it first, and SQLite's single-statement atomicity guarantees the check-and-set happens as one unit even without an explicit surrounding transaction. This is the same trick a Postgres app uses to build a job queue without `SELECT ... FOR UPDATE SKIP LOCKED` — a conditional `UPDATE`'s atomicity substitutes for genuine row locking.

```
  Pattern — the claim-with-conditional-update trick (not yet needed, but named correctly)

  UPDATE Scan SET status='READING_CATALOG'
  WHERE id = ? AND status = 'QUEUED';

  -- if 1 row affected: THIS caller won the claim
  -- if 0 rows affected: someone else already claimed it — try the next scan

  this works with ZERO row-level locking, because the UPDATE statement
  itself is atomic — SQLite guarantees the WHERE check and the SET
  happen as one indivisible operation, single-writer-at-a-time anyway
```

### Move 2.5 — current state vs. what a second worker would require

```
  Comparison — today (one worker) vs. a hypothetical second worker

  TODAY (verified: single worker process)        IF A SECOND WORKER WERE ADDED
  ┌────────────────────────────────┐             ┌────────────────────────────────┐
  │ findFirst({status:'QUEUED'})     │             │ MUST become:                     │
  │ → safe: only one caller EVER      │             │ UPDATE ... WHERE status='QUEUED' │
  │   runs this query                 │             │ check affected-row count = 1      │
  └────────────────────────────────┘             └────────────────────────────────┘
   fly.toml's single-machine, no-      would ALSO require: no [processes] block
   [processes]-block design is what     stays true (both workers still need the
   keeps this true today                same volume) — but the query itself
                                          must change from findFirst to a
                                          conditional UPDATE
```

The takeaway: what *doesn't* have to change is the storage layer, the schema, or the transaction in `05` — only the one query in `worker-core.server.ts` would need to become a conditional update. That's a narrow, well-understood blast radius, already scoped out loud in the code comment.

### Move 3 — the principle

Pessimistic locking and MVCC are two different answers to "what does a reader see while a writer is mid-transaction," and the answer isn't free either way — pessimistic locking pays in blocked callers, MVCC pays in keeping multiple row versions around and vacuuming them later. What makes this repo's situation worth naming precisely is that it isn't *choosing* the pessimistic side of that tradeoff deliberately — it's getting SQLite's default, unconfigured, because nobody has needed to reach for WAL mode yet. That's a fine place to be at this app's scale; it stops being fine the exact moment concurrent write pressure grows, and the fix (WAL mode, `07`) is a one-line `PRAGMA` away, not a schema rewrite.

## Primary diagram

```
  Locking, this repo, verified end to end

  ┌─ web process ──────┐        ┌─ worker process ──────┐
  │ read: getScanFindings│        │ write: runScan's        │
  │ (SELECT, any lock     │        │ $transaction (INSERT/    │
  │  level suffices)      │        │  UPDATE, needs EXCLUSIVE)│
  └──────────┬───────────┘        └───────────┬───────────┘
             │ both hit the SAME file, journal_mode=delete    │
             └───────────────────┬──────────────────────────┘
                                 ▼
                    /data/prod.sqlite — ONE exclusive
                    lock for the WHOLE FILE during any write;
                    no busy_timeout configured (fail-fast default)

  NOT YET EXERCISED: MVCC (readers-never-block-writers), row-level
  locking, multi-writer coordination — SQLite's WAL mode would give
  the first one; genuine MVCC (Postgres-style) isn't SQLite at all.
```

## Elaborate

MVCC exists because pessimistic, whole-resource locking doesn't scale to high read/write concurrency — Postgres keeps multiple versions of a row so a long-running read never blocks a writer and vice versa, at the cost of periodic `VACUUM` to reclaim old versions. SQLite's WAL mode is a narrower version of the same idea: writers append to a separate write-ahead log instead of locking the main file, so readers keep reading the old, consistent main-file state undisturbed — one writer, many non-blocked readers, but still not full MVCC (only one writer at a time, ever, even under WAL). This repo runs neither WAL nor full MVCC; it runs SQLite's original, simplest mode, which is the correct honest baseline to teach from — not "SQLite has WAL so it's fine," but "this specific file's `journal_mode` is `delete`, verified, and here's exactly what that costs."

## Interview defense

**Q: "Does this app have row-level locking?"**
A: No — SQLite doesn't have row-level locks at all in rollback-journal mode (the mode this repo verifiably runs); the lock is file-wide. A write transaction touching one `Scan` row blocks a concurrent read of an unrelated `Finding` row, because the lock doesn't distinguish between them.

**Q: "If you added a second worker process tomorrow, what specifically would you have to change?"**
A: Exactly one query — `claimAndRunNext`'s `findFirst({status:'QUEUED'})` (`worker-core.server.ts:34-38`) would need to become a conditional `UPDATE ... WHERE id=? AND status='QUEUED'` with an affected-row check, per the comment already in that file. Nothing else in the schema, the transaction in `05`, or the storage layer would need to change — the blast radius is one query, already scoped in writing.

```
  the one thing that changes if a second worker appears

  findFirst({status:'QUEUED'})  →  UPDATE ... WHERE status='QUEUED'; check rowCount
       (unsafe with 2 workers)         (safe with any number of workers)
```

**Q: "What's MVCC, and does SQLite have it?"**
A: MVCC lets a reader see a consistent snapshot of the data without blocking a concurrent writer, by keeping multiple versions of each row around. SQLite's default rollback-journal mode does not have this — it's pessimistic, whole-file locking. SQLite's WAL mode gets partway there (readers don't block on writers), but this repo doesn't use WAL either (verified `journal_mode=delete`); true MVCC belongs to engines like Postgres, `not yet exercised` in this codebase at all.

## See also

- `05-transactions-isolation-and-anomalies.md` — the TOCTOU race this file's locking model doesn't close on its own.
- `07-wal-durability-and-recovery.md` — what enabling WAL mode would change, and why this repo hasn't.
- `08-replication-and-read-consistency.md` — the concurrency questions that only exist once there's more than one node.
