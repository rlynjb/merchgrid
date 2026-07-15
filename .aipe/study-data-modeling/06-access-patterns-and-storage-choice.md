# Access patterns and storage choice

### Access-pattern fit / storage-engine selection — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the storage choice gets tested

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  results table: many short, paginated reads                 │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ────────────▼─────────────────────────────────┐
  │  one worker process, one scan drained at a time (serial      │
  │  writes); many concurrent read requests from the UI          │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ────────────▼─────────────────────────────────┐
  │  ★ THIS CONCEPT ★ — one SQLite file, one Fly machine, one     │
  │  volume. Does this access shape fit a single-writer engine?  │
  └────────────────────────────────────────────────────────────┘
```

This concept is deliberately narrower than "which database should we use" — that's system-design's question (see the partition note below). Here the question is just: given the schema this repo actually has, does its read/write *shape* fight the storage engine it's running on, or does it fit? A quick note up front on the seam this file respects, then the walkthrough.

**Partition, stated once:** "use SQLite vs Postgres, add a read replica, shard by tenant" is architecture — that's `.aipe/study-system-design/`'s lane. "does this schema's access pattern match the engine it's already running on" is this file's lane. The two questions share a topic (storage) but not an owner.

## Structure pass

**Axis: for each table, is it write-heavy or read-heavy, and does that match how often each is actually touched?**

```
  table          write frequency                read frequency
  ──────────────────────────────────────────────────────────────────
  Shop           once (install), rare after      every request (resolveShopOrThrow)
  ShopSettings   rare (merchant tweaks margin)    once per scan enqueue
  Scan           ~6 writes per scan run           frequent (results polling)
  Finding        one bulk insert per scan         frequent, paginated, filtered
  ScanArtifact   zero (unexercised)                zero (unexercised)
```

The seam: every table in this schema is overwhelmingly read-heavy relative to how often it's written, and the writes that do happen are serialized by construction (one worker, one active scan per shop). That combination — few, serialized writers; many, cheap readers — is exactly the shape a single-writer embedded database is built for. This file's job is to show *why* that's true here, not just assert it.

## How it works

### The engine and its topology

```
// app/fly.toml:1-9 (comment, verbatim)
// Topology: ONE always-on machine running both the Remix web server and
// the catalog-audit background worker (see start-production.js), backed by
// a single SQLite database on a Fly volume mounted at /data. There is
// intentionally no [processes] block — that would let Fly schedule web
// and worker as separate machines, which cannot both mount the same
// volume, and this deploy has exactly one SQLite writer by design.
```

```toml
# app/fly.toml:26-31
[env]
  DATABASE_URL = "file:/data/prod.sqlite"

[mounts]
  source = "data"
  destination = "/data"
```

```prisma
// app/prisma/schema.prisma:11-14
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

One file, one volume, one machine, `min_machines_running = 1` and `auto_stop_machines = false` (`fly.toml`) so the machine — and therefore the one SQLite writer — is never scaled to zero or split. This isn't an incidental deployment detail; it's load-bearing for the schema working at all. SQLite allows exactly one writer transaction at a time (readers can proceed concurrently under WAL mode, writers serialize). If web and worker ran as separate Fly machines — which the `[processes]` block would enable — they couldn't share the same mounted volume, and you'd either need a network-attached database or a replicated SQLite setup (neither of which this app has). The single-machine topology is the thing that makes "SQLite" a coherent choice at all for a two-process app (web + worker).

### Why the write pattern doesn't fight a single-writer engine

```
  Write concurrency, traced through the two writer processes

  ┌─ web process ──────────┐        ┌─ worker process ────────┐
  │ writes:                │        │ writes:                 │
  │  - Shop (install/      │        │  - Scan.status (5x per  │
  │    uninstall, rare)    │        │    run pipeline)         │
  │  - ShopSettings        │        │  - Finding (1 bulk       │
  │    (margin tweak, rare)│        │    insert per scan)      │
  │  - Scan (enqueue, one  │        │                          │
  │    row per click)      │        │  ONE scan drained at a   │
  └────────────────────────┘        │  time (worker-core.      │
                                     │  server.ts:22-28)        │
                                     └──────────────────────────┘
```

The worker's own doc comment states the constraint directly: *"Single-worker model: this is intentionally not an atomic claim-then-lock. With exactly one worker process consuming the queue, 'find the oldest QUEUED scan' can never race with another claimer."* (`app/app/services/scan/worker-core.server.ts:22-25`). That single sentence is doing double duty — it's the reason `claimAndRunNext`'s `findFirst` doesn't need to be an atomic conditional update (see `04-transactions-and-integrity.md`), and it's the reason SQLite's single-writer model never becomes a bottleneck: there is structurally never more than one write transaction in flight from the worker side, because there's only one worker and it processes scans one at a time. The web process's writes (`Shop`, `ShopSettings`, scan-enqueue) are low-frequency, user-triggered, single-row writes that don't contend meaningfully with the worker's batched `Finding` inserts.

### Why the read pattern fits, too

```ts
// app/app/services/scan/scan-api.server.ts:264-270 — the dominant read shape
const total = await prisma.finding.count({ where });
const rows = await prisma.finding.findMany({
  where, orderBy: [...], skip: (page - 1) * pageSize, take: pageSize,
});
```

Every UI-facing read is a small, indexed, paginated query against one scan's findings (bounded by `pageSize`, max 200 per `scan-api.server.ts:28`) — never a full-table scan, never an unbounded result set. SQLite in WAL mode lets readers proceed without blocking on the (rare, serialized) writer, so this read shape — frequent, small, indexed — doesn't need the concurrent-write throughput that would push you toward a client-server database like Postgres. The point isn't "SQLite can technically do this" — it's that the read/write shape this schema actually produces (few serialized writers, many cheap indexed reads) is the shape SQLite is *designed* for, not a shape it's merely tolerating.

### Where this would stop fitting — named honestly

The single-worker, single-machine model is a real constraint, not a hidden one: `enqueueScan`'s documented TOCTOU race (`04-transactions-and-integrity.md`) and `claimAndRunNext`'s unindexed `status='QUEUED'` scan (`03-indexing-vs-query-patterns.md`) both lean on "there is exactly one worker" to stay safe. If this product ever needed to process scans for multiple shops *concurrently* at real volume — not "one worker draining a small queue serially" but genuine parallel scan execution — SQLite's single-writer model would become the actual bottleneck, and that's a system-design question (add a second worker, which needs a real message queue or an atomic claim; move to a client-server database that supports concurrent writers) rather than a data-modeling one. The schema itself wouldn't need to change shape to move to Postgres — the same five tables, the same relations, the same indexes would carry over close to verbatim. What would change is the write-concurrency model underneath it, which is exactly the line this file draws between itself and `study-system-design`.

### Local-first / sync — not applicable to this repo

Some MerchGrid-adjacent products in this portfolio (a hypothetical local-first mobile app) would raise local-first sync concerns — canonical-local-vs-cloud-mirror, offline queues, conflict resolution. None of that applies here: this is a single server-side SQLite file behind a Shopify embedded admin app, with no client-side persistence and no sync boundary at all. Named plainly as **not applicable**, not glossed over.

## Primary diagram

```
  The full access-pattern-to-engine fit, recapped

  ┌─ Write side ────────────────────┐      ┌─ Read side ─────────────────┐
  │ web: rare, single-row writes     │      │ UI: frequent, small,        │
  │ worker: serialized, one scan      │      │ indexed, paginated reads    │
  │   at a time (structural, not      │      │ (never a full table scan)   │
  │   incidental)                     │      │                              │
  └────────────┬─────────────────────┘      └───────────┬──────────────────┘
               │                                          │
               ▼                                          ▼
  ┌─ SQLite: single-writer, multi-reader (WAL) ─────────────────────────────┐
  │  one file, one Fly volume, one always-on machine (fly.toml)             │
  │  → fits BECAUSE the write side is structurally serialized already       │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The general principle: a storage engine choice is validated by the *shape* of the access pattern, not by the total data volume. SQLite is frequently dismissed as "not for production" on the assumption that production means concurrent writers — but this app is production, deployed, live, and SQLite fits it precisely because the write side was deliberately kept to one process, one scan at a time, by design decisions made independently of the storage layer (the worker's single-process model, the one-active-scan-per-shop rule). The lesson that transfers: audit the actual concurrency your writes need *before* assuming a client-server database is required — plenty of real workloads have write patterns closer to this app's than to a high-concurrency SaaS backend, and forcing them onto Postgres/MySQL buys network round-trips and operational overhead for a write-concurrency guarantee nothing in the system actually needs yet.

## Interview defense

**Q: Isn't SQLite a strange choice for a production Shopify app?**
A: Only if the write pattern needed real concurrency. It doesn't: one background worker processes exactly one scan at a time by design (documented in `worker-core.server.ts`), and the web process's writes are rare, single-row, user-triggered events (settings changes, scan enqueues). SQLite's single-writer model isn't a constraint this app works around — it's a constraint the app's own architecture (single worker, one active scan per shop) already satisfies independently.

**Q: What would force a move off SQLite?**
A: Genuine concurrent scan execution — multiple workers processing different shops' scans in parallel at real volume. That would need either a message-queue-backed job system or a client-server database that supports concurrent writers, and it's a system-design change (add a real queue, pick a networked DB), not a schema change — the five tables here would carry over to Postgres close to as-is.

**Q: How does the Fly deployment topology relate to the storage choice?**
A: Directly — `fly.toml` deliberately omits the `[processes]` block that would let Fly run web and worker as separate machines, specifically because separate machines can't share the same mounted SQLite volume. The single-machine, single-volume topology is what makes "one SQLite writer" an actual guarantee rather than an assumption.

## See also

- `03-indexing-vs-query-patterns.md` — the specific query shapes (small, indexed, paginated) that make this read pattern cheap.
- `04-transactions-and-integrity.md` — the single-worker assumption this file leans on is the same assumption behind the "one active scan" race being low-risk.
- `.aipe/study-system-design/` — "which datastore, sharding, replication" lives there; this file only asks whether the current engine fits the current access pattern.
