# Records, pages, and storage layout

### B-tree page storage (industry standard) — Project-specific: `app/prisma/dev.sqlite`, `app/prisma/schema.prisma`

## Zoom out — the bigger picture

`03` and `04` are about indexes and query plans — both live *inside* the thing this file explains: the actual bytes on disk.

```
  Zoom out — where storage layout sits

  ┌─ ORM ────────────────────────────────────────────────────┐
  │  PrismaClient issues SQL against logical tables/columns    │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Storage engine ──────────▼────────────────────────────────┐
  │  ★ THIS FILE: SQLite pages, B-tree layout, row packing ★     │ ← we are here
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Disk ─────────────────────▼────────────────────────────────┐
  │  /data/prod.sqlite — one physical file                       │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

Every row you insert with `prisma.finding.create(...)` doesn't get its own little file — it gets packed into a fixed-size **page** (this repo's pages are 4096 bytes, verified: `PRAGMA page_size` on `app/prisma/dev.sqlite` returns `4096`), and pages are organized into a **B-tree** per table, keyed by the table's rowid (or, for `INTEGER PRIMARY KEY` columns, the primary key itself). Every index is a *second*, separate B-tree over the same rows, keyed by the indexed columns. That second B-tree is not free — it's why `03` treats "add an index" as a cost decision, not just a lookup optimization, and this file is where you see that cost in real bytes.

## The structure pass

**Axis: what does adding one row, or one index, actually cost in bytes?** Trace it from the schema declaration down to the physical page count — this is directly measurable in this repo's own `dev.sqlite`, not hypothetical.

```
  One axis — "what does persisting this row cost?" — down the stack

  ┌──────────────────────────────────┐
  │ schema.prisma column list         │  logical: field names + types
  └──────────────────────────────────┘
        │
  ┌─────▼──────────────────────────────┐
  │ SQLite table B-tree (main storage) │  physical: one row = one leaf entry
  └────────────────────────────────────┘
        │
  ┌─────▼──────────────────────────────┐
  │ each @@index(...) — its own B-tree │  physical: SAME row, ANOTHER entry,
  │                                      │  in a SEPARATE tree
  └──────────────────────────────────────┘

  seam: every index in schema.prisma is a second (or third, or fourth)
  physical structure that every INSERT/UPDATE must also maintain.
```

The seam is exactly where `Finding` lives in this schema: it carries **two** secondary indexes (`app/prisma/schema.prisma:123-124`) plus its own table B-tree plus a hidden `sqlite_autoindex` for its text primary key. Every finding insert touches four B-trees, not one — measured below.

## How it works

### Move 1 — the mental model

You've built a `.map()` over an array before — cheap, because the array is already in memory in one contiguous block. A database table on disk is the opposite: rows don't sit contiguously waiting for you, they're scattered across pages that a B-tree indexes so a lookup can jump straight to the right page instead of scanning the whole file. That's the entire job of the storage layer: turn "find row X" into "walk a tree of height ~3-4, not a linear scan of the whole file."

```
  Pattern — a B-tree page structure (SQLite table B-tree)

           ┌─────────────┐
           │  root page   │   holds pointers + boundary keys
           └──────┬───────┘
        ┌─────────┼─────────┐
   ┌────▼───┐ ┌────▼───┐ ┌────▼───┐
   │interior │ │interior │ │interior │   more pointers + keys
   └────┬────┘ └────┬────┘ └────┬────┘
        │           │           │
   ┌────▼────┐ ┌────▼────┐ ┌────▼────┐
   │leaf page │ │leaf page │ │leaf page │   ACTUAL ROW DATA lives here,
   │(rows)    │ │(rows)    │ │(rows)    │   packed 4096 bytes at a time
   └──────────┘ └──────────┘ └──────────┘
```

### Move 2 — walking the real numbers from this repo

**Page size and file shape — observed, not assumed.** Running `PRAGMA` queries directly against `app/prisma/dev.sqlite`:

```
page_size:      4096   -- bytes per page (SQLite's default; never
                            configured anywhere in this repo)
page_count:     45     -- the ENTIRE database file is 45 pages = 184,320 bytes
freelist_count: 9      -- 9 pages currently unused (deleted rows freed
                            them, but the file hasn't shrunk — see below)
auto_vacuum:    0      -- OFF. Freed pages are NOT reclaimed back to the OS;
                            the file only grows over time unless VACUUMed
```

**What that means concretely:** this app has run enough test scans/findings churn (134 `Finding` rows, 14 `Scan` rows, 19 `Shop` rows at the time this was measured) to accumulate 9 free pages that `auto_vacuum=0` will never hand back to the filesystem on its own. Not a crisis at 45 pages — but "the file only grows" is worth knowing before assuming SQLite files self-compact.

**Per-table/per-index byte cost — the part most engineers never actually see.** SQLite exposes its own storage stats through the `dbstat` virtual table. Querying it against this repo's own `Finding` table:

```
SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
FROM dbstat GROUP BY name ORDER BY bytes DESC;

Finding                                    36864 bytes   (9 pages)  ← the table itself
sqlite_autoindex_Finding_1                 12288 bytes   (3 pages)  ← hidden PK index (text id)
Finding_scanId_severity_idx                12288 bytes   (3 pages)  ← @@index([scanId, severity])
Finding_scanId_severityRank_checkId_idx    12288 bytes   (3 pages)  ← @@index([scanId, severityRank, checkId])
```

Read that as: for 134 rows, the table's *own* storage is 9 pages, and its two declared indexes (`app/prisma/schema.prisma:123-124`) cost 3 pages *each* — on top of the primary-key index SQLite creates automatically for every `TEXT` primary key (`sqlite_autoindex_Finding_1`). **Every `Finding` insert is really four B-tree writes, not one.** That's the real, measured cost behind the design comment at `app/prisma/schema.prisma:94-97` explaining why `severityRank` is denormalized onto the row instead of computed at read time — the team already paid for one extra index; they made it pay for something (SQL `ORDER BY` without a temp sort — see `04`) rather than adding a second uncompensated one.

**Row packing — why the denormalized `Finding` columns aren't "waste."** `Finding` deliberately duplicates `price`, `compareAtPrice`, `unitCost`, `currencyCode`, `sku`, `barcode`, `productStatus` onto every finding row (`app/prisma/schema.prisma:107-110`), rather than joining back to a `variants` table that doesn't exist. The comment is explicit about why:

```ts
// app/prisma/schema.prisma:107-110
// Denormalized per-variant fields, copied from the CatalogSnapshot at scan
// time (never re-fetched later). Deliberately NOT the whole catalog — just
// enough for the CSV export and finding-detail UI to be self-contained
// (spec §9.5/§9.6) without persisting unrelated, non-flagged variants.
```

In storage-layout terms: this is a decision to spend more bytes *per row* (wider leaf pages, more pages per table) in exchange for zero extra B-tree lookups at read time — the CSV export (`export.server.ts`) and the finding-detail UI read one row and are done, instead of joining out to a second table's B-tree for every finding. That's the classic denormalization tradeoff, paid for in page bytes and visible in the `dbstat` numbers above.

**Migrations that rewrite the whole table.** SQLite's `ALTER TABLE` is limited — it can't add a `NOT NULL` column with no default to a non-empty table, and it can't easily change column ordering or constraints. When Prisma's migration engine needs to do that, it doesn't patch the B-tree in place — it rebuilds the entire table:

```sql
-- app/prisma/migrations/20260715172521_finding_search_rank/migration.sql:7-35
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Finding" ( ... "severityRank" INTEGER NOT NULL, ... );
INSERT INTO "new_Finding" (...) SELECT ... FROM "Finding";   -- copies every row
DROP TABLE "Finding";
ALTER TABLE "new_Finding" RENAME TO "Finding";
```

This is a full copy of every existing row into a brand-new table and a brand-new B-tree — not a fast operation at scale, and it's why the same migration also computes `severityRank` and `searchText` for every pre-existing row inline in the `INSERT ... SELECT` (lines 42-55 of that file), backfilling the new NOT-NULL columns as part of the rebuild rather than in a second pass. Contrast that with `20260715024309_finding_variant_fields/migration.sql`, which only adds *nullable* columns with no default — SQLite handles that as a genuinely cheap, in-place `ALTER TABLE ADD COLUMN`, no rebuild required. **The lesson: whether a migration is O(1) or O(rows) in SQLite depends entirely on whether the new column is nullable/no-default** — the rebuild-or-not decision is invisible from the Prisma schema diff alone; you have to read the generated SQL.

```
  Comparison — cheap ALTER vs. full table rebuild, same migration tool

  CHEAP (nullable column, no rebuild)      EXPENSIVE (NOT NULL, needs backfill)
  ┌────────────────────────────┐           ┌────────────────────────────┐
  │ ALTER TABLE Finding          │           │ CREATE new_Finding           │
  │   ADD COLUMN sku TEXT;       │           │ INSERT INTO new_Finding      │
  │ (in-place, O(1))             │           │   SELECT ... FROM Finding;  │
  └────────────────────────────┘           │ DROP TABLE Finding;          │
                                              │ RENAME new_Finding→Finding; │
                                              │ (full copy, O(rows))         │
                                              └────────────────────────────┘
       migration 20260715024309                  migration 20260715172521
```

### Move 3 — the principle

Storage layout is where "logical schema" and "physical cost" stop being the same conversation. A schema-level decision — add a column, add an index, denormalize a field onto a row — has a page-and-byte cost that's invisible in Prisma's schema file but fully visible in `dbstat` and the generated migration SQL. The discipline this repo follows (and names in its own comments) is: only pay that cost when it buys something concrete — an SQL-level sort order, a self-contained export row — never "just in case."

## Primary diagram

```
  Storage layout, end to end — this repo's real numbers

  ┌─ Logical (schema.prisma) ──────────────────────────────────────┐
  │  model Finding { severityRank Int; searchText String; ... }      │
  └───────────────────────────┬───────────────────────────────────┘
                              │ compiled to
  ┌─ Physical (SQLite file) ───▼───────────────────────────────────┐
  │  Finding table B-tree:                     9 pages / 36,864 B    │
  │  sqlite_autoindex_Finding_1 (PK):          3 pages / 12,288 B    │
  │  Finding_scanId_severity_idx:               3 pages / 12,288 B    │
  │  Finding_scanId_severityRank_checkId_idx:  3 pages / 12,288 B    │
  │  page_size=4096, auto_vacuum=OFF (freed pages not reclaimed)      │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same core idea every B-tree-backed engine (Postgres's heap+btree, MySQL's InnoDB clustered index, SQLite's rowid B-tree) shares: pages are the unit of I/O, and every index is a second physical structure that write operations must keep in sync. SQLite's specific twist — no separate buffer pool/background writer process, `dbstat` exposed as a queryable virtual table rather than a DBA dashboard, and rebuild-based ALTER TABLE — comes from being a library, not a server (see `01`). The next file (`03`) picks up exactly where this one stops: given that every index costs pages and write time, which indexes does this schema actually have, and why.

## Interview defense

**Q: "Why does adding a database index cost anything besides disk space?"**
A: Because an index is its own B-tree, not a lookup table layered for free on top of the existing rows. `03` pages of extra storage for `Finding_scanId_severity_idx` alone, measured with `dbstat` on this repo's own database — and every insert/update/delete has to maintain that second tree in lockstep with the table's own.

```
  one row written → N B-trees updated

  Finding row  ──►  Finding table B-tree
              ──►  sqlite_autoindex_Finding_1 (PK)
              ──►  Finding_scanId_severity_idx
              ──►  Finding_scanId_severityRank_checkId_idx
```

**Q: "Is a schema migration that adds a column always cheap?"**
A: Not in SQLite. Adding a nullable column with no default is an in-place `ALTER TABLE ADD COLUMN` (cheap, this repo's `20260715024309` migration). Adding a `NOT NULL` column requires SQLite to rebuild the entire table — copy every row into a new table, drop the old one, rename — which is what this repo's `20260715172521` migration actually does, backfilling the new column's values inline during the copy.

## See also

- `03-btree-hash-and-secondary-indexes.md` — the index structures introduced here, examined for lookup behavior and selection.
- `study-data-modeling` — whether the denormalized `Finding` columns are the *right* shape for the access patterns (this file only covers what they cost in bytes).
