# Replication and read consistency

### Leader/replica replication (industry standard) — `not yet exercised` in this repo

## Zoom out — the bigger picture

Every prior file in this guide has assumed one file, one machine. This file is about what changes the day that stops being true — and it's the one concept in this guide with no repo code to anchor to, because the repo's own design deliberately prevents the scenario replication solves.

```
  Zoom out — where replication WOULD sit, if it existed here

  ┌─ Today: ONE machine, ONE volume ─────────────────────────┐
  │  web + worker, both against /data/prod.sqlite               │
  │  fly.toml: NO [processes] block, BY DESIGN (see comment)      │
  └────────────────────────────────────────────────────────────┘
                              ✕ NOT PRESENT ✕
  ┌─ Hypothetical: leader + replicas ─────────────────────────┐
  │  ★ THIS CONCEPT: writes → leader; reads spread across        │ ← would live here
  │  replicas; replicas lag; failover promotes a replica ★         │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**Replication** is copying a database's writes to one or more additional nodes, so reads can be served from more than one place and a failed node doesn't take the whole database down. The standard shape is **leader-replica** (also called primary-replica or master-slave): all writes go to one leader, the leader streams its write-ahead log to replicas, and replicas apply those changes to stay in sync — usually a few milliseconds to seconds behind, which is **replica lag**, the source of every "stale read" problem this pattern introduces. This repo has none of it, and — this is the part worth being precise about — the repo's own infrastructure comment names *why*, not just *that* it doesn't exist.

## Why this is `not yet exercised`, in the repo's own words

`app/fly.toml`'s comment block states the constraint directly:

```toml
# Topology: ONE always-on machine running both the Remix web server and
# the catalog-audit background worker (see start-production.js), backed by
# a single SQLite database on a Fly volume mounted at /data. There is
# intentionally no `[processes]` block — that would let Fly schedule web
# and worker as separate machines, which cannot both mount the same
# volume, and this deploy has exactly one SQLite writer by design.
```

Read that closely: it isn't just "we haven't added replicas yet" — it's "the topology is *structured* to make more than one writer machine impossible," because a Fly volume can only be mounted by one machine at a time. Adding a read replica of a SQLite-on-a-volume setup isn't a config flag away; it requires a genuinely different replication mechanism layered on top (Litestream streaming the WAL to object storage, or LiteFS distributing the file across machines) — and `app/DEPLOY.md`'s caveats section already named Litestream as the "later hardening step... not implemented here" (see `07`). So replication here isn't merely absent — it's a deliberately deferred, correctly-scoped-out piece of future work, not a gap nobody considered.

## The structure pass (taught in the abstract — no repo seam exists yet)

**Axis: how stale can a read be, and who's allowed to see that staleness?** This is the axis that becomes relevant the day a leader-replica setup exists — trace it because it's the exact question this app would have to answer for the first time.

```
  One axis — "how stale is this read allowed to be?" — across a hypothetical topology

  write path:       app → LEADER (only place writes are accepted)
  read path A:       app → LEADER (read-your-own-write consistency, but doesn't scale)
  read path B:       app → REPLICA (scales reads, but might be milliseconds-to-seconds stale)

  seam: the moment a read is served from a replica instead of the leader,
  "what does this reader see" stops being a database-engine guarantee
  and becomes an APPLICATION decision — which reads can tolerate staleness,
  which can't.
```

## How it works — the pattern, taught fully, in engineering terms

### Move 1 — the mental model

You've pushed to a `git` remote and had a teammate's local clone be a few commits behind until they `pull` — that's replica lag, exactly. The remote (leader) has the truth; every clone (replica) is a copy that's current as of its last sync, not necessarily current as of *now*. A replica read is reading someone's local clone; it might be stale by however long since their last `pull`.

```
  Pattern — leader-replica replication topology

                    ┌───────────┐
        writes ────►│  LEADER    │
                    └─────┬─────┘
                          │ streams its write-ahead log
              ┌───────────┼───────────┐
              ▼           ▼           ▼
        ┌──────────┐┌──────────┐┌──────────┐
        │ replica 1 ││ replica 2 ││ replica 3 │  ← each applies the log
        └──────────┘└──────────┘└──────────┘     asynchronously; each can
              ▲           ▲           ▲           lag the leader by a
              └───────────┴───────────┘           different amount
                     reads spread here
                (each read may see a DIFFERENT,
                 slightly-behind point in time)
```

### Move 2 — the mechanics this app would need to reason about, if it ever had replicas

**Replica lag, made concrete with this app's own data shape.** Imagine `runScan`'s atomic `$transaction` (`05`) commits on a hypothetical leader — findings inserted, scan marked `COMPLETED`. If the results page (`app.scans.$id.tsx`) read from a lagging replica instead of the leader, a merchant could refresh their scan results page and see `status: "RUNNING_CHECKS"` (the replica's stale view) even though the leader has already committed `COMPLETED` — a **stale read**, not a bug in the query, just an honest consequence of asynchronous replication.

```
  Pattern — a stale read, this app's own scan-status shape

  LEADER (just committed):     Scan.status = "COMPLETED"
  REPLICA (still lagging):     Scan.status = "RUNNING_CHECKS"   ← what a
                                                                    replica read
                                                                    would return
  merchant refreshes the results page during that lag window →
  sees "still running" for a scan that's actually done
```

**Failover — what happens when the leader itself dies.** In a leader-replica setup, losing the leader means promoting one replica to be the new leader — and the mechanics of *which* replica gets promoted, and what happens to writes that were in flight but hadn't yet replicated, is the entire subject of failover protocols (manual promotion, or automated consensus like Raft/Paxos in more sophisticated systems). None of that exists here: this app has exactly one node, so "the leader dies" and "the entire database is unavailable" are the same event — there's no replica to promote. That's a real ceiling, not a design flaw at this scale, and it's precisely the scenario `07`'s durability section already covers (a lost machine recovers via Fly rescheduling the same volume; a lost *volume* has no failover target at all).

**Read-your-own-writes — the consistency guarantee this app gets essentially for free today, that a replica setup would have to re-earn.** Right now, `getScanSummary` and `getScanFindings` (`scan-api.server.ts`) always read the *same* SQLite file the worker just wrote to — there is no possibility of "the writer sees COMPLETED but the reader still sees RUNNING_CHECKS," because there's only one copy of the data. That guarantee — a caller always seeing its own most recent write reflected in the next read — is called **read-your-own-writes consistency**, and it's automatic in a single-node system. The moment a system adds replicas for read scaling, read-your-own-writes has to be *re-engineered*: either route a caller's reads to the leader for some window after their write, or accept the staleness for that use case.

### Move 3 — the principle

Replication doesn't remove a consistency problem — it *creates* one (staleness) in exchange for solving a scaling problem (read throughput, node redundancy). A single-node system like this repo doesn't need to solve the staleness problem because it never created it; the entire "which reads can tolerate lag" design conversation only starts the day a second node enters the picture. That's the correct way to read this file's `not yet exercised` status: not "this repo forgot something," but "this repo hasn't yet needed the tradeoff that replication forces."

## Primary diagram

```
  What this repo has today vs. what replication would add

  TODAY (verified)                              WITH REPLICATION (not present)
  ┌────────────────────────────┐               ┌────────────────────────────────┐
  │ ONE file, ONE machine          │               │ leader (writes) + N replicas     │
  │ read-your-own-writes: FREE      │               │ (reads) — staleness window        │
  │ (only one copy of the data)      │               │ appears; app must decide which     │
  │                                    │               │ reads tolerate it                    │
  │ node dies → app is down           │               │ node (leader) dies → failover:       │
  │ (no failover target exists)         │               │ promote a replica, some writes        │
  │                                      │               │ may be lost if unreplicated yet       │
  └────────────────────────────────┘               └────────────────────────────────────┘
```

## Elaborate

Leader-replica replication is the default answer to "one database server can't serve enough reads, or can't be the single point of failure it currently is" — Postgres streaming replication, MySQL binlog replication, and MongoDB replica sets are all the same shape with different plumbing. SQLite's embedded nature makes this genuinely harder than for a client-server engine: there's no separate database server process to point a second reader at — the "leader" would have to be a whole separate machine with its own file, kept in sync by something outside SQLite itself (Litestream shipping the WAL to object storage for disaster recovery, or LiteFS/rqlite building an actual distributed SQLite). Both are real, shipped tools; neither is in this repo, and `07`'s DEPLOY.md citation already shows the team weighed Litestream specifically and deferred it.

## Interview defense

**Q: "This app has zero replicas — walk me through the reasoning for why that's fine today."**
A: Traffic shape: one shop's scan results are read by that shop's own merchant, at low volume, against one machine that's already fast enough. Replication solves read-scaling and node-redundancy problems this app doesn't have yet — adding it now would mean paying replica-lag complexity (stale reads, failover logic) for a scaling problem that doesn't exist, while the actual infrastructure (`fly.toml`'s single-volume, single-machine topology) is explicitly built to prevent more than one writer anyway.

**Q: "If this app did add a read replica someday, what's the first correctness question you'd have to answer?"**
A: Which reads can tolerate staleness. `getScanSummary`/`getScanFindings` immediately after a scan completes is exactly the case that can't — a merchant watching their own scan finish needs read-your-own-writes, so that specific read path would have to stay pinned to the leader (or the app would need to track "did I just write this" and route accordingly) while lower-stakes reads (e.g. a dashboard listing older, already-settled scans) could safely go to a replica.

```
  the first question replication forces:  which read needs "now,"
  and which read can tolerate "a few seconds ago"?
```

## See also

- `07-wal-durability-and-recovery.md` — the single-volume durability story this file's absence of replication is downstream of.
- `study-system-design` — the broader question of when this app would actually need to move off SQLite entirely, which is a different decision than "add a replica."
