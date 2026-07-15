# Replication, Partitioning, and Quorums

Data replication / sharding / quorum reads-writes — Industry standard —
**not yet exercised in this repo**

## Zoom out, then zoom in

```
  Zoom out — where this WOULD sit, if it existed

  ┌─ Storage layer (as it actually is) ────────────────────────┐
  │  ONE SQLite file, ONE Fly volume, ONE writer                │
  │  ★ NO REPLICATION, NO PARTITIONING, NO QUORUM HERE ★         │ ← we are here
  └────────────────────────────────────────────────────────────────┘

  ┌─ Storage layer (what N-region scale would add) ─────────────┐
  │  primary ──replicate──► replica A, replica B, ...            │
  │  writes need a quorum; reads may be stale by design           │
  └────────────────────────────────────────────────────────────────┘
```

This is the most important **not yet exercised** section in the guide, and
it's worth being precise about *why* rather than treating it as a gap to
apologize for. `app/fly.toml:1-8` states the topology outright: one Fly
machine, one SQLite file on one volume, by design — the comment literally
says "this deploy has exactly one SQLite writer by design." There is no
replica anywhere in this stack, no sharded table, no quorum read or write.
That's not an oversight; it's the correct choice for this product's actual
load (a merchant runs an on-demand catalog scan, not a stream of
continuous writes), and standing up replication infrastructure before you
need it is pure cost with no corresponding benefit. But you should be able
to reason about what changes the day this product outgrows that choice —
that's what this file teaches.

## Structure pass — layers, axis, seams

**Layers, as they'd exist at scale:** client → load balancer → N
application replicas → a primary datastore → M read replicas / shards.

**The axis: guarantees — is a read promised fresh, or allowed to be stale?**

```
  Guarantees axis, single-writer (today) vs. replicated (hypothetical)

  today:      every read hits the ONE SQLite file  → always fresh, always
                                                       consistent, zero lag
  replicated: reads MAY hit a replica               → fresh OR stale,
                                                       caller must choose
```

**The seam that doesn't exist yet, and where it would go:** in a replicated
version of this app, the seam would sit between "the write path" (worker
writing `Scan`/`Finding` rows) and "the read path" (web process polling for
scan progress). Today both paths hit the same file, so there's no seam to
study. The moment you add a read replica, that seam becomes load-bearing:
a merchant polling `app.scans.$id.tsx` immediately after their scan
completes could hit a replica that hasn't caught up yet and see a stale
`RUNNING_CHECKS` status for a scan that's actually `COMPLETED`.

## How it works

### Move 1 — the mental model, built from what IS here

You've built a `useState` that only ever has one true value — no cache, no
copy that can drift. That's this repo's entire storage model today: one
SQLite file is the single source of truth, and every reader (web process,
worker process) reads that exact same file. There is no "primary vs.
replica" distinction to reason about because there's exactly one copy of
the data, period.

```
  Pattern: single-writer, single-copy (what this repo has)

  ┌──────────┐  write   ┌──────────────┐  read   ┌──────────┐
  │ worker   │ ───────► │ SQLite file  │ ◄─────── │ web proc │
  └──────────┘          │ (ONE copy)   │          └──────────┘
                        └──────────────┘
  no lag, no quorum, no stale replica — there's nothing to be behind
```

### Move 2 — what would have to be added, and what breaks without each part

This section teaches the mechanisms as **what you'd need to introduce, not
what exists** — every part below is a hypothetical addition, named
precisely so it's not confused with current behavior.

**If you added read replicas** (e.g. moved off SQLite to Postgres with
streaming replication, or Litestream-style read replicas of the SQLite
file): a replica trails the primary by some replication lag — milliseconds
normally, seconds or more under load or network partition. **What breaks
without a read-your-writes guarantee:** a merchant who just triggered a scan
and is immediately redirected to `app.scans.$id.tsx` could poll a replica
that hasn't yet received the `QUEUED` row the primary just committed,
and see a 404 or an empty state for a scan that unambiguously exists. The
fix is routing "read immediately after my own write" back to the primary
(or a replica proven caught up) for some short window — a specific,
well-known pattern (read-your-writes consistency, sometimes via
session-sticky routing or a monotonic-read token), not something you get
for free by adding replicas.

**If you sharded `Scan`/`Finding` by shop** (necessary once merchant count
outgrows one SQLite file's write throughput): you'd partition by
`shopId` — a natural choice, since every query in `scan-api.server.ts` is
already shop-scoped (`getScanFindings`, `getAllFindingsForExport`). **What
breaks without a fixed partition key:** cross-shop queries (an internal
admin dashboard totaling findings across all merchants, say) would have to
fan out to every shard and merge results instead of hitting one shard — a
real cost that has to be designed for up front, not discovered after
sharding.

**If you needed a write quorum** (multiple Postgres nodes instead of one
SQLite writer): a write would need acknowledgment from a majority of nodes
before being considered durable, trading write latency for tolerance of a
single node failure. **What breaks without a quorum, single-writer-with-
failover instead:** if the one writer dies, you either lose the most recent
unacknowledged writes (async replication, fast failover) or block writes
entirely until a new primary is elected (sync replication, safer but
slower) — there's no free lunch, and choosing between them is the actual
system-design decision a quorum forces you to make explicitly.

```
  Layers-and-hops — a HYPOTHETICAL sharded+replicated version, for contrast

  ┌─ client ─────┐  hop 1: HTTP        ┌─ app tier (N replicas) ─┐
  │ merchant     │ ──────────────────► │ stateless, any instance  │
  └──────────────┘                     └───────────┬───────────────┘
                                          hop 2: route by shopId
                                                    ▼
                          ┌─ shard router ──────────────────────┐
                          │ shopId → shard N                     │
                          └───────────┬──────────────┬────────────┘
                             hop 3a │           hop 3b │
                                    ▼                  ▼
                          ┌─ shard 1 (primary) ┐  ┌─ shard 2 (primary) ┐
                          │  + replica(s)       │  │  + replica(s)       │
                          └──────────────────────┘  └──────────────────────┘
                          NONE OF THIS EXISTS TODAY — this repo has exactly
                          one SQLite file with no shard router and no replicas
```

### Move 3 — the principle

Replication and partitioning aren't things you add because "distributed
systems have them" — they're things you add when a specific, named
constraint (write throughput, availability under node failure, geographic
latency) actually bites. The discipline worth carrying forward is knowing
*which* constraint would force the change and *which* new consistency
question it introduces (staleness, quorum latency, cross-shard queries) —
so that if this product's Fly machine ever genuinely can't keep up, the
first question is "which constraint is this?" rather than "let's add
Postgres and call it done."

## Primary diagram

```
  Today vs. what N-worker/N-region growth would require

  ┌─ TODAY ────────────────────────────┐  ┌─ HYPOTHETICAL, if outgrown ─────┐
  │  1 Fly machine                       │  │  N app replicas                  │
  │  1 SQLite file, 1 writer             │  │  sharded-by-shopId datastore      │
  │  0 replicas, 0 shards, 0 quorum      │  │  read replicas + read-your-writes │
  │  primary_region = "iad" only         │  │  routing, write quorum, possibly  │
  │  (app/fly.toml:16)                   │  │  multi-region placement           │
  └───────────────────────────────────────┘  └────────────────────────────────────┘
```

## Elaborate

The honest reason this repo hasn't needed any of this: the product is an
on-demand catalog audit triggered by a human clicking a button, not a
high-throughput event pipeline. `app/.aipe/project/context.md`'s deploy
notes ("Litestream backups intentionally skipped — data is regenerable")
reinforce the same philosophy — durability and availability investments are
sized to the actual failure cost (a lost scan can just be re-run against
Shopify, the source of truth for the catalog itself) rather than to a
theoretical worst case. If this product added a second, geographically
distant customer base with a hard latency SLA, or a write volume that
saturated one SQLite writer, that's the trigger to revisit this file for
real — and at that point, the natural next read is
`.aipe/study-database-systems/` for the storage-engine mechanics
(WAL, replication protocols, isolation levels) underneath whatever
datastore replaces SQLite.

## Interview defense

**Q: "How would you scale this beyond one SQLite writer?"**
A: First identify the actual constraint — write throughput, availability
under single-node failure, or cross-region latency — because each points to
a different fix. Write throughput → shard by `shopId` (every query is
already shop-scoped, so this is a natural partition key with no cross-shard
query cost in the common case). Availability → move to a primary with
synchronous replicas and a failover mechanism, accepting either write
latency (sync) or a small data-loss window (async). Latency → multi-region
read replicas plus read-your-writes routing so a merchant's own writes
never appear stale to them.
```
  constraint: throughput?   → shard by shopId
  constraint: HA?           → primary + replicas + failover
  constraint: latency?      → multi-region + read-your-writes routing
```
One-line anchor: *name the constraint before naming the fix — replication
and sharding solve different problems and shouldn't be reached for
interchangeably.*

**Q: "What's the single biggest thing you'd need to change first?"**
A: The queue claim in `worker-core.server.ts` — it's a plain `findFirst`,
correct only because there's exactly one worker. Before any replication or
sharding conversation, a second worker process needs an atomic
conditional-update claim (`UPDATE ... WHERE status='QUEUED'`, checking
affected-row count) or two workers will race to claim the same scan. That's
covered in full in `06-queues-streams-ordering-and-backpressure.md`.
One-line anchor: *scaling workers comes before scaling storage, and it's a
different fix entirely.*

## See also

- `01-distributed-system-map.md` — the single-machine topology this file
  contrasts against.
- `06-queues-streams-ordering-and-backpressure.md` — the concrete
  single-worker-only claim mechanism that would need to change first.
- `.aipe/study-database-systems/` — replication and consistency mechanisms
  at the storage-engine layer, once a real datastore choice is on the table.
- `.aipe/study-system-design/` — the broader scale-tradeoff conversation
  this file's hypothetical section feeds into.
