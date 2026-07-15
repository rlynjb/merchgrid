# Migrations and evolution

### Schema migration / online schema change discipline — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where schema evolution happens

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  unaffected — routes don't know the schema's history        │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ────────────▼─────────────────────────────────┐
  │  start-production.js runs `prisma migrate deploy` before      │
  │  starting web + worker — every boot, on the one running       │
  │  machine                                                       │
  └───────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ────────────▼─────────────────────────────────┐
  │  ★ THIS CONCEPT ★ — 5 migrations, app/prisma/migrations/       │
  │  each either purely additive or carrying a real backfill       │
  └────────────────────────────────────────────────────────────┘
```

A migration is the one place a schema mistake becomes expensive to undo — code is cheap to change, a migration that already ran against live data is not. This repo has five migrations, in a clean append-only sequence, and they split cleanly into two shapes: simple `ADD COLUMN` changes SQLite handles natively, and full-table-rebuild changes that SQLite forces whenever you need something a plain `ALTER TABLE` can't do (a `NOT NULL` column with no default, or Prisma's column-ordering).

## Structure pass

**Axis: does this migration touch existing rows, and if so, does it carry a backfill or does it risk leaving them wrong?**

```
  migration                          touches existing rows?   backfill included?
  ──────────────────────────────────────────────────────────────────────────────
  20240530213853_create_session       no  (new table)          n/a
  20260715004357_domain_models        no  (new tables)          n/a
  20260715015512_scan_partial         yes (rebuild)             default only (false)
  20260715024309_finding_variant      yes (in place)            no rows to backfill (nullable)
  20260715172521_finding_search_rank  yes (rebuild)              YES — real SQL backfill
```

The seam: two of the five migrations rebuild their table from scratch (SQLite's only way to do certain `ALTER TABLE` operations), and only the last one actually needed to compute new values for existing rows — and it does so correctly, in SQL, in the same migration. That's the one migration in this repo worth reading closely; the rest are either additive-safe or trivially covered by a default.

## How it works

### Migration 1 & 2 — additive, zero risk

```sql
-- 20240530213853_create_session_table/migration.sql (Shopify CLI template)
CREATE TABLE "Session" ( ... );
```

```sql
-- 20260715004357_domain_models/migration.sql
CREATE TABLE "Shop" ( ... );
CREATE TABLE "ShopSettings" ( ... );
CREATE TABLE "Scan" ( ... );
CREATE TABLE "Finding" ( ... );
CREATE TABLE "ScanArtifact" ( ... );
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
CREATE UNIQUE INDEX "ShopSettings_shopId_key" ON "ShopSettings"("shopId");
CREATE INDEX "Scan_shopId_status_idx" ON "Scan"("shopId", "status");
CREATE INDEX "Finding_scanId_severity_idx" ON "Finding"("scanId", "severity");
```

New tables, new indexes. Nothing pre-existing is touched, so there's no data to corrupt and no lock contention beyond creating the table itself. This is the safest possible migration shape — it can run against a live database with zero risk to existing rows, because there are no existing rows in these tables yet.

### Migration 3 — `scan_partial`: SQLite's `RedefineTables` pattern, for the first time

```sql
-- 20260715015512_scan_partial/migration.sql
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" ( ... same columns ..., "partial" BOOLEAN NOT NULL DEFAULT false, ... );
INSERT INTO "new_Scan" (...) SELECT ... FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_shopId_status_idx" ON "Scan"("shopId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
```

**Bridge from what you know:** this is the same shape as `ALTER TABLE ... ADD COLUMN` in a database that doesn't support in-place column addition at all — you build a new table with the shape you want, copy every row across, and swap the names. SQLite technically *does* support `ADD COLUMN`, but Prisma's migration engine reaches for this full-rebuild pattern (its "RedefineTables" step) whenever the change is more than a trailing nullable column — here, inserting `partial` in the middle of the column list to match `schema.prisma`'s declared order, rather than appending it at the end, forces a rebuild because SQLite's native `ADD COLUMN` can only append.

**What this costs, named plainly:** for the duration of this migration, `Scan` doesn't exist as `Scan` — it's dropped and recreated under a new name with the old data reinserted. `PRAGMA foreign_keys=OFF` is there specifically so the child tables (`Finding`, `ScanArtifact`) don't reject their rows for pointing at a momentarily-nonexistent parent (`ScanArtifact.scanId` and `Finding.scanId` both FK into `Scan`) during that window. On a large table this is a full-table copy holding whatever lock SQLite uses for the operation, for however long the copy takes — there is no incremental or online path here. It's free today because `Scan` is a small table (one row per audit run this app has ever executed) — this stops being free the moment `Scan` accumulates into the millions of rows, which is a meaningfully different failure mode than a typical Postgres `ADD COLUMN ... DEFAULT` (which is metadata-only in modern Postgres and doesn't rewrite the table at all).

### Migration 4 — `finding_variant_fields`: pure additive, the safe version of the same problem

```sql
-- 20260715024309_finding_variant_fields/migration.sql
ALTER TABLE "Finding" ADD COLUMN "barcode" TEXT;
ALTER TABLE "Finding" ADD COLUMN "compareAtPrice" TEXT;
ALTER TABLE "Finding" ADD COLUMN "currencyCode" TEXT;
ALTER TABLE "Finding" ADD COLUMN "price" TEXT;
ALTER TABLE "Finding" ADD COLUMN "productStatus" TEXT;
ALTER TABLE "Finding" ADD COLUMN "sku" TEXT;
ALTER TABLE "Finding" ADD COLUMN "unitCost" TEXT;
```

Seven columns added, every one of them nullable with no default. This is the shape that SQLite's native `ADD COLUMN` handles directly — no rebuild, no `RedefineTables`, because a nullable column with no computed value for existing rows is exactly the case `ADD COLUMN` was built for: every pre-existing `Finding` row simply gets `NULL` in these seven columns, which is a correct answer (those findings genuinely don't have this data — it didn't exist on the row before this migration). Compare this directly against migration 3: the difference between an in-place `ADD COLUMN` and a full-table `RedefineTables` isn't about how many columns you're adding, it's about whether the new column can be nullable-with-no-default (safe, in-place) or needs `NOT NULL`/a specific position (rebuild).

### Migration 5 — `finding_search_rank`: the one that needed a real backfill

```sql
-- 20260715172521_finding_search_rank/migration.sql
/*
  Warnings:
  - Added the required column `severityRank` to the `Finding` table without a default value. This is not possible if the table is not empty.
*/
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Finding" ( ... "severityRank" INTEGER NOT NULL, ... "searchText" TEXT NOT NULL DEFAULT '', ... );

INSERT INTO "new_Finding" (..., "severityRank", ..., "searchText")
SELECT
  ...,
  CASE "severity" WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'UNAVAILABLE' THEN 2 ELSE 2 END,
  ...,
  LOWER(TRIM(
    "productTitle" ||
    COALESCE(' ' || NULLIF("variantTitle", ''), '') ||
    COALESCE(' ' || NULLIF("sku", ''), '') ||
    COALESCE(' ' || NULLIF("barcode", ''), '')
  ))
FROM "Finding";

DROP TABLE "Finding";
ALTER TABLE "new_Finding" RENAME TO "Finding";
CREATE INDEX "Finding_scanId_severity_idx" ON "Finding"("scanId", "severity");
CREATE INDEX "Finding_scanId_severityRank_checkId_idx" ON "Finding"("scanId", "severityRank", "checkId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
```

Prisma's own generated warning comment states the actual constraint driving the whole migration shape: `severityRank` is `NOT NULL` with no default, and the table isn't guaranteed empty — so a plain `ADD COLUMN` is impossible (SQLite would have no value to put in existing rows). The migration has to do three things in the *same* statement that would otherwise be three separate steps in a bigger system: rebuild the table with the new required column, and **compute the new column's value for every existing row inline, in the `INSERT ... SELECT`.**

Line up the backfill SQL against the application code it has to match exactly:

```ts
// app/app/services/scan/severity.ts:13-17
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0, WARNING: 1, UNAVAILABLE: 2,
};
```
```sql
-- the migration's backfill, same mapping, expressed as SQL
CASE "severity" WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 WHEN 'UNAVAILABLE' THEN 2 ELSE 2 END
```

```ts
// app/app/services/scan/severity.ts:32-39
export function buildSearchText(parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}
```
```sql
-- the migration's backfill, same logic, expressed as SQL
LOWER(TRIM(
  "productTitle" ||
  COALESCE(' ' || NULLIF("variantTitle", ''), '') || ...
))
```

This is the real thing an "online migration discipline" section is looking for: **the migration's SQL and the application's TypeScript compute the identical value by two independent routes, and they had to be kept in sync by hand.** That's a genuine risk pattern — if `severity.ts`'s ranking ever changes (say, a new severity level is added) without someone remembering that a *future* migration touching this table would need matching backfill logic, the two would silently drift. There's no test in this repo that asserts the migration's `CASE` expression and `SEVERITY_RANK` agree — that's worth naming as the one gap in an otherwise well-executed backfill.

### Migration ordering and when they actually run

```ts
// app/start-production.js (per .aipe/project/context.md's description; supervisor script)
// runs migrations, then starts web + worker on one Fly machine
```

Per the deploy constraints, migrations run in the container's entrypoint on every boot of the single Fly machine — not in a separate Fly `release_command`, and there is deliberately no `[processes]` block in `fly.toml` that would split web and worker onto machines that couldn't share the SQLite volume. That means migration-then-serve is a hard sequencing guarantee baked into how the process starts, not a CI-time step that could theoretically race against the app booting with an old schema.

## Primary diagram

```
  The five migrations, by risk shape

  additive, zero risk            rebuild, default-covered        rebuild, real backfill
  ┌──────────────────┐          ┌────────────────────┐          ┌───────────────────────┐
  │ create_session    │          │ scan_partial         │          │ finding_search_rank    │
  │ domain_models      │          │ (DEFAULT false       │          │ (severityRank via CASE,│
  │ (CREATE TABLE only)│          │  covers old rows)    │          │  searchText via SQL     │
  └──────────────────┘          └────────────────────┘          │  string-building)       │
                                                                  └───────────────────────┘
  in-place, zero risk
  ┌──────────────────┐
  │ finding_variant_   │
  │ fields (7x nullable│
  │ ADD COLUMN)        │
  └──────────────────┘

  all 5: no down-migrations generated; recovery path is forward-only
```

## Elaborate

The general principle SQLite forces you to confront explicitly (where Postgres often hides it): **"can I add this column in place" is a question with a real, mechanical answer** — nullable-with-no-default, yes; `NOT NULL`-with-no-default against a non-empty table, no, you must rebuild and backfill in the same breath. Postgres engineers get to forget this distinction because modern Postgres makes `ADD COLUMN ... DEFAULT` metadata-only regardless of table size; SQLite (and older Postgres, and MySQL before certain versions) make you feel the cost directly, as a full-table copy. The transferable lesson: know which category your migration engine puts a given `ALTER TABLE` into before running it against a table with real data in it — "it's just adding a column" is not always true.

## Interview defense

**Q: Why did adding `severityRank` require a full-table rebuild instead of a plain `ADD COLUMN`?**
A: It's `NOT NULL` with no default, and the `Finding` table wasn't guaranteed empty. SQLite's `ADD COLUMN` can only append a column with a value it can supply for every existing row (a constant default, or `NULL` for a nullable column) — it has no way to compute a per-row value like "0 if severity is CRITICAL, 1 if WARNING." Prisma's migration engine handles that by building a new table, backfilling the column via `INSERT ... SELECT` with a `CASE` expression, and swapping table names.

```
  old Finding table            new_Finding table (with severityRank backfilled)
  ┌──────────────┐   INSERT    ┌──────────────────────────┐
  │ severity:    │  SELECT     │ severity: 'WARNING'       │
  │  'WARNING'   │ ──CASE───►  │ severityRank: 1  (computed│
  └──────────────┘             │   inline during the copy) │
                                └──────────────────────────┘
        DROP old, RENAME new → Finding
```

**Q: What's the risk in that backfill migration specifically?**
A: The `CASE` expression in the SQL and the `SEVERITY_RANK` map in `severity.ts` encode the identical mapping through two independent code paths — SQL and TypeScript — with nothing testing that they agree. If the severity ranking ever changes in application code, a future migration touching this table would need to remember to update matching backfill logic by hand; there's no automated check that would catch a drift.

**Q: These migrations have no down-migration — how would you roll one back?**
A: You wouldn't, automatically — Prisma's migration history here is forward-only, and recovery from a bad migration means either restoring the SQLite file from the Fly volume's daily snapshot or writing a new forward migration that undoes the change. That's an accepted trade for a single-tenant-per-deploy SQLite app with small tables; it would be a much bigger gap on a table too large to safely rebuild twice in a row.

## See also

- `01-the-data-model-and-its-shape.md` — the five entities these migrations built up incrementally.
- `02-normalization-and-duplication.md` — `severityRank`/`searchText`, the columns this migration backfills, and why they're stored instead of computed at read time.
- `04-transactions-and-integrity.md` — the partial-unique-index fix for the "one active scan" race would itself require a migration; it hasn't been written yet.
