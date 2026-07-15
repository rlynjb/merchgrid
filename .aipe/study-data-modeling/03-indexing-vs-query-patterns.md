# Indexing vs query patterns

### Index-to-query matching / covering indexes — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the index either saves you or doesn't

  ┌─ UI layer ─────────────────────────────────────────────┐
  │  results table: page + filter + search + sort controls  │
  └───────────────────────────┬─────────────────────────────┘
                              │  getScanFindings(opts)
  ┌─ Service layer ───────────▼─────────────────────────────┐
  │  scan-api.server.ts builds a Prisma `where` + `orderBy`  │
  └───────────────────────────┬─────────────────────────────┘
                              │  SQL
  ┌─ Storage layer ───────────▼─────────────────────────────┐
  │  ★ THIS CONCEPT ★ — does an @@index exist that matches   │
  │  the WHERE + ORDER BY this query actually issues?         │
  └──────────────────────────────────────────────────────────┘
```

An index is a bet that a specific query shape will run often enough to be worth the write-time cost of maintaining it. This file walks every `@@index` in the schema next to the query that's supposed to use it, and flags the two query shapes in this codebase that currently have no supporting index at all.

## Structure pass

**Axis: for each hot query, does the index cover the `WHERE` clause, the `ORDER BY`, or neither?**

```
  Query               →  WHERE covered?   ORDER BY covered?   verdict
  ──────────────────────────────────────────────────────────────────────
  getScanFindings      →  scanId: yes       severityRank: yes   COVERED
    (severity/checkId)    severity: yes*    checkId: yes
  getScanFindings       →  searchText: NO    n/a                 UNCOVERED
    (free-text search)
  getActiveScan         →  shopId+status: yes  createdAt: no     PARTIAL (fine — tiny table)
  claimAndRunNext       →  status alone: NO    createdAt: no     UNCOVERED (fine — tiny table, today)
```

The seam: two queries are genuinely uncovered by any index, and both are uncovered for the same underlying reason — SQLite's `contains`/equality on a `TEXT` column without an index degrades to a full scan of the matching rows. Both are currently cheap only because the tables involved are small by construction (a scan's findings are capped by `catalogVariantLimit`, and `Scan` rows are one per audit run, not one per catalog item). That's the load-bearing detail: these aren't index gaps that happen to be safe, they're index gaps that are safe *because of* a separate guardrail (the variant-limit cap) — worth knowing which guardrail you're leaning on.

## How it works

### The indexes as they exist

```prisma
// app/prisma/schema.prisma — every @@index and @unique in the schema
Shop.shopDomain          @unique                              // line 38
ShopSettings.shopId      @unique                               // line 51
Scan   @@index([shopId, status])                               // line 81
Finding @@index([scanId, severity])                             // line 123
Finding @@index([scanId, severityRank, checkId])                // line 124
```

Five indexes total (three composite/single `@@index`, two `@unique`). `Session` has no secondary indexes at all — it's looked up by primary key or by the Shopify session-storage adapter's own contract, at volumes too small to matter.

### Case 1: `getScanFindings`'s default path — a genuinely covering index

```ts
// app/app/services/scan/scan-api.server.ts:247-270
const where: Prisma.FindingWhereInput = { scanId: scan.id };
if (opts.severity) { where.severity = opts.severity; }
if (opts.checkId) { where.checkId = opts.checkId; }
...
const total = await prisma.finding.count({ where });
const rows = await prisma.finding.findMany({
  where,
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
  skip: (page - 1) * pageSize,
  take: pageSize,
});
```

Every filter/sort combination this function actually builds when `search` is absent — `scanId` always, `severity` optionally, `checkId` optionally, `orderBy severityRank, checkId` always — is a strict subset of the composite index `@@index([scanId, severityRank, checkId])` (`schema.prisma:124`). SQLite can walk that index left-to-right: filter to the scan, walk in already-sorted `severityRank, checkId` order, apply the optional `checkId` equality filter as a range restriction within that walk, and stop once `pageSize` rows are collected — no separate sort step, no full table scan. This is the textbook shape of "the index was designed after the query it serves," and the migration history confirms it: this exact composite index was added in the same migration (`20260715172521_finding_search_rank`) that added the `severityRank` column, specifically to support this query.

The `severity` filter uses the *other* index, `@@index([scanId, severity])` (`schema.prisma:123`), which looks redundant next to the three-column composite until you notice it's the one Prisma reaches for when a caller filters by `severity` directly (rather than sorting by `severityRank` and filtering by `checkId`) — both indexes exist because both filter shapes are real call sites (the UI's severity-tab filter uses one path; the default findings list uses the other).

### Case 2: the free-text `search` filter — uncovered by design, bounded by a different guardrail

```ts
// app/app/services/scan/scan-api.server.ts:254-262
const search = opts.search?.trim().toLowerCase();
if (search) {
  // `searchText` is a lowercased, space-joined concatenation of
  // productTitle/variantTitle/sku/barcode, populated at persist time (see
  // runner.server.ts). Lowercasing the query here + the stored column at
  // write time gives us case-insensitive search via SQLite's
  // case-sensitive `contains` (spec §11.2: no in-memory filtering).
  where.searchText = { contains: search };
}
```

`{ contains: search }` compiles to SQL `LIKE '%term%'` — a leading wildcard, which no B-tree index (SQLite has no other kind here) can use to narrow the scan. Even though `searchText` isn't indexed at all, this still isn't a table-wide scan: the `scanId` equality filter in the same `where` object is still covered by the composite index, so SQLite narrows to *this scan's findings* first (via the index), then does the `LIKE` scan only across that already-narrow row set. The guardrail that makes this acceptable isn't an index — it's `ShopSettings.catalogVariantLimit` (`schema.prisma:54`, default 5000), which caps how many variants a single scan can ever produce findings for, which caps how many rows the unindexed `LIKE` scan ever touches. Raise that limit by an order of magnitude and this specific query is the first place you'd feel it.

### Case 3: `getActiveScan` — index covers the filter, not the tiebreak

```ts
// app/app/services/scan/queue.server.ts:28-33
export async function getActiveScan(shopId: string): Promise<Scan | null> {
  return prisma.scan.findFirst({
    where: { shopId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
}
```

`@@index([shopId, status])` (`schema.prisma:81`) covers the `where` clause exactly — `shopId` equality, `status` set-membership. It doesn't cover `orderBy createdAt`, so once SQLite has narrowed to "this shop's non-terminal scans" (a set that's 0 or 1 rows in the common case, because `enqueueScan` rejects a second active scan — see `04`), it still has to sort whatever it found by `createdAt` without index help. That's a non-issue in practice: the index has already done the expensive part (narrowing from "every scan ever run" to "this shop's active scans"), and sorting a handful of rows in memory costs nothing.

### Case 4: `claimAndRunNext` — the one query with no supporting index at all

```ts
// app/app/services/scan/worker-core.server.ts:34-38
const scan = await prisma.scan.findFirst({
  where: { status: "QUEUED" },
  orderBy: { createdAt: "asc" },
  include: { shop: true },
});
```

No index in the schema starts with `status` alone — `@@index([shopId, status])` is only useful when `shopId` is also known, and this query doesn't know it (it's asking "what's the oldest queued scan *across every shop*"). Every poll of the worker loop does a full scan of the `Scan` table filtering for `status = 'QUEUED'`. Today that's free: the code comment right above this (`worker-core.server.ts:22-28`) explains this is a **single-worker model** — one process, one poll loop, draining scans one at a time — so the `Scan` table never grows large relative to a scan's own lifetime; queued rows are transient. If a second worker process or a much higher scan-submission rate ever enters the picture, this is the first query that would need `@@index([status, createdAt])` — and per that same comment, a second worker would need more than an index anyway (an atomic conditional claim, not a `findFirst`, to avoid two workers claiming the same row).

## Primary diagram

```
  Every query in this codebase against every index that could serve it

  Finding@@index([scanId,severity])          Finding@@index([scanId,severityRank,checkId])
        ▲                                            ▲
        │ serves severity-filter reads               │ serves default paginated list
        │                                             │
  getScanFindings(severity=X) ──┐         ┌── getScanFindings() default path
                                 │         │
                     Finding.searchText ◄──┘── getScanFindings(search=X)
                     (NO INDEX — bounded by catalogVariantLimit instead)

  Scan@@index([shopId,status])
        ▲
        │ covers WHERE, not ORDER BY createdAt
        │
  getActiveScan(shopId) ── (fine: result set is 0-1 rows post-filter)

  (no index starts with status alone)
        ▲
        │
  claimAndRunNext() ── full Scan-table scan for status='QUEUED'
                        (fine today: single worker, transient QUEUED rows)
```

## Elaborate

The general lesson: an index is only as good as its match to the actual `WHERE`/`ORDER BY` shape, and "no index" is not automatically a bug — it's a bug only when the table it scans is unbounded. Both uncovered queries in this codebase (`searchText` and `status='QUEUED'`) are safe *today* because something else in the system (a variant-count cap, a single-worker model) keeps the scanned row-set small — but that safety is borrowed from a different mechanism, not earned by the index layer itself. When auditing a schema, the right question for an unindexed hot path isn't just "is there an index" — it's "what currently keeps this table small, and what happens when that stops being true."

## Interview defense

**Q: `Finding.searchText` isn't indexed — is that a problem?**
A: Not currently, because the `scanId` filter in the same query is indexed and narrows the row set first — the unindexed `LIKE` scan only ever runs across one scan's findings, which is bounded by `catalogVariantLimit` (default 5000, and typically far fewer findings than variants). It would become a problem if that cap were raised by an order of magnitude, since `LIKE '%term%'` can't use a B-tree index regardless of table size.

**Q: The worker's `claimAndRunNext` query has zero supporting indexes — walk me through why that's acceptable right now.**
A: It filters `Scan` by `status = 'QUEUED'` with no index starting with `status` alone. That's safe because of the single-worker model — one process polling one queue means `QUEUED` rows are transient and the `Scan` table stays small relative to any single scan's lifetime. It stops being safe if a second worker process is introduced, and per the code's own comment, a second worker needs more than an index fix anyway — the `findFirst` would need to become an atomic conditional `UPDATE ... WHERE status='QUEUED'` to avoid two workers claiming the same row.

**Q: What makes `@@index([scanId, severityRank, checkId])` a *covering* index for the default findings query, not just *an* index?**
A: It matches the `WHERE scanId = ?` filter and the `ORDER BY severityRank, checkId` in the same left-to-right column order, so SQLite can walk the index directly in output order and stop after `pageSize` rows — no separate sort step, no scan past the page boundary.

## See also

- `02-normalization-and-duplication.md` — `severityRank`/`searchText` exist specifically to make this indexing possible; see why they're stored instead of computed at read time.
- `04-transactions-and-integrity.md` — the single-worker assumption that makes `claimAndRunNext`'s missing index safe is the same assumption behind the "one active scan per shop" TOCTOU trade.
