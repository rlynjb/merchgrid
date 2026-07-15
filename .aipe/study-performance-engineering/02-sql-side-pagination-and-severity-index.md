# SQL-Side Pagination and the Severity Index

### Index-backed server-side pagination — industry standard

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  IndexTable renders findingsPage.findings (≤50 rows)        │
  └──────────────────────────┬──────────────────────────────────┘
                              │ loader() calls
  ┌─ Service layer ───────────▼──────────────────────────────────┐
  │  scan-api.server.ts: getScanFindings()                       │
  │    ★ WHERE / ORDER BY / skip+take BUILT HERE, NOT LOOPED ★    │ ← we are here
  └──────────────────────────┬──────────────────────────────────┘
                              │ Prisma → SQL
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  SQLite Finding table                                         │
  │  @@index([scanId, severityRank, checkId])                    │
  └────────────────────────────────────────────────────────────────┘
```

This is the mechanism the product spec's one hard performance number actually points at: "Findings table should remain responsive with at least 5,000 findings through server-side pagination or equivalent techniques" (`merchgrid-catalog-audit-product-spec.md:854`). The move is simple to say and easy to get wrong in practice: **push the sort, the filter, and the "which 50 rows" decision into the database, and never let a request touch more rows than the page it's returning.**

## The structure pass

**Axis: control — who decides the sort order and which rows come back, the application or the database engine?**

```
  Same three boxes, one axis, one flip

  ┌─ UI/loader ──────┐   ┌─ Service (getScanFindings) ─┐   ┌─ Storage (SQLite) ─┐
  │ asks for "page 100"│→ │ builds where/orderBy/skip/  │→ │ walks the INDEX,    │
  │ knows nothing about │  │ take — issues ONE query     │  │ returns 50 rows     │
  │ how it's satisfied  │  │                              │  │                     │
  └──────────────────┘   └───────────────────────────────┘   └─────────────────────┘
      control: caller           control: SHAPES the ask        control: DECIDES
      just asks                 (where/orderBy/skip/take)       the actual rows
                                                                 via the index
```

The seam that matters sits between "service" and "storage": that's where control over row selection genuinely lives — not in the Remix loader (which just relays `page`/`severity`/`q` query params), and not really in `getScanFindings` either, which only *shapes the request*. The database is what walks the index and decides which 50 rows exist. That seam is load-bearing because the axis flips hard across it: everywhere above the seam, "control" means "pass parameters through." At the seam, control means "execute a query plan against an index." Get that plan wrong (no index, or a column that can't be indexed cheaply) and everything above it — the loader, the UI, the pagination controls — looks identical while the actual cost explodes underneath.

## How it works

**The mental model:** you've downloaded a huge JSON array in the browser and then called `.filter().sort().slice()` on it in JS — versus writing a SQL `WHERE ... ORDER BY ... LIMIT ... OFFSET` and letting Postgres or SQLite do it with an index. Same operation, wildly different cost curve: the first is O(everything you downloaded) no matter which page you wanted; the second is close to O(page size) because the index lets the engine seek instead of scan.

```
  Pattern — push the filter/sort/window past the network boundary

  naive (load-all-then-slice)          index-backed (this repo, now)
  ─────────────────────────────        ──────────────────────────────
  findMany({ scanId })  ← ALL rows     count({ where })       ← 1 number
  .filter(search)        ← in JS       findMany({             ← ONE query,
  .sort(severityRank)    ← in JS         where, orderBy,         index-backed,
  .slice(page window)    ← in JS         skip, take })          only page rows
                                                                  ever leave DB
  cost: O(total findings)              cost: ≈ O(page size),
  on EVERY page request                index does the seek
```

### The skeleton — three parts, each load-bearing

- **A sortable column that isn't `severity` itself.** `Finding.severity` is a string (`"CRITICAL" | "WARNING" | "UNAVAILABLE"`) — `ORDER BY severity` in SQL sorts alphabetically (`CRITICAL, UNAVAILABLE, WARNING`), which is the wrong order. `Finding.severityRank` (`app/prisma/schema.prisma:94-97`) is a small integer (`CRITICAL=0, WARNING=1, UNAVAILABLE=2`, defined in `app/app/services/scan/severity.ts:13-17`) computed once at persist time specifically so `ORDER BY severityRank` sorts correctly *in SQL*. Drop this column and you either sort wrong, or you're back to loading every row and sorting the severity in JavaScript — the exact cost this mechanism exists to avoid.
- **A pre-joined search haystack (`searchText`).** Free-text search needs to match against product title, variant title, SKU, *or* barcode. Without a single column to search, that's either four separate `OR`-ed `LIKE` clauses per request (harder for the engine to use an index for) or, worse, loading everything and checking each field in JS. `buildSearchText` (`severity.ts:32-39`) concatenates and lowercases all four fields into one column at write time, so a request-time search is a single `where.searchText = { contains: search }` (`scan-api.server.ts:254-262`) against SQLite's case-sensitive `contains` — case-insensitivity comes from lowercasing both sides, at write time and at query time, not from a DB-level `ILIKE`.
- **The composite index, matching the actual query shape.** `@@index([scanId, severityRank, checkId])` (`schema.prisma:124`) exists because every real query filters by `scanId` first, then needs rows in `severityRank, checkId` order. An index on the wrong column order, or no index at all, means the `ORDER BY` still *works* — it just falls back to a full table scan plus an in-memory sort *inside SQLite itself*, which is a smaller version of the exact problem this whole pattern is designed to avoid.

### The code, side by side

`app/app/services/scan/scan-api.server.ts:225-275` — `getScanFindings`, the paginated read:

```ts
const where: Prisma.FindingWhereInput = { scanId: scan.id };
if (opts.severity) { where.severity = opts.severity; }        // → SQL WHERE
if (opts.checkId) { where.checkId = opts.checkId; }            // → SQL WHERE
if (search) { where.searchText = { contains: search }; }       // → SQL WHERE, index-friendly

const total = await prisma.finding.count({ where });            // 1 query, no row fetch
const rows = await prisma.finding.findMany({
  where,
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],        // → SQL ORDER BY, uses the index
  skip: (page - 1) * pageSize,
  take: pageSize,                                                 // → SQL LIMIT/OFFSET
});
```

Every clause in that call compiles to something SQLite's query planner can push down to the index — `count` never touches a row body, and `findMany` only ever materializes `pageSize` (≤200, `MAX_PAGE_SIZE`, line 28) rows into memory, no matter how many thousands of findings the scan produced.

```
  Layers-and-hops — one page request, top to bottom

  ┌─ Remix loader ─────┐  hop 1: page=100, severity=CRITICAL
  │ (app.scans.$id.tsx)│ ──────────────────────────────────►
  └─────────────────────┘
              ┌─ getScanFindings ──────────────────────┐
              │ builds where/orderBy/skip/take           │  hop 2: ONE query,
              │ (scan-api.server.ts:225-275)             │  shaped not looped
              └───────────────────┬───────────────────────┘
                                  ▼
              ┌─ SQLite ────────────────────────────────┐
              │ walks @@index([scanId,severityRank,      │  hop 3: index seek,
              │   checkId]), returns exactly 50 rows      │  not a table scan
              └───────────────────┬───────────────────────┘
                                  ▼ hop 4: 50 FindingRow objects
              ┌─ IndexTable (client) ────────────────────┐
              │ renders exactly what it got, nothing more │
              └────────────────────────────────────────────┘
```

### Phase A → Phase B: this repo actually made this exact change

This isn't a hypothetical before/after — it's this repo's own history. Commit `788a737` ("perf(scan): move findings pagination/filter/sort/search into SQL") replaced an earlier, working implementation of `getScanFindings` that did exactly the naive thing:

```
  Phase A (removed, commit 788a737)         Phase B (current)
  ──────────────────────────────────         ──────────────────
  rows = findMany({ where: { scanId }})      total = count({ where })
    ← loads EVERY finding for the scan       rows = findMany({ where,
  filteredRows = rows.filter(searchMatch)      orderBy, skip, take })
    ← JS .filter() over all rows               ← ONE query, page-sized
  sorted = sortBySeverityThenCheckId(rows)
    ← JS .sort() with a SEVERITY_RANK map    cost: ≈ O(page size),
  pageRows = sorted.slice(start, end)          index-backed seek
    ← JS .slice() for the actual page

  cost: O(total findings) on EVERY page request, regardless of which page
```

The commit message names the reason directly: the old code was "an O(total findings) load on every page request that would not stay responsive at ~5000 findings (spec §11.2)." That line is a **design rationale**, not a benchmark result — there's no captured timing in the commit showing the old code actually being slow at 5,000 rows, and there still isn't one for the new code either (see `audit.md` → lens 2). What changed is real and verifiable by reading the diff; what it bought in wall-clock terms has never been measured on either side. The takeaway that survives regardless: the columns this migration relies on — `severityRank`, `searchText`, and the composite index — didn't need to change at all. They were added earlier (`3025a05`, `feat(db): add Finding.severityRank and Finding.searchText columns`) specifically so a later refactor like this one could happen entirely inside `scan-api.server.ts`, with zero migration risk to the data already on disk.

**The principle:** pagination that "works" at 50 rows and pagination that *stays correct at 5,000* are not the same claim, and the difference is entirely about where the sort/filter/window decision is made. Any mechanism that loads N rows to return page-size-of-N rows has a cost curve that's flat in the wrong variable — it costs the same whether you want page 1 or page 99, and it costs more as the *total* grows even though what the user asked for (one page) never did. Pushing the decision to an index-backed query makes the cost track the thing the user actually asked for.

## Primary diagram

```
  SQL-side pagination — the whole mechanism together

  ShopSettings                          Finding.severityRank (int, persist-time)
  (persist-time, runner.server.ts)      Finding.searchText   (persist-time, lowercased)
        │                                        │
        ▼                                        ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  @@index([scanId, severityRank, checkId])  (schema.prisma:124) │
  └──────────────────────────┬───────────────────────────────────────┘
                              │ query time
  ┌─ getScanFindings() ───────▼──────────────────────────────────────┐
  │  where: {scanId, severity?, checkId?, searchText.contains?}       │
  │  orderBy: [severityRank asc, checkId asc]                          │
  │  skip/take: exactly one page                                      │
  └──────────────────────────┬──────────────────────────────────────────┘
                              ▼
                    ≤ MAX_PAGE_SIZE (200) rows ever leave SQLite,
                    regardless of how many findings the scan produced
```

## Elaborate

This is the same shape as keyset/offset pagination in any REST or GraphQL API backed by a real database, and the same principle behind why a search product denormalizes a "search document" (Elasticsearch's inverted index, Algolia's index shards) instead of grepping source rows at query time — precompute the shape the query needs, once, at write time, so read time is cheap no matter how the data grew. The `severityRank` column specifically is the classic fix for "I need to sort by a business-meaning order that isn't the column's natural sort order" — the same reason enum-backed columns often get an accompanying integer rank column in any schema that needs custom ORDER BY semantics.

What to read next: `01-bounded-catalog-read.md` for how the *input* side (the catalog read) is bounded the same way this output side is; `.aipe/study-database-systems/` for how SQLite's query planner actually walks a composite index (this file stops at "it uses the index," not the B-tree mechanics underneath); `.aipe/study-data-modeling/` for why `severityRank`/`searchText` count as intentional denormalization rather than schema smell.

## Interview defense

**Q: Why not just add pagination to the existing `findMany({ where: { scanId } })` call and slice in JS?**
A: Because slicing in JS still requires loading every row for the scan first — pagination that happens *after* the full load doesn't reduce the cost of the load, it only reduces what gets rendered. The load stays O(total findings) no matter which page you keep. One-line anchor: *paginating the output doesn't help if you already paid for the whole input.*

```
  paginate-after-load          paginate-in-the-query
  ┌──────────────────┐         ┌──────────────────┐
  │ load ALL rows      │         │ load ONLY the      │
  │ (cost paid here)   │   vs    │ requested page     │
  │ then slice 50      │         │ (cost paid here)   │
  └──────────────────┘         └──────────────────┘
```

**Q: What's the part of this that people build and then forget to verify?**
A: The index has to match the query's actual filter+sort columns, in the same order (`scanId, severityRank, checkId` — matching the `where` + `orderBy` shape exactly). An index on the wrong columns, or in the wrong order, still lets the query *run* — SQLite falls back to scanning and sorting in memory internally — so it's easy to ship this pattern, see it work in dev with a handful of rows, and never notice the index isn't actually being used until the row count is large enough to matter. That's exactly the thing this repo has never checked: no `EXPLAIN QUERY PLAN` output exists anywhere confirming the index is actually hit.

**Q: How would you prove this actually stays responsive at 5,000 findings, today?**
A: Seed a scan with 5,000+ `Finding` rows (the current `seed-fixtures.ts` doesn't generate this volume — see `audit.md` lens 2), then time `getScanFindings` for page 1 and for the last page, with and without the composite index dropped, and confirm the timing stays flat across pages with the index and degrades without it. That comparison doesn't exist in this repo yet.

## See also

- `01-bounded-catalog-read.md` — the input-side twin: bounding what comes *in* to a scan, the same way this bounds what comes back *out*.
- `04-linear-time-grouped-checks.md` — the engine-side reason the *findings themselves* don't cost O(n²) to produce before they ever reach this table.
- `.aipe/study-database-systems/` — SQLite index/query-execution mechanics.
- `.aipe/study-data-modeling/` — the denormalization reasoning on `Finding`.
- `audit.md` → lens 1 (performance budget — the exact §11.2 quote this mechanism answers), lens 2 (measurement), lens 5 (I/O/DB bottlenecks).
