# Distributed Systems — MerchGrid: Catalog Audit

## What this guide is about

MerchGrid: Catalog Audit is not a "distributed system" in the multi-region,
multi-replica sense. It's what most working engineers actually build: **one
process talking to another process through a database, plus one external API
that can fail on its own schedule.** That's still a coordination problem —
the web process and the worker process don't share memory, don't share a
clock, and can't see each other's in-flight work except through what's
written to SQLite. The question this guide asks of every mechanism is the
same one you'd ask at 50 services and 12 regions: **what stays correct when
one participant is slow, duplicated, stale, or gone?**

This repo answers that question at small scale, which is exactly what makes
it a good place to learn the primitives before you meet them at 100x the
size. The queue is a database table. The "network" between producer and
consumer is a polling loop. The "distributed transaction" is a Prisma
`$transaction` against a single SQLite file. None of that is a toy — it's
the same shape you'll reach for with Postgres + SQS + a fleet of Lambda
workers, just with the concurrency dialed down to exactly one worker, so
you can see each mechanism without race-condition noise clouding it.

## The map — nodes, boundary, and what crosses it

```
  MerchGrid coordination map — three participants, one shared store

  ┌─ Node: Remix web process ────────────┐
  │  routes/app._index.tsx (onboarding)   │
  │  enqueueScan()  ◄── HTTP request      │
  │  routes/app.scans.$id.tsx (polling)   │
  └───────────────┬───────────────────────┘
                  │ writes/reads Scan, ShopSettings rows
                  ▼
  ┌─ Shared store: SQLite (one file, one Fly volume) ─┐
  │  Shop · ShopSettings · Scan · Finding · Session    │ ← the only channel
  └───────────────┬────────────────────────────────────┘   web ⇄ worker use
                  │ polls for QUEUED rows (every 5s)
                  ▼
  ┌─ Node: worker process (worker.ts) ───────────────┐
  │  claimAndRunNext() → runScan()                    │
  │  reads/writes Scan.status, Finding rows            │
  └───────────────┬───────────────────────────────────┘
                  │ GraphQL (HTTPS) — the one real network hop
                  ▼
  ┌─ External system: Shopify Admin API ─────────────┐
  │  read_products / read_inventory (rate-limited)     │
  └────────────────────────────────────────────────────┘
```

Both Node processes run on **one Fly machine** (`app/fly.toml:1-8`,
`app/start-production.js:1-31`) — deliberately, because they share one
SQLite file on one volume and SQLite has exactly one writer. That single
fact is the reason several mechanisms below are simpler than the textbook
version: there's no second worker to race against, no replica to lag behind,
no leader to elect. The guide is honest about that everywhere it applies —
see `05-replication-partitioning-and-quorums.md` and
`07-clocks-coordination-and-leadership.md` in particular.

## Reading order

1. `01-distributed-system-map.md` — the participants, the boundary, the
   failure domain (what dies together).
2. `02-partial-failure-timeouts-and-retries.md` — how `catalog-reader.server.ts`
   survives Shopify's rate limiter and transient network failure.
3. `03-idempotency-deduplication-and-delivery-semantics.md` — how `runScan`
   and the uninstall/GDPR webhooks tolerate being called twice.
4. `04-consistency-models-and-staleness.md` — the snapshot-at-enqueue-time
   pattern that keeps a running scan internally consistent.
5. `05-replication-partitioning-and-quorums.md` — **not yet exercised**;
   what would have to exist at 2+ workers or 2+ SQLite writers.
6. `06-queues-streams-ordering-and-backpressure.md` — the DB-backed queue,
   FIFO ordering, one-active-scan-per-shop backpressure, poison-pill handling.
7. `07-clocks-coordination-and-leadership.md` — wall-clock ordering, the
   trivial single-worker "leader," and what leader election would need to add.
8. `08-sagas-outbox-and-cross-boundary-workflows.md` — the scan pipeline as a
   compensating state machine crossing the Shopify boundary.
9. `09-distributed-systems-red-flags-audit.md` — every risk ranked by
   consequence, each grounded in a specific file and line range.

## Ranked findings (detail in `09-distributed-systems-red-flags-audit.md`)

1. **TOCTOU race in `enqueueScan`** (`app/app/services/scan/queue.server.ts:54-68`)
   — documented in the code itself, accepted for MVP because a single
   worker and per-session request serialization make it low-probability.
2. **Non-atomic queue claim in `claimAndRunNext`** (`app/app/services/scan/worker-core.server.ts:22-42`)
   — correct today only because there is exactly one worker process; this
   is the single biggest one-way door if a second worker is ever added.
3. **Poison-pill handling is real and load-bearing**
   (`app/app/services/scan/worker-core.server.ts:44-75`) — a shop that
   uninstalled mid-queue can no longer produce an Admin client; without the
   FAILED short-circuit here the worker would livelock on the same broken
   row forever.
4. **Single point of failure by design** (`app/fly.toml:1-8`,
   `app/start-production.js:1-31`) — one Fly machine, one SQLite volume; a
   deliberate tradeoff (simplicity, one writer, no split-brain) accepted
   over availability.

## Honest gaps — `not yet exercised`

- **Consensus / leader election** — one worker process; no lease, no lock,
  no election protocol exists or is needed yet.
- **Replication and replica lag** — one SQLite file, one writer; nothing in
  this repo reads from a stale replica.
- **Partitioning / sharding and quorum reads/writes** — no sharded data,
  no quorum concept anywhere in the stack.
- **Multi-region** — one Fly region (`primary_region = "iad"`,
  `app/fly.toml:16`), no cross-region traffic routing or data placement.

Each of these gets its own honest section in the relevant concept file
rather than being glossed over — the goal is to teach what the mechanism
would look like at N workers, not to pretend it's already there.
