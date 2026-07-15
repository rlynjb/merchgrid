# Data modeling audit — MerchGrid: Catalog Audit

This is the audit at a glance: the schema as it actually exists on disk (`app/prisma/schema.prisma`), the entity-relationship shape it forms, the three findings that would cost the most if left alone, and a one-line verdict per concept. Every concept file behind this one goes deep on one slice; this file is the map.

## The schema, as one picture

```
  MerchGrid entity-relationship model — SQLite via Prisma

  ┌─ Session ───────────────┐   Shopify template model.
  │ id (PK)                 │   shop: TEXT, no FK to Shop.id —
  │ shop: TEXT               │   predates Shop (see 01, migration order)
  │ accessToken (encrypted) │
  └─────────────────────────┘

  ┌─ Shop ──────────────────┐        1:1        ┌─ ShopSettings ──────────┐
  │ id (PK, cuid)           │◄──────────────────┤ id (PK)                 │
  │ shopDomain UNIQUE       │  shopId UNIQUE FK  │ shopId UNIQUE FK ───────┤
  │ installStatus           │  ON DELETE CASCADE │ minimumMarginPercent    │
  │ installedAt/uninstalledAt│                   │ catalogVariantLimit    │
  └───────────┬─────────────┘                    └─────────────────────────┘
              │ 1:N
              │ shopId FK, ON DELETE CASCADE
              ▼
  ┌─ Scan ──────────────────────────────────────────────────────┐
  │ id (PK, cuid)         status (TEXT, no CHECK — state.ts     │
  │ shopId FK             guards it in app code)                │
  │ minimumMarginPercentUsed  ← snapshot, NOT a copy of         │
  │                             ShopSettings (see 02)           │
  │ partial, counts, timestamps, failureCode/failureMessageSafe │
  │ @@index([shopId, status])                                   │
  └───────────┬──────────────────────────────┬──────────────────┘
              │ 1:N                          │ 1:N
              │ scanId FK, CASCADE           │ scanId FK, CASCADE
              ▼                              ▼
  ┌─ Finding ────────────────────────┐  ┌─ ScanArtifact ────────┐
  │ id (PK, cuid)                    │  │ id (PK, cuid)         │
  │ scanId FK                        │  │ scanId FK             │
  │ shopId  ← duplicated from Scan,  │  │ type, storageKey      │
  │   documented, NEVER queried      │  │ expiresAt             │
  │   (see 02 — dead denormalization)│  │ ★ zero call sites —   │
  │ severityRank, searchText         │  │   not yet exercised   │
  │   ← derived, backfilled, indexed │  └───────────────────────┘
  │ price/compareAtPrice/unitCost/   │
  │ sku/barcode/productStatus        │
  │   ← point-in-time copy, deliberate
  │ @@index([scanId, severity])      │
  │ @@index([scanId, severityRank,   │
  │           checkId])              │
  └───────────────────────────────────┘
```

Five entities, one SQLite file (`app/prisma/schema.prisma:11-14`, `app/fly.toml:26`), one writer process at a time (see `06-access-patterns-and-storage-choice.md`).

## The three highest-cost findings

**1. "One active scan per shop" is enforced by application code with a documented TOCTOU race, not by the database.** `enqueueScan` (`app/app/services/scan/queue.server.ts:44-78`) checks `getActiveScan` then creates a `Scan` row — two round trips, no transaction, no partial unique index behind it. The code comment (lines 54-62) names the race and accepts it for MVP because a single worker process drains the queue. It is the right call today; it stops being the right call the moment a second worker or a retried client request enters the picture. See `04-transactions-and-integrity.md`.

**2. `Finding.shopId` is a denormalization that was paid for but never spent.** The schema comment (`app/prisma/schema.prisma:88-90`) says it exists so "shop-scoped finding queries and retention cleanup can filter without joining through Scan." A repo-wide search for `shopId` on `Finding` queries turns up zero call sites — no retention job, no shop-scoped finding query exists yet. The column is populated on every write (`runner.server.ts:159`) and read by nothing. That's not a bug (a copy that's never read can't drift), but it is schema weight with no current payoff. See `02-normalization-and-duplication.md`.

**3. `ScanArtifact` is a fully-modeled, fully-cascaded table with no reader or writer anywhere in the app.** It has a real shape (`type`, `storageKey`, `expiresAt`) and a real cascade from `Scan` (`app/prisma/schema.prisma:127-135`), but no route, service, or test creates or queries it. It is scaffolding for a feature (export/artifact storage) that has not shipped. Marked `not yet exercised` — see `01-the-data-model-and-its-shape.md`.

## One-line verdict per concept

| # | Concept | Verdict |
|---|---|---|
| 01 | The data model and its shape | Five clean entities matching real domain nouns (Shop, Scan, Finding); `Session` is the one outlier (Shopify template, no FK to `Shop`) and `ScanArtifact` is modeled but unexercised. |
| 02 | Normalization and duplication | Two deliberate, documented, well-justified denormalizations (Finding's display-field copy, severityRank/searchText) and one dead one (`Finding.shopId`). |
| 03 | Indexing vs query patterns | The hot path (`getScanFindings`) is well-indexed; the free-text `search` filter and the worker's `status='QUEUED'` claim query are not — both currently cheap because table sizes are small, but worth a mental flag. |
| 04 | Transactions and integrity | The finding-persist step is a genuine ACID transaction (delete+insert+complete atomically); the "one active scan" invariant is application-only with an acknowledged race. |
| 05 | Migrations and evolution | Five migrations, each additive or accompanied by a real backfill; SQLite's `RedefineTables` full-table-rebuild pattern shows up twice and is currently free only because the tables are small. |
| 06 | Access patterns and storage choice | Single SQLite writer matches a single-worker, serial-write / many-read access pattern — the engine choice fits the workload it was chosen for. |
| 07 | Red-flags audit | Consolidated checklist — see the file for the full pass/fail table. |

Read `01` through `07` in order; each is self-contained but builds on the entities named here.
