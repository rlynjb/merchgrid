# Database Systems — MerchGrid: Catalog Audit

## What this guide covers

The storage-engine and consistency mechanisms *beneath* the app — not the shape of the data (that's `study-data-modeling`), not which datastore was picked or how it scales (that's `study-system-design`). This guide is about how reads and writes actually get executed and preserved: pages, indexes, query plans, transactions, isolation, locking, the write-ahead log, and replication.

```
  Where this guide sits — the partition

  study-data-modeling     the SHAPE of persistent data, whether it fits access patterns
  study-database-systems  ★ the MECHANISMS that execute and preserve reads/writes ★ ← you are here
  study-system-design     WHICH datastore was picked, and how the system scales
```

## The repo's actual shape, in one line

**SQLite (`provider = "sqlite"`, `app/prisma/schema.prisma:12`) via Prisma 6.2.1, one file, one Fly volume, one always-on machine running two OS processes (web + worker) against it.** No Postgres, no MySQL, no managed database service, no replicas. This is not a toy choice — the whole app is single-tenant-per-scan, low write volume, and reads happen almost entirely through one owner's Prisma client. It is also a choice with a real ceiling, named honestly throughout this guide.

## Verified facts about the live database (not inferred — read directly off `app/prisma/dev.sqlite` with the `sqlite3` CLI)

| Fact | Value | How it was checked |
|---|---|---|
| `journal_mode` | `delete` (the default rollback journal) | `PRAGMA journal_mode;` — **not WAL**, and nothing in the repo sets it |
| `page_size` | 4096 bytes | `PRAGMA page_size;` |
| `page_count` | 45 (the whole file is 45 pages) | `PRAGMA page_count;` |
| `auto_vacuum` | off (0) | `PRAGMA auto_vacuum;` |
| busy-timeout / `connection_limit` in `DATABASE_URL` | none set anywhere | grep across `schema.prisma`, `db.server.ts`, `.env`, `fly.toml` |
| query engine | Prisma's own Rust query engine (no `driverAdapters`, no `better-sqlite3`, no `libsql`) | `package.json`, `schema.prisma` |

These facts drive several findings below — most importantly, this app runs SQLite in its *default* concurrency mode, not the mode most production SQLite deployments reach for.

## Reading order

1. `01-database-systems-map.md` — the datastore map: SQLite as an embedded engine vs. a client-server RDBMS, and where the app's processes sit relative to the file.
2. `02-records-pages-and-storage-layout.md` — pages, B-tree layout, and the real page/byte cost of every table and index in this schema.
3. `03-btree-hash-and-secondary-indexes.md` — the four indexes this schema actually has, why `severityRank` and `searchText` exist as denormalized columns, and the index this schema is missing.
4. `04-query-planning-and-execution.md` — `EXPLAIN QUERY PLAN` output taken directly from the app's real queries: which ones are index-covered, which one does a full table scan.
5. `05-transactions-isolation-and-anomalies.md` — the one `$transaction` in the codebase (`runner.server.ts`), and the TOCTOU race the code itself documents and accepts.
6. `06-locks-mvcc-and-concurrency-control.md` — SQLite's whole-database locking vs. row-level locking and MVCC; what changes if a second worker process is added.
7. `07-wal-durability-and-recovery.md` — durability boundaries, the rollback journal this repo actually runs, migrate-on-boot, and the volume-snapshot recovery story.
8. `08-replication-and-read-consistency.md` — why this is `not yet exercised`, and what changes the day this app needs a read replica.
9. `09-database-systems-red-flags-audit.md` — every risk above, ranked by consequence.

## `not yet exercised` in this repo

Named up front so nothing below overclaims:

- **MVCC** (multi-version concurrency control) — SQLite's rollback-journal mode doesn't have it; readers and writers contend for the same lock. Taught in `06` as "what a bigger engine does instead."
- **Row-level / page-level locking** — SQLite locks the whole database file, not individual rows. Taught in `06`.
- **Replication, failover, replica lag, read consistency across nodes** — one file, one volume, no replicas. Taught in `08` entirely as the industry pattern, with no repo code to anchor to.
- **Distributed transactions / two-phase commit** — no second datastore, no cross-service transaction ever happens here.
- **Connection pooling at the network layer** — SQLite is embedded (in-process), so there's no TCP connection to pool the way there would be against Postgres.
- **WAL mode** — available in SQLite, *not enabled* in this repo (verified: `journal_mode` is `delete`). Taught in `07` as the mechanism this app doesn't use and what adopting it would change.

## Ranked findings (full detail in `09`)

1. **`claimAndRunNext`'s queue-claim query does a full table scan of `Scan` plus a temp B-tree sort** (`app/app/services/scan/worker-core.server.ts:34-38`) — no index covers `(status, createdAt)` globally; verified via `EXPLAIN QUERY PLAN`.
2. **No WAL mode, no `busy_timeout`, one file shared by two processes** (web + worker) — under the default rollback journal, a writer holds an exclusive lock that can produce `SQLITE_BUSY` for the other process, and nothing in the repo sets a retry/backoff at the SQLite layer.
3. **The queue-claim TOCTOU race is real and the code says so** (`app/app/services/scan/queue.server.ts:54-62`) — a documented, accepted risk, not an oversight.
4. **`Session` table has no index on `shop`** (verified via `PRAGMA index_list(Session)`), even though every authenticated request resolves a session by shop domain.
5. **Single-node durability**: no replication, Litestream deliberately skipped, recovery is Fly's volume-snapshot mechanism (see `app/DEPLOY.md` "Known caveats").

## Cross-links

- Schema shape and normalization tradeoffs (the denormalized `severityRank`/`searchText`/variant fields) → `study-data-modeling`.
- Why SQLite was picked over a managed Postgres, and what the system-design cost of outgrowing it looks like → `study-system-design`.
