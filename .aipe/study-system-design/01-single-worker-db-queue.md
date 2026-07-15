# 01 — Single-worker DB-backed queue

**Job queue (the queue table), single-consumer poll loop.** Industry standard pattern — project-specific implementation (no broker, the `Scan` table itself is the queue).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Service layer, process 1: Remix web ───────────────────────┐
│  api.scans.tsx action → enqueueScan()  ── PRODUCER            │
└──────────────────────────┬────────────────────────────────────┘
                            │  INSERT Scan(status=QUEUED)
┌─ Storage layer ───────────▼────────────────────────────────────┐
│  SQLite: Scan table          ★ THIS CONCEPT ★  ← we are here   │
│  (the queue IS this table's `status` column)                   │
└──────────────────────────┬────────────────────────────────────┘
                            │  SELECT ... WHERE status='QUEUED'
┌─ Service layer, process 2: worker ────────────────────────────┐
│  worker.ts poll loop → claimAndRunNext()  ── CONSUMER          │
└─────────────────────────────────────────────────────────────────┘
```

Every "job queue" you've read about — SQS, Celery, Sidekiq — is three parts: a producer that enqueues work, a store that holds it, and a consumer that claims and processes it. This repo skips the broker entirely: the store *is* the `Scan` table, and "enqueue" is just an `INSERT` with `status: "QUEUED"`. It works because there's exactly one consumer, and the code says so explicitly.

## Structure pass

**Axis: control — who decides when work happens?** The producer (`enqueueScan`) decides *that* work exists but not *when* it runs. The consumer decides *when* by polling — it's a pull model, not push. Nobody tells the worker "a scan is ready"; it finds out by asking.

**Seam:** the `Scan.status` column is the load-bearing boundary between producer and consumer. Neither side calls the other directly — `api.scans.tsx` never imports anything from `worker-core.server.ts`, and `worker.ts` never imports anything from the routes. The only channel between them is a row in a shared table. That's the whole contract: *whoever changes the value of `status` owns that state transition.*

```
The seam — control flips from "decide to queue" to "decide when to run"

axis traced = "who decides control flow?"

┌─ producer (web) ─┐   seam: Scan.status   ┌─ consumer (worker) ─┐
│ decides WHETHER  │ ═════════╪═══════════► │ decides WHEN        │
│ to enqueue        │  (it flips)            │ to claim + run       │
└───────────────────┘                        └──────────────────────┘
        ▲                                              ▲
        └──────── same table, two different owners ────┘
```

## How it works

You've built a to-do list with a status field before — `pending` → `in-progress` → `done`. This is that, with one twist: only one "worker" is ever allowed to pick items off the list, so you never have to solve who-owns-which-item.

**The kernel: enqueue + claim-oldest + single-consumer invariant.**

```
Job queue kernel

  enqueue(shopId) ──► INSERT Scan(status=QUEUED)
                                │
                                ▼
                     ┌── queue store ──┐
                     │  Scan rows,      │
                     │  status column   │
                     └────────┬─────────┘
                                │
  claim() ◄──── SELECT oldest WHERE status='QUEUED' ─┘
     │
     ▼
  process → mark COMPLETED/FAILED (see 02 for the pipeline itself)
```

### Enqueue — one active scan per shop

`queue.server.ts:44-78` (`enqueueScan`). The interesting part isn't the `INSERT` — it's the guard in front of it:

```ts
// queue.server.ts:63-68
const active = await getActiveScan(shopId);
if (active) {
  throw new ActiveScanError(
    `Shop ${shopId} already has an active scan (${active.id}, status ${active.status})`,
  );
}
```

`getActiveScan` (`queue.server.ts:28-33`) checks for any row in a non-terminal status (`QUEUED`, `READING_CATALOG`, `RUNNING_CHECKS`, `PREPARING_RESULTS`). If one exists, `enqueueScan` throws `ActiveScanError`, and `api.scans.tsx:19-23` turns that into an HTTP 409 the merchant sees as "a scan is already running." This is a business-rule guard (spec FR-SCAN-002: one active scan per shop), not a concurrency-safety mechanism — and the code names that gap itself:

```ts
// queue.server.ts:54-62
// NOTE (TOCTOU): the "is a scan already active" check and the create below
// are not atomic — under true concurrent requests for the same shop, two
// callers could both pass the check and both create a scan. This is
// acceptable for MVP...
```

**What breaks if you removed this check entirely:** two "start scan" clicks in quick succession would both queue, and the worker would run them back-to-back, wasting a full Shopify catalog read and check pass on the second — not a correctness bug (the second run just re-derives the same findings) but a real resource waste.

### Claim — global oldest-first, no locking

`worker-core.server.ts:30-80` (`claimAndRunNext`). The claim step is a plain `findFirst`, not an atomic conditional update:

```ts
// worker-core.server.ts:34-38
const scan = await prisma.scan.findFirst({
  where: { status: "QUEUED" },
  orderBy: { createdAt: "asc" },
  include: { shop: true },
});
```

This is correct *only* because there is exactly one worker process. The comment directly above it names the invariant this leans on:

```ts
// worker-core.server.ts:22-28
// Single-worker model: this is intentionally not an atomic
// claim-then-lock. With exactly one worker process consuming the queue,
// "find the oldest QUEUED scan" can never race with another claimer. If a
// second worker process is ever introduced, this needs to become an atomic
// conditional update (e.g. `UPDATE Scan SET status='READING_CATALOG' WHERE
// id=? AND status='QUEUED'`, checking the affected-row count)...
```

**What breaks if you removed the single-consumer invariant** (ran two worker processes against this exact code): both would `findFirst` the same oldest `QUEUED` row before either updates its status, both would call `runScan` on it, and you'd get double Shopify reads and a harmless-but-wasteful duplicate run (the second `$transaction` in `02` would just overwrite the first's findings) — or worse, two processes racing to write the same `Scan` row's status columns out of order.

### Poison-pill handling — the claim that must still make progress

The trickiest part of this consumer isn't happy-path claiming — it's what happens when claiming a scan *fails* in a way that would otherwise loop forever:

```ts
// worker-core.server.ts:44-75
let admin: AdminGraphqlClient;
try {
  admin = await adminFactory(scan.shop.shopDomain);
} catch (err) {
  // Poison-pill guard: ... a shop that uninstalled has had its Session row
  // deleted ... while its still-QUEUED scan is retained, so
  // unauthenticated.admin(shopDomain) throws. If we let that propagate,
  // the scan is never advanced out of QUEUED; since we always select the
  // OLDEST QUEUED scan globally, we'd re-select this same broken row on
  // every poll and no other shop's scan could ever run (livelock).
  console.error(/* ... */);
  await prisma.scan.update({
    where: { id: scan.id },
    data: { status: "FAILED", /* ... */ },
  });
  return scan.id;
}
```

**What breaks without this:** because the claim is "oldest `QUEUED` globally," one shop's broken scan (uninstalled mid-queue) would be re-selected on *every single poll iteration forever*, and because it always sorts oldest-first, no other shop's scan could ever get a turn. That's a livelock, and it's the single most subtle failure mode in this whole pipeline — the fix is to make failure-to-claim itself a terminal transition, not just failure-to-run.

### The poll loop itself

`worker.ts:66-92`. Five-second sleep between empty polls, but no sleep at all when a scan was just claimed — `worker.ts:82-86` `continue`s immediately, because there may be more `QUEUED` work waiting:

```ts
// worker.ts:69-89
while (!shuttingDown) {
  let scanId: string | null = null;
  try {
    scanId = await claimAndRunNext(adminFactory);
  } catch (err) {
    console.error("[worker] error while claiming/running a scan", err);
  }
  if (shuttingDown) break;
  if (scanId) continue;          // more work might be waiting — don't sleep
  await sleep(POLL_MS);          // idle — wait 5s before asking again
}
```

`sleep` is itself cancelable (`worker.ts:39-53`) so a `SIGINT`/`SIGTERM` during the idle wait wakes the loop immediately instead of waiting out the full 5 seconds — that's what lets the process exit promptly when Fly asks it to.

## Move 2.5 — current state vs. future state (multi-worker)

```
Phase A (today)                    Phase B (if a 2nd worker is added)
────────────────────                ──────────────────────────────────
findFirst({ QUEUED })               UPDATE Scan SET status='READING_CATALOG'
  → safe: only one claimer            WHERE id=? AND status='QUEUED'
                                       → check affected-row count == 1
enqueueScan's TOCTOU gap             a partial unique index on
  → low-impact: low concurrency,       (shopId) WHERE status non-terminal
    single worker serializes runs      → closes the race at the DB level

  what does NOT have to change: the state machine (state.ts), the
  transaction shape in runScan, the poison-pill handling — all of that
  is claim-count-agnostic.
```

The repo doesn't need Phase B yet — the takeaway is that the *cost* of getting to multi-worker is small and localized: one query, one index. That's a sign the queue boundary was drawn in the right place.

## Move 3 — the principle

A queue's safety property lives entirely in the **claim** step, not the enqueue step. Anyone can safely insert rows concurrently — inserts don't conflict. It's *reading and marking a row as taken* that has to be atomic the moment more than one consumer exists. Naming the invariant your claim depends on (here: "exactly one consumer") is what lets you know exactly which line has to change when that invariant stops holding — and this codebase names it in a comment before it's ever wrong.

## Primary diagram

```
Full recap — the queue boundary end to end

┌─ producer: web ────────┐
│ POST /api/scans         │
│ enqueueScan()            │──INSERT──►┌─ Scan table ──────┐
│ (checked: 1 active/shop) │           │ status: QUEUED     │
└──────────────────────────┘           └─────────┬──────────┘
                                                    │ findFirst, oldest first
┌─ consumer: worker ──────────────────────────────▼──────────┐
│ poll loop (5s idle / immediate on hit)                       │
│  claimAndRunNext()                                           │
│    ├─ adminFactory fails → mark FAILED, return (poison-pill) │
│    └─ adminFactory ok → runScan() (see 02)                   │
└───────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the "poor man's queue" pattern — using the row you already have (here, `Scan`) as the queue, instead of standing up SQS, Redis Streams, or a Postgres-specific job library like `river` or `graphile-worker` (which use `SELECT ... FOR UPDATE SKIP LOCKED` to let multiple consumers claim safely). It's the right call for a low-volume, single-tenant-worker MVP: no new infrastructure, no new failure mode beyond "the SQLite file," and the entire queue is inspectable with a plain `SELECT * FROM Scan WHERE status='QUEUED'`. The tradeoff it accepts up front — no safe path to more than one consumer without a code change — is explicit in the comments, which is exactly how you want a load-bearing assumption documented.

`not yet exercised`: dead-letter handling for a scan that fails repeatedly (retrying is a manual "start a new scan" from the merchant, not automatic), and any form of priority/fairness across shops (strictly oldest-first, global).

## Interview defense

**Q: This queue has no locking. How is that safe?**
A: It's safe because there's exactly one consumer process — the code documents this as the single-worker invariant (`worker-core.server.ts:22-28`). Diagram: draw the seam picture above — control only needs to be atomic when two parties could grab the same row.

```
  ┌ 1 consumer ┐   findFirst is safe (nothing else can race it)
  ┌ 2 consumers┐   findFirst is NOT safe (race on the same row)
```

**Q: How would you scale this to two workers?**
A: Replace the `findFirst` claim with a conditional `UPDATE ... WHERE id=? AND status='QUEUED'`, check the affected-row count — that's an atomic claim-then-lock instead of read-then-trust. The state machine and transaction logic in `runScan` don't need to change at all.

**Q: What's the actual known race in this code today?**
A: `enqueueScan`'s check-then-insert (`queue.server.ts:54-62`) — two concurrent trigger requests for the same shop could both pass the "no active scan" check. Low-impact today because request concurrency per shop is low and there's one worker serializing runs anyway; the real fix is a partial unique index on `shopId` where status is non-terminal.

## See also

- `02-atomic-idempotent-scan-pipeline.md` — what `runScan` does once a scan is claimed.
- `06-single-machine-shared-volume.md` — why there's only one worker process in the first place.
- `audit.md` → lens 2 (request/response flow), lens 7 (scale bottlenecks), lens 8 finding #1 and #2.
