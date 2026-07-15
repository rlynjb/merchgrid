# Transactions, isolation, and anomalies

### ACID transaction (industry standard) — Project-specific: `app/app/services/scan/runner.server.ts`, `app/app/services/scan/queue.server.ts`

## Zoom out — the bigger picture

Everything so far has been about a single query. This file is about grouping several writes into one all-or-nothing unit — and about the one place in this codebase where the code explicitly documents a gap between "all-or-nothing" and "actually correct under concurrency."

```
  Zoom out — where transactions sit

  ┌─ Service layer ──────────────────────────────────────────┐
  │  runScan(): delete old findings, insert new ones,           │
  │  mark scan COMPLETED — three separate writes                │
  └───────────────────────────┬──────────────────────────────┘
                              │ prisma.$transaction([...])
  ┌─ Transaction manager ──────▼──────────────────────────────┐
  │  ★ THIS FILE: all three writes commit together, or none ★   │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Storage (WAL/rollback journal, see 07) ───▼───────────────┐
  │  durable write to /data/prod.sqlite                          │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **transaction** is a boundary you draw around multiple writes so the database guarantees either every write inside it takes effect, or none do — no in-between state is ever visible to another reader. That's the "A" (atomicity) in ACID. This codebase has exactly one multi-statement transaction, in `runScan`, and it exists specifically to prevent a half-finished scan from ever being visible. It also has one place where the code deliberately does *not* use a transaction to close a race — and says so in a comment.

## The structure pass

**Axis: which writes in this pipeline are wrapped together, and which are allowed to be visible independently?** Trace it across the scan pipeline's steps — this is where atomicity's boundary is actually drawn, and where it's deliberately not.

```
  One axis — "is this write atomic with its neighbors?" — across the scan pipeline

  status: QUEUED → READING_CATALOG           separate prisma.scan.update() calls,
        → RUNNING_CHECKS → PREPARING_RESULTS  each one its own implicit transaction —
                                                 intermediate states ARE visible to a
                                                 concurrent reader (by design: the UI
                                                 polls status to show progress)
        │
        ▼
  delete old findings + insert new findings    ★ ONE explicit prisma.$transaction ★
  + mark scan COMPLETED                          — all three, or none, ever visible

  seam: status transitions are individually committed (visible progress);
  the FINAL step (findings + COMPLETED) is deliberately one atomic unit
  (no visible half-state).
```

## How it works

### Move 1 — the mental model

You've written a form-submit handler that either saves the whole form or shows every validation error and saves nothing — never half the fields. A database transaction is that same all-or-nothing guarantee, but for multiple SQL statements instead of multiple form fields: either every statement inside the transaction's boundary takes effect, or the database rolls all of them back as if none had run.

```
  Pattern — the transaction boundary in runScan

  BEGIN
    DELETE FROM Finding WHERE scanId = ?         -- clear any stale attempt's rows
    INSERT INTO Finding (...) VALUES (...), ...  -- the fresh set (0..N rows)
    UPDATE Scan SET status='COMPLETED', ...       -- only NOW is it COMPLETED
  COMMIT                        -- all three take effect together, or —
  (on any failure)               -- ROLLBACK — none of them do; scan stays
                                  -- at its prior (non-COMPLETED) status
```

### Move 2 — the walkthrough

**Why the transaction exists at all — the failure mode it closes.** The comment above `runScan` names the exact bug this prevents:

```ts
// app/app/services/scan/runner.server.ts:44-57 (comment)
// Failure-safe: any error during the read/normalize/check/persist
// pipeline is caught, logged server-side with full detail, and recorded
// on the scan as a FAILED status with a generic, non-leaking
// `failureMessageSafe` ... A failure never leaves the scan COMPLETED,
// and never leaves findings from that failed attempt behind (the delete+
// insert+complete step happens atomically, after the pipeline has
// already succeeded end-to-end).
```

Without the transaction: imagine the process crashes (Fly restarts the machine, an unhandled exception, an OOM kill) *between* the `deleteMany` and the `createMany`. A reader polling `getScanFindings` in that window would see a scan with **zero** findings and a status that hasn't yet flipped to `COMPLETED` — or worse, if the crash landed between `createMany` and the `scan.update`, a reader could see the *new* findings attached to a scan that's still stuck at `PREPARING_RESULTS`, contradicting the state machine in `state.ts`. Wrapping all three in one transaction makes that entire window of "partially-written data visible to a reader" not exist.

**The actual code, read statement by statement:**

```ts
// app/app/services/scan/runner.server.ts:182-207
// Delete any findings left over from a previous (failed or retried)
// attempt at this scan, insert the fresh set, and mark the scan
// COMPLETED — all in one transaction, so a crash partway through
// can never leave a scan COMPLETED with stale/duplicate findings, or
// findings persisted without a completed scan to anchor them.
await prisma.$transaction([
  prisma.finding.deleteMany({ where: { scanId } }),          // clear prior attempt's rows
  ...(findingRows.length > 0
    ? [prisma.finding.createMany({ data: findingRows })]     // insert fresh set (skipped if empty — an
    : []),                                                    //   empty createMany would be a no-op anyway,
                                                                //   but Prisma errors on empty data arrays)
  prisma.scan.update({                                        // ONLY NOW does status become COMPLETED
    where: { id: scanId },
    data: { status: "COMPLETED", completedAt: new Date(), /* counts, etc. */ },
  }),
]);
```

The array form of `prisma.$transaction([...])` is Prisma's **sequential batch transaction** — every statement in the array runs inside one `BEGIN`/`COMMIT` against SQLite, in the order given, and if any statement throws, none of the writes persist. This is the right tool here because there's no branching logic *between* the statements (no "read a result, then decide what to insert next") — just a fixed sequence of writes that all need to land together.

**Idempotency is what makes the retry path safe.** The `deleteMany` at the top isn't cosmetic — it's what makes calling `runScan` again after a `FAILED` scan (reset back to `QUEUED` by a caller) safe: any findings a previous, failed attempt already managed to write get wiped before the fresh set is inserted, all inside the same atomic unit as the fresh insert. Re-running never produces duplicate or stale findings sitting alongside the new ones.

**What's deliberately NOT inside the transaction — the failure path.** The `catch` block that handles a thrown error is a *separate* write, outside any transaction:

```ts
// app/app/services/scan/runner.server.ts:208-224
} catch (err) {
  console.error(`[scan:${scanId}] scan run failed`, err);
  await prisma.scan.update({
    where: { id: scanId },
    data: { status: "FAILED", failedAt: new Date(), /* ... */ },
  });
}
```

This is correct, not an oversight: if the pipeline failed, there's nothing else to roll back *with* — this is the only write in the failure path, and it's a single statement, which is already atomic on its own (SQLite guarantees a single `UPDATE` is all-or-nothing without needing an explicit transaction wrapper).

**The anomaly this codebase accepts, in writing.** Not every concurrency hazard here is closed by a transaction. `enqueueScan`'s "is there already an active scan?" check and the `scan.create` that follows it are two *separate* round trips — a classic **check-then-act race** (a TOCTOU: time-of-check to time-of-use):

```ts
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
  throw new ActiveScanError(...);
}
return prisma.scan.create({ ... });
```

```
  Pattern — the anomaly: two concurrent requests, same shop

  Request A: getActiveScan(shopId) → null (no active scan)
                                          Request B: getActiveScan(shopId) → null (also sees none!)
  Request A: scan.create() → QUEUED row #1
                                          Request B: scan.create() → QUEUED row #2
                    ↑ both callers "won" the race — the ActiveScanError
                      NEVER fires for either, because the check ran
                      before EITHER create() committed
```

This is an honest, named anomaly — not a bug nobody noticed. Wrapping the check-and-create in a `$transaction` alone wouldn't even fix it under SQLite's isolation model (Move-2 detail carried into `06`): the real fix named in the comment — a **partial unique index** (`CREATE UNIQUE INDEX ... WHERE status NOT IN ('COMPLETED','FAILED')`) — moves the guarantee out of application logic and into a constraint the storage engine itself enforces, so the *second* `create()` fails outright instead of silently succeeding. That's the general lesson: a check-then-act race in application code is only truly closed by a database-level constraint (unique index, exclusion constraint) or genuine row-level locking — a transaction around the read alone doesn't help if the isolation level lets two transactions both read "no active scan" before either commits.

### Move 3 — the principle

Draw the transaction boundary around exactly the writes that must never be observed half-done — no wider, no narrower. `runScan`'s three-statement transaction is precisely sized: the individual state-machine transitions (`QUEUED`→`READING_CATALOG`, etc.) are *intentionally* separate, uncommitted-together writes, because a concurrent reader polling progress is supposed to see them one at a time. The final findings-plus-completion step is the one place where a half-visible state would be actively wrong, so that's the one wrapped. And where a real race exists that a transaction can't cleanly close (the TOCTOU in `enqueueScan`), the honest move — named in the code itself — is to say so and name the actual fix (a DB-level constraint), rather than papering over it with a transaction that wouldn't have helped anyway.

## Primary diagram

```
  The scan pipeline's transaction boundaries, end to end

  QUEUED ──update──► READING_CATALOG ──update──► RUNNING_CHECKS ──update──► PREPARING_RESULTS
    (each update is its own committed write — visible mid-flight, by design)
                                                                                  │
                                                                    ┌─────────────▼─────────────┐
                                                                    │  $transaction([              │
                                                                    │    deleteMany(old findings),  │
                                                                    │    createMany(new findings),  │
                                                                    │    update(status=COMPLETED)   │
                                                                    │  ])                            │
                                                                    │  ALL-OR-NOTHING                │
                                                                    └─────────────┬─────────────┘
                                                                                  ▼
                                                                              COMPLETED
                                                                  (or, on any error anywhere
                                                                   above: a SEPARATE single
                                                                   UPDATE → FAILED, outside
                                                                   any transaction)

  meanwhile, elsewhere: enqueueScan()'s check-then-create — NOT
  wrapped in a transaction, TOCTOU race explicitly accepted (queue.server.ts:54-62)
```

## Elaborate

This is the same ACID atomicity every relational engine promises — Postgres, MySQL, SQLite all guarantee a transaction's statements commit or roll back together. What differs across engines is what *isolation level* governs what a concurrent transaction sees while the first one is mid-flight, which is exactly where the TOCTOU race above actually lives — covered fully in `06`, because "is this atomic" and "what can another transaction see concurrently" are two different questions that this file and the next one deliberately keep separate.

## Interview defense

**Q: "Why not wrap the entire `runScan` pipeline — reading the catalog, running checks, persisting — in one big transaction?"**
A: Because the read-catalog and run-checks steps involve an external network call (Shopify's GraphQL API) and pure in-memory computation, neither of which are things a database transaction can roll back — there's nothing there for atomicity to protect. The transaction is scoped to exactly the part where "half-committed" would be observably wrong: the findings write plus the final status flip.

**Q: "The code has a known race condition in `enqueueScan` — why wasn't it just fixed?"**
A: Because the actual fix (a partial unique index enforced by the database) is a real schema change, and the comment at `queue.server.ts:54-62` explicitly weighs the cost against the risk: single worker process, serialized-in-practice request pattern, and a duplicate `QUEUED` row being low-impact even if it happens. That's a deliberate, documented tradeoff — not an unnoticed bug — and naming the exact fix in the comment (rather than leaving a vague TODO) is what makes it a good tradeoff call instead of a shortcut.

```
  the honest version of "we know about this"

  comment names:  the race  →  why it's accepted  →  the exact DB-level fix
  NOT:            a bug silently shipped with no path back to closing it
```

## See also

- `06-locks-mvcc-and-concurrency-control.md` — why SQLite's isolation model doesn't close the TOCTOU race even inside a transaction, and what would.
- `07-wal-durability-and-recovery.md` — what "commit" durably means once the transaction returns.
