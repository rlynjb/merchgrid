# Queues, Ordering, and Backpressure

Job queue / poison message handling / dead-lettering — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the queue sits

  ┌─ Service layer ────────────────────────────────────────────┐
  │  enqueueScan()  →  ★ THE QUEUE ★  →  claimAndRunNext()      │ ← we are here
  └───────────────────────┬────────────────────────────────────────┘
                          │ FIFO by createdAt, one active scan per shop
  ┌─ Storage layer ───────▼────────────────────────────────────────┐
  │  Scan rows, status column IS the queue state                   │
  └────────────────────────────────────────────────────────────────────┘
```

There's no Kafka, no SQS, no Redis Streams here — the queue is a Prisma
model with a `status` column, and "dequeue" is a `findFirst` ordered by
`createdAt`. That's a completely legitimate way to build a queue, and it
comes with the exact same concerns a message-broker queue has: ordering
guarantees, one-at-a-time-per-key semantics, overload protection, and what
happens when one message can never be processed successfully (a poison
message). This file walks all four, each grounded in actual code.

## Structure pass — layers, axis, seams

**Layers:** producer (`enqueueScan`, called from the onboarding route) →
the queue itself (`Scan` rows with `status`) → consumer
(`claimAndRunNext`, polled by `worker.ts`).

**The axis: control — who decides a scan can be enqueued, and who decides
it gets claimed?**

```
  Control axis across the queue

  producer side  →  enqueueScan decides: is there ALREADY an active scan
                     for this shop? (one-active-per-shop backpressure)
  consumer side  →  claimAndRunNext decides: which QUEUED scan is OLDEST
                     across ALL shops? (global FIFO, not per-shop)
```

**The seam: the queue enforces per-shop backpressure on the way in, but
FIFO ordering on the way out is global, not per-shop.** That's worth
noticing precisely because it's asymmetric — you can't have two scans
in flight for the same shop, but shop A's scan and shop B's scan compete on
equal footing for the worker's single thread of execution, oldest first,
regardless of shop.

## How it works

### Move 1 — the mental model

You've built a form that disables its submit button while a request is
in flight, so a double-click can't fire the mutation twice. `enqueueScan`'s
one-active-per-shop check is the exact same idea at the row level: don't
let a second `QUEUED` row exist for a shop that already has one in flight.
And the poison-message handling below is the same instinct as an error
boundary — one broken child shouldn't take down the whole tree; one broken
scan shouldn't take down the whole queue.

```
  Pattern: FIFO queue with per-key backpressure + poison-pill isolation

  enqueue(key):
    if ACTIVE row exists for key: reject               // backpressure
    else: insert row, status=QUEUED

  dequeue():
    row = oldest QUEUED row, across ALL keys           // global FIFO
    if row is None: return None
    try: process(row)
    except UnrecoverableSetupError:
      mark row FAILED, return row.id                   // poison-pill guard —
                                                         // consumes it so the
                                                         // NEXT dequeue moves on
```

### Move 2 — four mechanisms, one at a time

**Backpressure — one active scan per shop**
(`app/app/services/scan/queue.server.ts:14-19,44-68`):

```ts
const ACTIVE_STATUSES = ["QUEUED", "READING_CATALOG", "RUNNING_CHECKS", "PREPARING_RESULTS"] as const;

export async function enqueueScan(shopId: string): Promise<Scan> {
  ...
  const active = await getActiveScan(shopId);
  if (active) {
    throw new ActiveScanError(`Shop ${shopId} already has an active scan (${active.id}, status ${active.status})`);
  }
  return prisma.scan.create({ data: { shopId, status: "QUEUED", ... } });
}
```
This is admission control, not rate limiting — the queue doesn't cap total
throughput, it caps *concurrency per key* to exactly one. A merchant
mashing "scan" can't queue five scans; the fifth attempt throws
`ActiveScanError` and the caller (the onboarding action route) is expected
to surface a friendly "a scan is already running" message.

**The TOCTOU gap, named honestly**
(`app/app/services/scan/queue.server.ts:54-62`): the check-then-create
sequence above is two separate database round-trips, not one atomic
operation. The code's own comment states the race directly: *"under true
concurrent requests for the same shop, two callers could both pass the
check and both create a scan."* This is a real, load-bearing thing to
understand about the code as it exists today — it's accepted, not fixed,
because the per-merchant HTTP session in practice serializes these calls
and there's exactly one worker draining the result either way, so a
duplicate `QUEUED` row is low-probability and low-impact rather than a
correctness hazard. The fix the comment names for real concurrency: a
partial unique index at the DB level (one row per `shopId` where status is
non-terminal) — enforcement moved from application logic into a
constraint the database itself guarantees, which closes a TOCTOU gap the
way check-then-act never can.

**FIFO ordering — global, not per-shop**
(`app/app/services/scan/worker-core.server.ts:34-38`):

```ts
const scan = await prisma.scan.findFirst({
  where: { status: "QUEUED" },
  orderBy: { createdAt: "asc" },
  include: { shop: true },
});
```
`orderBy: createdAt asc` is the entire ordering guarantee — oldest queued
scan across every shop goes first. There's no shop-fairness mechanism (no
round-robin across shops, no per-shop lane) — if shop A enqueues 10 scans
in a burst, the current design already prevents that (one-active-per-shop
means shop A can only ever have one `QUEUED` row at a time), so in practice
this degenerates to simple oldest-first fairness across shops, which is the
right behavior for this product's actual traffic shape.

**Poison-message handling — the part most queues get wrong**
(`app/app/services/scan/worker-core.server.ts:44-75`), walked as a
load-bearing skeleton:

*Isolate the kernel:* claim the oldest `QUEUED` row → try to build an Admin
client for it → if that setup step itself fails (not the scan pipeline —
the *precondition* for running it at all), mark the row `FAILED` and return
its id as "processed," rather than letting the exception propagate.

*Name what breaks if this is missing.* The comment on lines 48-55 spells
out the exact failure mode this guards against: a shop uninstalls, its
`Session` row is deleted by the uninstall webhook, but its still-`QUEUED`
scan is retained (scans are retained for the GDPR window, sessions aren't).
`unauthenticated.admin(shopDomain)` then throws for that shop, every single
time. Because `claimAndRunNext` always selects the *globally oldest*
`QUEUED` row, if that error simply propagated up to the worker's main loop,
the exact same broken row would be re-selected on every 5-second poll
forever — a livelock where one uninstalled shop's leftover scan permanently
blocks every other shop's queue, since nothing ever advances past it.

```ts
} catch (err) {
  console.error(`[worker-core] admin factory failed for scan ${scan.id} ...`, err);
  await prisma.scan.update({
    where: { id: scan.id },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "ADMIN_UNAVAILABLE",
      failureMessageSafe: "The scan could not be completed. Please try again.",
    },
  });
  return scan.id;   // ← treated as "processed"; worker moves to the next scan
}
```

*Separate skeleton from hardening.* The kernel here is exactly "mark
FAILED and return, don't propagate." What's absent — and would be
hardening on top, not required for correctness — is a genuine dead-letter
queue (a separate table/status for scans that failed at the *admin-factory*
step specifically, distinguishable from scans that failed *during* the
pipeline) or a retry-with-backoff before giving up on the admin factory
itself. Neither exists; the current behavior fails fast on the first
attempt, which is the right tradeoff here because the failure mode (shop
uninstalled) isn't transient — retrying it can never succeed.

```
  Layers-and-hops — the poison-pill save, end to end

  ┌─ worker.ts poll loop ─┐  hop: claimAndRunNext()  ┌─ worker-core ─────┐
  │ while(!shuttingDown)   │ ───────────────────────► │ findFirst QUEUED  │
  └───────────┬───────────┘                          └─────────┬──────────┘
              │                          hop: adminFactory(shopDomain)
              │                                                 ▼
              │                                   ┌─ Session lookup (deleted) ┐
              │                                   │  THROWS — shop uninstalled │
              │                                   └─────────┬───────────────────┘
              │                          hop: mark Scan FAILED, return id
              │◄─────────────────────────────────────────────┘
              │  scanId returned → loop continues IMMEDIATELY (no sleep)
              ▼
        next poll: this row is FAILED (terminal) — never selected again
```

**Overload protection at the individual-scan level**
(`app/app/services/shopify/catalog-reader.server.ts:23-26,381-389`): the
`variantLimit` guardrail (default 5000, per `ShopSettings.catalogVariantLimit`
in `app/prisma/schema.prisma:54`) is a soft cap checked at variant
granularity mid-pagination, not a queue-level throughput limit — it bounds
how much work *one* scan can do, marking the resulting catalog `partial:
true` rather than letting a pathologically large catalog run unbounded
calls or memory. It's overload protection for the consumer's own resource
budget, distinct from the queue's admission control above.

### Move 3 — the principle

A hand-rolled DB-backed queue needs the same four properties as a "real"
message broker: bounded admission (backpressure), a defined ordering
guarantee (FIFO here, explicitly global not per-key), a way to stop one bad
message from blocking every other message (poison-pill isolation), and a
cap on per-unit-of-work resource consumption (the variant limit). Building
it on a database table doesn't exempt you from any of the four — it just
means you write the guarantee in application code (or a DB constraint)
instead of getting it from broker configuration.

## Primary diagram

```
  The queue, full lifecycle

  enqueueScan(shopId)
    │  check: active scan for shopId? ──yes──► throw ActiveScanError
    │  no
    ▼
  Scan{status: QUEUED, createdAt: now}  ← TOCTOU gap here (documented,
    │                                       accepted for single-worker MVP)
    │
    │  worker.ts polls every 5s
    ▼
  claimAndRunNext()
    │  findFirst({status: QUEUED}, orderBy: createdAt asc)  ← global FIFO
    │
    ├─ adminFactory() throws ──► mark FAILED (poison-pill guard) ──► return id
    │                                                    (worker moves on)
    └─ adminFactory() succeeds ──► runScan()  ──► COMPLETED or FAILED
```

## Elaborate

This is the exact shape of a "visibility timeout + dead-letter queue" in
SQS, minus the visibility timeout — because there's exactly one consumer,
there's no risk of a second consumer picking up the same message while the
first is mid-processing, which is the problem visibility timeouts solve.
The moment a second worker is introduced (see
`05-replication-partitioning-and-quorums.md`'s note on the atomic-claim
gap), this queue would need that same protection: an atomic
claim-and-lock so two workers can't both grab the same `QUEUED` row, and
likely a proper dead-letter status distinct from generic `FAILED` so
poison messages are queryable separately from legitimate pipeline failures.

## Interview defense

**Q: "Walk me through what stops one broken scan from blocking every other
shop's queue forever."**
A: The admin-factory call is wrapped in its own try/catch inside
`claimAndRunNext`, separate from `runScan`'s own error handling. If
building the Shopify client throws (e.g. the shop uninstalled and its
session was deleted), the scan is marked `FAILED` right there and its id is
returned as "processed" — so the worker's next poll selects the *next*
oldest `QUEUED` row instead of re-selecting the same broken one.
```
  same broken row selected every poll  ──►  livelock (without the guard)
  broken row marked FAILED, consumed   ──►  queue advances (with the guard)
```
One-line anchor: *a setup failure has to be caught separately from a
pipeline failure, or "oldest first" turns into "same one forever."*

**Q: "Is the one-active-per-shop check actually race-free?"**
A: No, and the code says so directly — it's a check-then-create across two
DB round-trips, not one atomic operation, so two truly concurrent requests
for the same shop could both pass the check. It's accepted for this repo's
traffic shape (single worker, per-session request serialization in
practice) rather than fixed; the real fix would be a partial unique index
enforced at the database level instead of an application-level check.
```
  check(no active) → create      [not atomic]
  check(no active) → create      [could interleave here]
```
One-line anchor: *check-then-act across two round-trips is a TOCTOU gap by
definition — closing it needs a DB constraint, not a smarter check.*

## See also

- `01-distributed-system-map.md` — the shared-row channel this queue is
  built on top of.
- `02-partial-failure-timeouts-and-retries.md` — how the pipeline itself
  handles failures once a scan is successfully claimed.
- `09-distributed-systems-red-flags-audit.md` — the TOCTOU gap and the
  non-atomic claim, ranked against every other risk in the repo.
