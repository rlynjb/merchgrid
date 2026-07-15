# Data modeling red-flags audit

### Consolidated checklist — Capstone

## Zoom out, then zoom in

```
  Zoom out — this file's job

  ┌─ 01 shape ──┐ ┌─ 02 norm ──┐ ┌─ 03 index ──┐ ┌─ 04 tx ──┐ ┌─ 05 migr ──┐ ┌─ 06 access ──┐
  │  findings    │ │  findings   │ │  findings    │ │ findings │ │  findings   │ │  findings     │
  └──────┬──────┘ └──────┬─────┘ └──────┬──────┘ └────┬─────┘ └──────┬─────┘ └──────┬───────┘
         └───────────────┴──────────────┴─────────────┴─────────────┴──────────────┘
                                          │
                                          ▼
                          ★ THIS FILE ★ — one checklist,
                          every red flag from the spec,
                          marked pass/fail/partial against
                          this specific repo
```

Every concept file before this one dug into one slice of the schema. This file is the flat scorecard: every red flag the data-modeling spec defines, checked against MerchGrid's actual schema, migrations, and query sites — with a verdict and a pointer back to where the full walkthrough lives.

## Structure pass

**Axis: for each red flag, is it present, absent, or present-but-mitigated?**

```
  red flag                                    verdict
  ─────────────────────────────────────────────────────────────
  no discernible model                     →  ABSENT
  same fact editable in two places          →  ABSENT (one dead copy, not editable-in-two-places)
  hot query, no supporting index            →  PRESENT, mitigated by a size cap
  multi-write, no transaction               →  PRESENT (one case), mitigated by low concurrency
  destructive migration, no rollback        →  PRESENT (no down-migrations), mitigated by small tables
  storage shape fighting access pattern      →  ABSENT
```

Two flags are cleanly absent, none are catastrophically present, and three are present-but-currently-safe — each one safe *because of* a specific, named guardrail elsewhere in the system rather than by accident. That "present but mitigated, and the mitigation is named" pattern is the throughline of this whole audit.

## How it works

### Red flag 1 — no discernible model (everything in one JSON blob / one table)

**Verdict: ABSENT.**

Five entities (`Shop`, `ShopSettings`, `Scan`, `Finding`, `ScanArtifact`, plus the Shopify-template `Session`), each mapping to a real domain noun, each with its own primary key and its own set of columns shaped for what it actually represents. `Finding.evidenceJson` is the one column that's a JSON blob (`schema.prisma:103`) — and that's deliberate, not a modeling failure: evidence shape varies per check (`MG-001` through `MG-010` each produce different evidence fields), so a fixed relational shape for evidence would mean ten different nullable-column families or a separate `Evidence` table per check type, for data that's write-once and read as a whole object, never queried by individual evidence field. One flexible column for a genuinely variable-shape, never-filtered blob is the right call, not the anti-pattern this flag is looking for. See `01-the-data-model-and-its-shape.md`.

### Red flag 2 — the same fact editable in two places

**Verdict: ABSENT**, with one asterisk.

`minimumMarginPercentUsed` (on `Scan`) and `minimumMarginPercent` (on `ShopSettings`) look like the same fact stored twice, but they answer different questions (current threshold vs. historical snapshot) and only one of them — `ShopSettings.minimumMarginPercent` — is ever updated after creation; `Scan.minimumMarginPercentUsed` is write-once at enqueue time. That's not two editable copies of one fact; it's one editable fact and one frozen historical record. The asterisk: `Finding.shopId` is a genuine copy of `Scan.shopId` with no independent write path (it's set once, at persist time, from `Scan`'s own shop, and never touched again) — so it can't drift, but it's also never read by anything, which makes it dead weight rather than an active risk. Full walkthrough: `02-normalization-and-duplication.md`.

### Red flag 3 — a frequent query with no supporting index

**Verdict: PRESENT (two instances), both mitigated by a row-count cap rather than by an index.**

- `getScanFindings`'s free-text `search` filter (`where.searchText = { contains: search }`, `scan-api.server.ts:261`) has no index on `searchText`, and `LIKE '%term%'` couldn't use one anyway (leading wildcard). Mitigated by `scanId` being filtered first through an indexed column, and by `ShopSettings.catalogVariantLimit` capping how many findings a single scan can ever produce.
- `claimAndRunNext`'s `WHERE status = 'QUEUED'` (`worker-core.server.ts:34-38`) has no index starting with `status` alone. Mitigated by the single-worker model keeping `QUEUED` rows transient and the `Scan` table small.

Full walkthrough, including exactly which composite indexes *do* cover the dominant query shapes: `03-indexing-vs-query-patterns.md`.

### Red flag 4 — a multi-write operation with no transaction

**Verdict: PRESENT (one case), the rest are properly transactional.**

The finding-persist step (delete stale findings → insert fresh findings → mark scan COMPLETED, `runner.server.ts:187-207`) is correctly wrapped in `prisma.$transaction([...])` — this is the exemplar, not the flag. The flag fires on `enqueueScan`'s "is there already an active scan" check followed by `scan.create` (`queue.server.ts:44-78`) — two separate round trips, no transaction, no unique constraint backing the invariant, and a documented TOCTOU race as a result. Mitigated today by the single-worker model and by API-layer request serialization per merchant session; the code comment names the exact DB-level fix (a partial unique index) that would close it properly. Full walkthrough: `04-transactions-and-integrity.md`.

### Red flag 5 — a destructive migration with no rollback plan

**Verdict: PRESENT (structurally — no down-migrations exist for any of the five), but no migration has actually destroyed data.**

Two migrations (`scan_partial`, `finding_search_rank`) use SQLite's full-table-rebuild pattern (drop + recreate + reinsert), and neither generates a Prisma down-migration — recovery from a bad migration would mean restoring from a Fly volume snapshot or writing a new forward migration. Every migration that touches existing rows either supplies a safe default (`scan_partial`'s `partial BOOLEAN DEFAULT false`) or a real, verified backfill (`finding_search_rank`'s `severityRank`/`searchText` computed via SQL that mirrors `severity.ts`'s logic). Nothing here has actually corrupted or lost data — the flag is about the *absence of a rollback path*, which is real, not about a migration having gone wrong. Full walkthrough: `05-migrations-and-evolution.md`.

### Red flag 6 — a relational schema fighting a document-shaped (or vice versa) access pattern

**Verdict: ABSENT.**

The write pattern (rare, single-row writes from the web process; serialized, one-scan-at-a-time bulk inserts from the one worker process) and the read pattern (frequent, small, indexed, paginated reads) both fit a single-writer, multi-reader engine cleanly — and SQLite is exactly that. The schema's relational shape (five normalized-with-deliberate-denormalization tables, real foreign keys, real indexes) matches how the data is actually queried; there's no sign of a document-shaped access pattern (fetch-everything-by-one-key, no filtering) being forced into rigid relational tables, or the reverse. Full walkthrough, including the honest "not applicable" call on local-first/sync concerns: `06-access-patterns-and-storage-choice.md`.

## Primary diagram

```
  The full scorecard

  ┌────┬──────────────────────────────────────────┬───────────────────────────┐
  │ #  │ red flag                                  │ verdict                    │
  ├────┼──────────────────────────────────────────┼───────────────────────────┤
  │ 1  │ no discernible model                      │ ABSENT                     │
  │ 2  │ same fact editable in two places           │ ABSENT (1 dead, harmless   │
  │    │                                            │   copy: Finding.shopId)    │
  │ 3  │ hot query, no supporting index             │ PRESENT ×2, size-capped    │
  │ 4  │ multi-write, no transaction                 │ PRESENT ×1 (enqueueScan),  │
  │    │                                            │   documented + low-risk    │
  │ 5  │ destructive migration, no rollback          │ PRESENT (no down-migrations│
  │    │                                            │   anywhere), never fired   │
  │ 6  │ storage shape fights access pattern          │ ABSENT                     │
  └────┴──────────────────────────────────────────┴───────────────────────────┘
```

## Elaborate

Read across all six flags, the pattern in this codebase isn't "no risk" — it's "every present risk is named in a code comment, at the exact call site, with the specific condition under which it would stop being safe." That's a meaningfully different engineering posture than either pretending the risks don't exist or gold-plating fixes nobody's traffic currently justifies. The one place worth watching as this product grows past MVP: the moment a second worker process or genuine concurrent-write load enters the picture, three of these mitigations (`enqueueScan`'s race, `claimAndRunNext`'s missing index, the RedefineTables migration cost) all become live simultaneously, because they all lean on the same underlying assumption — one worker, one writer, small tables. That's not a coincidence; it's the same axis (single-writer serialization) showing up as the mitigation for three separate flags. Track that one assumption, and you're tracking the actual scaling ceiling of this schema.

## Interview defense

**Q: If you had to fix exactly one thing in this schema before it scaled past MVP, what would it be?**
A: The partial unique index closing `enqueueScan`'s TOCTOU race — `CREATE UNIQUE INDEX ... ON Scan(shopId) WHERE status NOT IN ('COMPLETED','FAILED')`. It's the one invariant enforced only in application code where a real correctness bug (duplicate concurrent scans) rather than just a performance concern is the failure mode, and the fix is already named in the code's own comment.

**Q: What's the one assumption this whole audit keeps coming back to?**
A: Single-writer serialization — one worker process, one scan drained at a time. It's what makes the missing index on `Scan.status` safe, what makes the `enqueueScan` race low-impact, and what makes SQLite the right engine choice at all. It's a single point of scaling failure hiding behind three separate-looking mitigations.

**Q: Is this schema production-ready?**
A: Yes, for its current scale and its current single-worker model — every present risk is bounded by a named, true guardrail, not by luck. It would need the partial-unique-index fix (and a rethink of the worker's claim query) before taking on genuine concurrent scan execution across many shops at once.

## See also

- `00-overview.md` — the three highest-cost findings, restated at a glance.
- `01` through `06` — the full walkthrough behind every verdict in this file's scorecard.
