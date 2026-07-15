# B-tree, hash, and secondary indexes

### Secondary index (industry standard) — Project-specific: `app/prisma/schema.prisma` `@@index`

## Zoom out — the bigger picture

`02` showed that every index is its own B-tree with its own page cost. This file is about the other side of that trade: what each of this schema's four real indexes buys, and the one lookup path that has no index behind it at all.

```
  Zoom out — where indexes sit

  ┌─ Query engine ──────────────────────────────────────────┐
  │  decides: use an index, or scan the whole table?           │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Storage engine ──────────▼──────────────────────────────┐
  │  ★ THIS FILE: the B-tree structures a query CAN use ★       │ ← we are here
  │  table B-tree (rowid/PK-ordered) + secondary index B-trees  │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

SQLite has exactly one index structure: the **B-tree** (specifically a B+tree variant). No hash indexes, no GiST/GIN like Postgres — every `@@index` in `schema.prisma` compiles to a `CREATE INDEX` statement, which is a second B-tree keyed by the indexed columns, each leaf entry pointing back to the row. The entire design question in this schema is: which column combinations get their own B-tree, in what order, so the query engine can jump straight to the rows a request actually needs instead of walking the whole table.

## The structure pass

**Axis: for a given query's WHERE/ORDER BY shape, does an index exist that matches it — and in what column order?** Column order in a composite index is not cosmetic; a B-tree indexed on `(scanId, severityRank, checkId)` can serve `WHERE scanId = ?` alone, `WHERE scanId = ? AND severityRank = ?`, or `WHERE scanId = ? ORDER BY severityRank, checkId` — but it cannot serve `WHERE severityRank = ?` alone, because the tree's outermost sort key is `scanId`.

```
  One axis — "does the index's key order match the query's need?"

  index: (scanId, severityRank, checkId)

  query: WHERE scanId=? ORDER BY severityRank, checkId    → FULL MATCH (index-covered scan+sort)
  query: WHERE scanId=? AND severityRank=?                 → PARTIAL MATCH (prefix match)
  query: WHERE severityRank=? (no scanId)                  → NO MATCH — index unusable,
                                                               falls back to a table scan

  seam: the moment a query's leading filter column ISN'T the
  index's leading column, the index stops helping at all.
```

That seam is exactly where `claimAndRunNext`'s queue-claim query lives — walked in Move 2 below and confirmed with real `EXPLAIN QUERY PLAN` output.

## How it works

### Move 1 — the mental model

You've sorted an array with `.sort()` before, and you know it's O(n log n) every time you call it — unless you keep the array pre-sorted and just insert new elements in the right spot. A B-tree index *is* "keep the array pre-sorted" made durable: SQLite maintains the sorted order on every write, so a read that matches the sort key doesn't re-sort at read time — it just walks straight to the answer.

```
  Pattern — B-tree index lookup vs. full table scan

  INDEXED LOOKUP (WHERE scanId=? using an index that starts with scanId)

    root ──► interior ──► leaf page with scanId="abc" rows
    O(log n) page reads, proportional to tree height

  FULL TABLE SCAN (no usable index)

    page 1 → page 2 → page 3 → ... → page N
    every page/row checked; O(n) reads
```

### Move 2 — the actual indexes in this schema, one at a time

**`Shop_shopDomain_key` — a unique index doing double duty.** Every `unique` field in Prisma becomes a `CREATE UNIQUE INDEX`, so `shopDomain` gets both a uniqueness constraint *and* a fast lookup path for free:

```prisma
// app/prisma/schema.prisma:38
shopDomain     String    @unique
```

Every authenticated request resolves its shop via this exact index (`resolveShopOrThrow`, `app/app/services/scan/scan-api.server.ts:100-106`, `prisma.shop.findUnique({ where: { shopDomain } })`) — this is the single most frequently hit index in the whole schema.

**`Scan_shopId_status_idx` — composite, built for one specific query shape.** `(shopId, status)` in that order exists because `getActiveScan` filters on both together:

```ts
// app/app/services/scan/queue.server.ts:28-33
export async function getActiveScan(shopId: string): Promise<Scan | null> {
  return prisma.scan.findFirst({
    where: { shopId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}
```

Confirmed with the real query plan against this repo's own database (`app/prisma/dev.sqlite`):

```
EXPLAIN QUERY PLAN
SELECT * FROM Scan WHERE shopId=? AND status IN (...) ORDER BY createdAt DESC LIMIT 1;

|--SEARCH Scan USING INDEX Scan_shopId_status_idx (shopId=? AND status=?)
`--USE TEMP B-TREE FOR ORDER BY
```

The `shopId`/`status` filter is fully index-served — but notice the second line: **`createdAt` isn't part of the index**, so SQLite still has to build a small temporary sort structure to satisfy `ORDER BY createdAt DESC`. Harmless here because the filtered result set per shop is tiny (a handful of rows at most), but it's the exact mechanism that gets expensive at larger row counts: the index narrows the *candidate set*, then a separate sort step orders what's left.

**`Finding_scanId_severity_idx` and `Finding_scanId_severityRank_checkId_idx` — two indexes on overlapping columns, on purpose.** The schema comments explain why a *second* composite index was added on top of the first rather than just widening it:

```prisma
// app/prisma/schema.prisma:94-97 (comment) + 123-124
// Denormalized rank of `severity` (CRITICAL=0, WARNING=1, UNAVAILABLE=2),
// populated at persist time so findings can be ORDER BY'd in SQL instead
// of sorted in memory (spec §11.2).
@@index([scanId, severity])
@@index([scanId, severityRank, checkId])
```

`severity` is a string (`"CRITICAL"`, `"WARNING"`, `"UNAVAILABLE"`) — sorting strings alphabetically does **not** produce the wanted order (CRITICAL, WARNING, UNAVAILABLE isn't alphabetical). So the schema adds a parallel **integer** column, `severityRank`, purely so its natural ascending sort order matches the desired severity order, and indexes *that* instead. This is the load-bearing move in this whole file: **a secondary index only helps a sort if the column's natural order matches the wanted order** — when it doesn't (a string encoding a custom priority), the fix is a new column, not a fancier index.

Confirmed index-covered in practice — the actual `getScanFindings` query:

```ts
// app/app/services/scan/scan-api.server.ts:264-270
const total = await prisma.finding.count({ where });
const rows = await prisma.finding.findMany({
  where,
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
  skip: (page - 1) * pageSize,
  take: pageSize,
});
```

```
EXPLAIN QUERY PLAN
SELECT * FROM Finding WHERE scanId=? ORDER BY severityRank ASC, checkId ASC LIMIT 50 OFFSET 0;

`--SEARCH Finding USING INDEX Finding_scanId_severityRank_checkId_idx (scanId=?)
```

No `TEMP B-TREE FOR ORDER BY` line — the index's key order (`scanId, severityRank, checkId`) already matches both the filter *and* the sort, so SQLite walks the index leaf-to-leaf in the exact order the page needs, no separate sort step at all. That's the entire payoff of the denormalized `severityRank` column, made visible in the query plan.

And the `count(*)` call above is even cheaper than a lookup — it's answered entirely from the index, never touching the `Finding` table's own pages:

```
EXPLAIN QUERY PLAN
SELECT COUNT(*) FROM Finding WHERE scanId=?;

`--SEARCH Finding USING COVERING INDEX Finding_scanId_severityRank_checkId_idx (scanId=?)
```

A **covering index** is one where every column the query needs is already present in the index itself, so the engine never has to follow the index entry back to the full row. `scanId` is the filter and no other column is selected (`COUNT(*)`), so the index alone answers the whole question.

**The index this schema doesn't have.** `getScanFindings`'s free-text search filters on `searchText`:

```ts
// app/app/services/scan/scan-api.server.ts:254-262
const search = opts.search?.trim().toLowerCase();
if (search) {
  where.searchText = { contains: search };
}
```

```
EXPLAIN QUERY PLAN
SELECT * FROM Finding WHERE scanId=? AND searchText LIKE '%foo%';

`--SEARCH Finding USING INDEX Finding_scanId_severityRank_checkId_idx (scanId=?)
```

Same index, same plan as before — because the `scanId` filter is still there. But look closely: the plan only mentions `scanId=?`. The `searchText` `contains` (compiled to SQL `LIKE '%foo%'`, a leading wildcard) can **never** use a B-tree index — a B-tree is only useful for prefix or range matches, and a leading `%` means "match anywhere in the string," which requires reading every character of every candidate row. So this query is index-accelerated down to "the rows in this one scan" (already a small set, since a scan's findings are capped), then linearly scanned for the text match. That's fine at this schema's row counts (a single scan's findings, not the whole table) — it would not be fine as a general full-text search primitive, which is a different index type (an FTS5 virtual table in SQLite) this schema doesn't use and doesn't need yet.

**`Session` has no secondary index at all.** Verified directly:

```
PRAGMA index_list(Session);
0|sqlite_autoindex_Session_1|1|pk|0     -- only the primary key (id)
```

`Session` is looked up by `shop` (offline access token per shop domain, via `@shopify/shopify-app-session-storage-prisma`'s `findSessionsByShop`) on effectively every authenticated request — and there is no index on that column. At this app's scale (one session row per installed shop, likely dozens to low thousands of rows) a full scan of `Session` is cheap enough not to matter in practice, but it's the one place in this schema where "no index" wasn't a deliberate choice documented anywhere — it's simply the shape `@shopify/shopify-app-session-storage-prisma`'s generated schema template ships with.

### Move 3 — the principle

An index is a promise about *one specific access shape* — filter columns, sort columns, and their order, baked into a physical structure ahead of time. This schema's two `Finding` indexes exist because two different query shapes (`WHERE scanId, ORDER BY severity` vs. `WHERE scanId, ORDER BY severityRank, checkId`) needed two different physical orderings — you can't fake one from the other by squinting at a single composite index. The corollary the missing-index cases above teach: an index that doesn't match a query's leading filter or that can't help a wildcard text match isn't wrong to be missing — it just means that access path costs a scan, and the job is knowing which scans are cheap (bounded by `scanId`) and which would be expensive at scale (unbounded, cross-tenant).

## Primary diagram

```
  Every index in this schema, what it serves, and what it costs

  Shop_shopDomain_key                  UNIQUE  → resolveShopOrThrow() lookups
  ShopSettings_shopId_key              UNIQUE  → 1:1 join key
  Scan_shopId_status_idx               (shopId,status)  → getActiveScan()
                                          ORDER BY createdAt → TEMP SORT (small set, OK)
  Finding_scanId_severity_idx          (scanId,severity) → legacy/simple severity filter
  Finding_scanId_severityRank_checkId  (scanId,severityRank,checkId)
                                          → getScanFindings() — INDEX-COVERED SORT, no temp B-tree
                                          → count(*) — COVERING INDEX, never touches table
  Session: (none besides PK)           → shop-domain lookup is an unindexed scan
```

## Elaborate

The B-tree-only world of SQLite is narrower than Postgres (which adds hash indexes, GiST for geometric/full-text data, BRIN for huge append-only tables) — but the underlying lesson transfers everywhere: an index's key order is a contract with specific queries, not a general accelerator. The `severity` → `severityRank` denormalization in this repo is the same move a Postgres schema makes when it adds a generated/computed column purely so an index can sort by it — same problem (string sort order doesn't match the wanted order), same fix (encode the order numerically), different engine.

## Interview defense

**Q: "Would adding an index on `Finding.severity` alone (no `scanId` prefix) speed anything up?"**
A: No — every real query in this codebase always filters by `scanId` first (a scan's findings are always scoped to one scan). An index on `severity` alone would only help a query that filters across *all* scans by severity, which doesn't exist here; it would just be extra write cost for zero read benefit.

**Q: "Why does `getScanFindings`'s free-text search still work reasonably well with no dedicated search index?"**
A: Because the `scanId` filter (which *is* indexed) already narrows the row set down to one scan's findings before the unindexed `LIKE '%...%'` match runs — the expensive part (linear text scan) only ever touches a small, pre-filtered set, never the whole `Finding` table.

```
  cheap because the expensive part runs on a small set

  Finding_scanId_severityRank_checkId_idx narrows to ONE scan's rows
                    │
                    ▼
       LIKE '%search%' linear scan — but only over THAT small set
```

## See also

- `02-records-pages-and-storage-layout.md` — the page/byte cost of these same four indexes, measured.
- `04-query-planning-and-execution.md` — the full `EXPLAIN QUERY PLAN` walkthrough, including the one query in this codebase that has *no* usable index at all.
