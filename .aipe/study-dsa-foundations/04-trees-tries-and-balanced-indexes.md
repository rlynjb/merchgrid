# 04 — Trees, tries, and balanced indexes

### Hierarchies, ordered structures, prefix search, and balanced index trees — Industry standard

## Zoom out, then zoom in

MerchGrid's data has an obvious hierarchy — a shop has scans, a scan has
findings — but you will not find a `TreeNode` class anywhere in this repo.
The hierarchy is entirely expressed as foreign keys in `schema.prisma`, and
the one real "tree" doing work in this system is invisible: the B-tree
SQLite builds behind a composite index, which is what makes `ORDER BY
severityRank` a query, not a scan. This file teaches both halves honestly —
the ownership hierarchy that's real but never walked by application code,
and the balanced index that's real and *is* load-bearing every time a
findings page loads.

```
Zoom out — where hierarchy and indexes live

┌─ Storage layer — SQLite via Prisma ───────────────────────────────┐
│  Shop ──1:N──► Scan ──1:N──► Finding                               │
│    (schema.prisma:36-125, onDelete: Cascade at every level)        │
│  ★ @@index([scanId, severityRank, checkId]) — a B-tree ★           │
│                                                    ← we are here    │
└──────────────────────────┬─────────────────────────────────────────┘
                            │ ORDER BY exploits the index
┌─ Service layer — scan-api.server.ts ────────────────────────────────┘
│  getScanFindings(): pagination relies on the index being ordered   │
└──────────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** the ownership hierarchy (Shop → Scan → Finding, enforced by
foreign keys) is a different structure from the balanced index (a B-tree
over `Finding` columns, enforced by SQLite's storage engine) — they live in
the same schema file but answer completely different questions.

**Axis to trace: control — who decides "delete everything under this
node," and who decides "give me these rows in order"?**

```
"Who's in control?" — two different tree-shaped things, two different owners

┌─ ownership tree ───────────────┐   ┌─ balanced index ────────────────┐
│ decided by: Prisma's            │   │ decided by: SQLite's query       │
│   onDelete: Cascade              │   │   planner, using the B-tree      │
│ control: the DATABASE ENGINE     │   │ control: the QUERY PLANNER       │
│   walks parent→children and      │   │   walks the index instead of a   │
│   deletes bottom-up, app code     │   │   full table scan when the        │
│   never issues the child deletes │   │   WHERE/ORDER BY matches its      │
│                                   │   │   column order                    │
└──────────────────────────────────┘   └───────────────────────────────────┘
```

**Seam:** the ownership tree and the balanced index don't share a code path
at all — one is enforced at the schema level (`onDelete: Cascade`), the
other at the query level (`orderBy`/`where` matching an `@@index`). The
place they *do* interact: `Finding.shopId` is deliberately duplicated
(denormalized) rather than reached via a join through `Scan` — the comment
at `schema.prisma:88-90` names this explicitly: "no relation/index by
design... so shop-scoped finding queries and retention cleanup can filter
without joining through Scan." That's a seam where a "cleaner" normalized
tree (no duplicate `shopId`) was traded for a flatter, faster query path
during GDPR retention cleanup.

## How it works

### Move 1 — the mental model

You've built a component tree in React — parent renders children, unmounting
a parent tears down every child underneath it. `onDelete: Cascade` is the
same idea at the database layer: deleting a `Shop` row tells SQLite "also
delete everything that points at this row, and everything that points at
*that*." A balanced index (B-tree) is a different, unrelated idea you also
already know the shape of: a sorted structure that lets you find or range-
scan in `O(log n)` instead of checking every row.

```
Pattern — cascade delete as a tree walk (engine-owned, not app-owned)

  Shop (deleted)
    │
    ├─► Scan A ──► Finding, Finding, Finding    (cascade)
    │              ScanArtifact                  (cascade)
    ├─► Scan B ──► Finding, Finding              (cascade)
    └─► ShopSettings                              (cascade)

  app code issues ONE delete (on Shop); SQLite's foreign-key
  engine walks the tree bottom-up and deletes every dependent row.
```

### Move 2 — the walkthrough

**The ownership tree — three cascade relations, one per level.**
`schema.prisma` declares the parent-child edges directly on the child model:

```prisma
# app/prisma/schema.prisma:52 (ShopSettings → Shop)
shop  Shop  @relation(fields: [shopId], references: [id], onDelete: Cascade)

# app/prisma/schema.prisma:62 (Scan → Shop)
shop  Shop  @relation(fields: [shopId], references: [id], onDelete: Cascade)

# app/prisma/schema.prisma:87 (Finding → Scan)
scan  Scan  @relation(fields: [scanId], references: [id], onDelete: Cascade)

# app/prisma/schema.prisma:130 (ScanArtifact → Scan)
scan  Scan  @relation(fields: [scanId], references: [id], onDelete: Cascade)
```

Each line is one edge in a two-level tree (`Shop → {Scan, ShopSettings}` and
`Scan → {Finding, ScanArtifact}`). What breaks if you remove `onDelete:
Cascade` from just the `Finding → Scan` edge: deleting a `Scan` (or, via the
next level up, a whole `Shop` during GDPR redaction) would fail with a
foreign-key constraint violation — every `Finding` row is a leaf that has to
go *before* its parent, and cascade is what makes that ordering automatic
instead of something app code has to sequence by hand (delete findings,
then artifacts, then the scan, then settings, then the shop). Context.md's
GDPR flow (`shop/redact` cascades a delete) depends on exactly this: one
`prisma.shop.delete()` call, and the tree underneath it disappears in the
right order without a single explicit child-delete statement in application
code.

**The balanced index — what makes `ORDER BY` cheap.** Without an index,
`ORDER BY severityRank, checkId` on a large `Finding` table means SQLite
reads every row and sorts them at query time — `O(n log n)` per query, every
time. The composite index changes that:

```prisma
# app/prisma/schema.prisma:124
@@index([scanId, severityRank, checkId])
```

SQLite indexes are B-trees: a balanced, ordered structure where each node
holds sorted keys and pointers to children, keeping every leaf at the same
depth so a lookup or range scan costs `O(log n)` regardless of which key you
want. Because the index's column order is `(scanId, severityRank,
checkId)` — matching exactly what `getScanFindings` filters and sorts by —
SQLite can walk directly to the `scanId`'s subtree and read rows *already in
severity order*, no separate sort step needed:

```ts
// app/app/services/scan/scan-api.server.ts:264-270
const total = await prisma.finding.count({ where });          // uses the same index for the count
const rows = await prisma.finding.findMany({
  where,                                                       // { scanId } (+ optional severity/checkId/search)
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],       // matches the index's column order
  skip: (page - 1) * pageSize,
  take: pageSize,                                               // the index lets SQLite skip straight to this page
});
```

The boundary condition that would break this: if `where.search` is set
(line 261's `searchText: { contains: search }`), that filter is *not* part
of the index's column list — SQLite still uses the index to narrow by
`scanId` and to get pre-sorted rows, but the `contains` check itself falls
back to scanning the matched rows rather than an index seek. That's an
accepted, documented tradeoff (the comment at
`scan-api.server.ts:256-261` explains the `searchText` column exists
precisely to make this a SQL-level filter instead of loading everything into
memory — not to make search itself index-accelerated).

**Execution trace — an index seek vs. a full scan, same query, two paths:**

```
Execution trace — getScanFindings(scanId="s1", severity=undefined)

WHERE scanId = 's1'
ORDER BY severityRank ASC, checkId ASC
LIMIT 50 OFFSET 0

WITHOUT the @@index([scanId, severityRank, checkId]):
  1. read all N rows in Finding (full table scan)         cost: O(N)
  2. filter to scanId = 's1'                               cost: O(N)
  3. sort the matched rows by (severityRank, checkId)       cost: O(k log k), k = matched rows
  4. take the first 50                                      cost: O(1)
  total: dominated by the O(N) full scan

WITH the index:
  1. B-tree seek to the 's1' subtree                        cost: O(log N)
  2. rows under 's1' are ALREADY in (severityRank, checkId) order
  3. walk 50 leaves forward from the start of that subtree  cost: O(50)
  total: O(log N + 50) — independent of total Finding rows across ALL scans
```

### Move 3 — the principle

**A tree is either a hierarchy your application code owns and walks, or a
balanced structure your storage engine owns and hides from you — and
knowing which one you're looking at changes who's responsible for its
correctness.** MerchGrid never writes a tree-traversal algorithm because
neither of its trees needs one from application code: the ownership tree is
walked by SQLite's foreign-key engine, and the balanced index is walked by
SQLite's query planner. The only place application-level tree logic would
have to exist is if a hierarchy needed to be traversed with domain-specific
logic no database engine can express generically.

## Primary diagram

```
Trees, tries, and balanced indexes — the full picture

┌─ ownership tree (foreign keys, cascade delete) ──────────────────┐
│  Shop ──► Scan ──► Finding                                        │
│       └─► ShopSettings   └─► ScanArtifact                          │
│  walked by: SQLite's FK engine, on ONE delete statement            │
└────────────────────────────────────────────────────────────────────┘

┌─ balanced index (B-tree) ─────────────────────────────────────────┐
│  @@index([scanId, severityRank, checkId])                          │
│  seek: O(log n)   range scan: O(log n + page size)                 │
│  makes ORDER BY + pagination cheap without an in-memory sort       │
└────────────────────────────────────────────────────────────────────┘

  not yet exercised: tries (no prefix/autocomplete feature — search is a
  SQL substring `contains`, not a trie walk); general in-app tree
  structures (the product→variant hierarchy is fixed at exactly two
  levels, never modeled as a recursive tree type).
```

## Elaborate

Balanced trees (B-trees, B+trees, red-black trees, AVL trees) all solve the
same underlying problem — keep a sorted structure's height logarithmic in
its size so lookups, inserts, and range scans stay `O(log n)` even as the
structure grows — and every mainstream relational database's default index
type is some flavor of B-tree for exactly that reason. Tries solve a
narrower, different problem: fast prefix matching over strings (think
autocomplete, IP routing tables, or a spell-checker's dictionary). MerchGrid
has no feature that needs prefix matching — its one text-search feature
(`searchText` `contains`) is substring matching anywhere in the string, which
a trie doesn't accelerate the way it accelerates a *prefix* query. If a
future feature needed "type-ahead search over SKUs as the merchant types,"
that's exactly where a trie (or its DB-side cousin, a full-text index) would
belong — a different structure for a different access pattern, not an
upgrade of the current substring search.

## Interview defense

**Q: "Where's the tree traversal in this codebase?"**
A: There isn't one written in application code, and that's not an
oversight — it's because both tree-shaped structures here are owned by
SQLite. The ownership hierarchy (Shop → Scan → Finding) is walked by the
database engine's cascade-delete logic on a single `DELETE` statement; the
balanced index behind `@@index([scanId, severityRank, checkId])` is walked
by the query planner on every `SELECT … ORDER BY`. Application code issues
one statement in either case and never touches the tree structure directly.
*(sketch: the two-box primary diagram above)*
One-line anchor: **the tree is real; the traversal is the database's job,
not the app's.**

**Q: "Why is `Finding.shopId` duplicated instead of joined through `Scan`?"**
A: A deliberate denormalization, documented at `schema.prisma:88-90`:
shop-scoped queries and GDPR retention cleanup need to filter findings by
shop without a join through `Scan`. It trades a slightly larger row (one
extra string column) and a small update-consistency responsibility (nothing
currently updates `shopId` after insert, so there's no drift risk in
practice) for a simpler, faster query path on the hottest per-tenant read.
One-line anchor: **denormalization here isn't sloppiness — it's a named
tradeoff for a specific query pattern (tenant-scoped reads without a join).**

## See also

- `03-stacks-queues-deques-and-heaps.md` — the priority ordering that the
  same B-tree index accelerates.
- `.aipe/study-system-design/06-single-machine-shared-volume.md` — the
  deployment context for why this is a single SQLite file, not a
  distributed index.
