# Query planning and execution

### Query plan / query optimizer (industry standard: `EXPLAIN QUERY PLAN`) — Project-specific: `app/app/services/scan/worker-core.server.ts`

## Zoom out — the bigger picture

`03` showed which indexes exist. This file is about the decision-maker that actually chooses whether to use them: SQLite's query planner, and what it decides for every real query this app issues — verified, not guessed, by running `EXPLAIN QUERY PLAN` against this repo's own `dev.sqlite`.

```
  Zoom out — where the query planner sits

  ┌─ ORM ──────────────────────────────────────────────────┐
  │  Prisma generates SQL from prisma.finding.findMany(...)    │
  └───────────────────────────┬──────────────────────────────┘
                              │ raw SQL text
  ┌─ Query planner/optimizer ─▼──────────────────────────────┐
  │  ★ THIS FILE: decides SCAN vs. SEARCH, which index, ★       │ ← we are here
  │  ★ whether a temp sort is needed ★                          │
  └───────────────────────────┬──────────────────────────────┘
                              │ chosen execution plan
  ┌─ Storage engine ───────────▼──────────────────────────────┐
  │  B-tree page reads (02, 03)                                  │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Every SQL statement has more than one physically possible way to execute — scan the whole table, or use one of several indexes, in one of several orders. The **query planner** picks one of those plans before running anything, using table/index statistics it maintains internally. `EXPLAIN QUERY PLAN` is SQLite's window into that decision — it doesn't run the query, it just prints which plan was chosen. This file walks that output for the real queries this app issues, and finds one query that the planner has no good option for at all.

## The structure pass

**Axis: for each real query in this codebase, does the chosen plan touch O(matching rows) or O(all rows)?** That's the entire difference between "fine forever" and "gets slower as the table grows," and it's not visible from reading the Prisma call alone — you have to read the plan.

```
  One axis — "how much of the table does this plan touch?" — per query

  getScanFindings (findMany)      → SEARCH using index          → O(this scan's findings)
  getScanFindings (count)         → SEARCH using COVERING index → O(this scan's findings)
  getActiveScan (findFirst)       → SEARCH using index          → O(this shop's active scans)
  claimAndRunNext (findFirst)     → SCAN (no usable index)       → O(ALL scans, every shop)  ← seam

  the seam: one query in this codebase is NOT bounded by tenant —
  it's global, and it's the one with no matching index.
```

## How it works

### Move 1 — the mental model

You've read a table of contents before deciding whether to flip through an entire book — that's a query planner's whole job, done ahead of time instead of at read time: look at what indexes ("tables of contents") exist, and pick the cheapest way to satisfy the request. SQLite's planner does this per-query, using rough cardinality estimates it keeps about each table/index, not by actually trying every plan and timing it.

```
  Pattern — the planner's binary choice, per query

           incoming SQL
                │
        ┌───────┴────────┐
        ▼                 ▼
  usable index?      no usable index
   exists              matches WHERE
        │                 │
        ▼                 ▼
   SEARCH using       SCAN whole table
   INDEX (fast,       (O(n), touches
   O(matching rows))  every row)
        │                 │
        └───────┬─────────┘
                ▼
       ORDER BY satisfied
       by index order?
        │            │
       yes           no
        │            ▼
        │      USE TEMP B-TREE
        │      FOR ORDER BY
        ▼            │
     done ◄──────────┘
```

### Move 2 — reading real plans, one query at a time

**The good case — `getScanFindings`, fully index-served.** Walked in detail in `03`; the short version: `WHERE scanId=? ORDER BY severityRank, checkId LIMIT ... OFFSET ...` (`app/app/services/scan/scan-api.server.ts:264-270`) plans as a single `SEARCH ... USING INDEX Finding_scanId_severityRank_checkId_idx (scanId=?)` with no temp-sort line — the index's key order already matches the query's need end to end.

**Pagination is `OFFSET`-based, and that has its own cost curve.** `getScanFindings` computes `skip: (page - 1) * pageSize` (`app/app/services/scan/scan-api.server.ts:239-245, 268-269`) — classic offset pagination. SQLite still has to walk (and discard) every row before the offset even though the index makes finding the *starting point* of the scan itself cheap:

```
  Pattern — OFFSET pagination cost, even when index-covered

  page 1: SEARCH index, walk rows 1-50,    return 50           — cheap
  page 5: SEARCH index, walk rows 1-250,   DISCARD 200, return 50 — walks 5x the data returned

  cost grows with page number, even though every page hits the same index
```

Not a real problem in this app — `MAX_PAGE_SIZE = 200` (`scan-api.server.ts:28`) and a single scan's finding count is bounded by the merchant's catalog size and `catalogVariantLimit` (default 5000, `app/prisma/schema.prisma:54`), so the total pages per scan is small. Worth naming anyway: offset pagination's cost is O(offset + limit), not O(limit) — the fix at real scale is keyset/cursor pagination (`WHERE (severityRank, checkId) > (?, ?)`), which this schema's own index shape would support if it were ever needed.

**The uncovered case — free-text search.** Already walked in `03`: `searchText LIKE '%...%'` can't use a B-tree at all for the match itself; the plan only uses the index for the `scanId=?` prefix, then linearly scans the (small, scan-scoped) remainder.

**The real finding — `claimAndRunNext` has no usable index and scans the whole `Scan` table.** This is the worker's queue-claim query, run on every poll cycle:

```ts
// app/app/services/scan/worker-core.server.ts:34-38
const scan = await prisma.scan.findFirst({
  where: { status: "QUEUED" },
  orderBy: { createdAt: "asc" },
  include: { shop: true },
});
```

Running the equivalent SQL through `EXPLAIN QUERY PLAN` against this repo's own database:

```
EXPLAIN QUERY PLAN
SELECT * FROM Scan WHERE status='QUEUED' ORDER BY createdAt ASC LIMIT 1;

|--SCAN Scan
`--USE TEMP B-TREE FOR ORDER BY
```

`SCAN Scan` — not `SEARCH` — means the planner is reading **every row in the `Scan` table**, checking each one's `status` by hand, because the only index that touches `status` is `Scan_shopId_status_idx`, and its leading column is `shopId` — this query has no `shopId` filter at all (it deliberately looks across *every* shop for the oldest queued scan, per the comment at `app/app/services/scan/worker-core.server.ts:22-28`). A composite index whose leading column isn't in the query's filter is invisible to the planner — exactly the seam named in `03`'s structure pass. On top of the full scan, `USE TEMP B-TREE FOR ORDER BY` means the (already-scanned) rows then get sorted by `createdAt` in a temporary structure, because nothing indexes `createdAt` at all.

**Why this hasn't hurt yet, and exactly when it will.** At today's row counts (14 `Scan` rows measured in this repo's dev database) a full table scan is effectively instant — SQLite can walk 14 rows in microseconds. But this query runs on *every worker poll cycle*, unconditionally, for the lifetime of the app, and its cost is proportional to the **total historical `Scan` row count across every shop that has ever used the app** — not the currently-queued count. `Scan` rows are never deleted except by the GDPR `shop/redact` cascade (`app/app/models/shop.server.ts:49-51`), so this table only grows as more shops install and scan over the app's lifetime. This is the single most consequential missing-index finding in this schema (ranked #1 in `09`), precisely because it's invisible today and guaranteed to degrade — the query gets slower every single poll cycle as unrelated shops accumulate history, even though it's a single worker asking "what's next to do."

```
  Layers-and-hops — the queue-claim query's actual execution path

  ┌─ Worker process ────────────────────────────────────────────┐
  │  claimAndRunNext() polls in a loop                            │
  └───────────────────────────┬──────────────────────────────────┘
                              │ prisma.scan.findFirst({status:'QUEUED', orderBy:createdAt})
  ┌─ Query planner ────────────▼──────────────────────────────────┐
  │  no index has `status` as a leading column with no shopId       │
  │  → chooses SCAN Scan (every row, every shop, every scan ever)    │
  │  → chooses TEMP B-TREE (nothing indexes createdAt alone)         │
  └───────────────────────────┬──────────────────────────────────┘
                              │
  ┌─ Storage (Scan table B-tree) ▼──────────────────────────────┐
  │  every page of the Scan table read, once per poll cycle         │
  └────────────────────────────────────────────────────────────────┘
```

**The fix, named precisely.** A partial index — `CREATE INDEX Scan_queued_createdAt_idx ON Scan(createdAt) WHERE status = 'QUEUED'` — would turn this into a `SEARCH` over just the currently-queued rows (typically zero or one, given "one active scan per shop" is enforced at the application layer — `queue.server.ts`), independent of total historical row count. SQLite supports partial indexes; nothing in this schema uses one yet.

### Move 3 — the principle

A query planner only has the indexes you've given it to choose from — it cannot invent a good plan for a filter shape no index matches, it can only tell you honestly (via `EXPLAIN QUERY PLAN`) that it's falling back to a full scan. The discipline this file teaches: don't infer index coverage from reading the Prisma call — read the actual plan. `getScanFindings` *looks* similar in shape to `claimAndRunNext` (both a `findFirst`/`findMany` with a `WHERE` and an `orderBy`), and yet one is a covering-index search and the other is a full table scan with a temp sort. The only way to know which is which is to ask the planner.

## Primary diagram

```
  Every real query in this codebase, plan verified via EXPLAIN QUERY PLAN

  getScanFindings (rows)      SEARCH USING INDEX Finding_scanId_severityRank_checkId_idx
                                → no temp sort, index order = query order
  getScanFindings (count)      SEARCH USING COVERING INDEX (same index)
                                → never touches the Finding table's own pages
  getScanFindings (search)     SEARCH USING INDEX ... (scanId=?) then LINEAR LIKE scan
                                → bounded by scan size, not table size
  getActiveScan                SEARCH USING INDEX Scan_shopId_status_idx
                                → + TEMP B-TREE for createdAt sort (small set, fine)
  claimAndRunNext              SCAN Scan (every row) + TEMP B-TREE for createdAt sort
                                → UNBOUNDED by tenant; grows with total historical Scan rows
                                → ★ highest-ranked finding in 09-red-flags-audit.md ★
```

## Elaborate

`EXPLAIN QUERY PLAN` is SQLite's version of what Postgres's `EXPLAIN ANALYZE` or MySQL's `EXPLAIN` do more elaborately (cost estimates, actual row counts, buffer hits) — SQLite's version is intentionally terse (no cost numbers, just SCAN/SEARCH + which index), which fits an embedded engine with no DBA dashboard to feed. The lesson generalizes completely: whenever a query's filter/sort doesn't line up with an index's leading columns, every engine's planner reaches for the same fallback — read everything, sort what's left. The fix is always the same shape too: a new or partial index that matches the actual access pattern, not a bigger machine.

## Interview defense

**Q: "How do you know whether a Prisma query is actually using an index, without reading the generated SQL yourself?"**
A: Run the equivalent SQL through `EXPLAIN QUERY PLAN` directly against the SQLite file (`sqlite3 app/prisma/dev.sqlite "EXPLAIN QUERY PLAN ..."`). It's the only ground truth — Prisma's schema-level `@@index` declarations tell you what exists, not what a specific query actually uses.

**Q: "You found a full table scan in this codebase — why hasn't it caused a production incident?"**
A: Because the table it scans (`Scan`) is small today (14 rows measured) and the scan is cheap in absolute terms. But it's unbounded by tenant and runs on every worker poll cycle for the app's entire lifetime — the risk isn't "slow right now," it's "gets linearly slower with total historical row count, silently, until someone notices worker latency creeping up." That's exactly the kind of finding `EXPLAIN QUERY PLAN` catches before a profiler would.

```
  today: 14 rows, scan is free       →  1 year from now: thousands of rows, scan is not free
  same code, same query, no alert fires — it degrades, it doesn't break
```

## See also

- `03-btree-hash-and-secondary-indexes.md` — why no index matches `claimAndRunNext`'s filter shape.
- `09-database-systems-red-flags-audit.md` — this finding ranked against every other risk in the schema.
- `study-performance-engineering` — for the broader latency/throughput budget this finding would eventually threaten.
