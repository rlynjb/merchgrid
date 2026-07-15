# Project context — MerchGrid: Catalog Audit

## What it is
A **read-only embedded Shopify admin app** (publisher "Buffr Studio") that audits a merchant's product catalog for pricing, margin, SKU, and barcode problems using **10 deterministic checks** (MG-001…MG-010) — no LLM/AI. The merchant installs it, runs an on-demand scan, and gets a prioritized, explainable findings report; it never modifies the store. Full product spec: `merchgrid-catalog-audit-product-spec.md` (repo root). Implementation plan: `docs/superpowers/plans/2026-07-14-merchgrid-catalog-audit.md`.

## Stack
- **Runtime:** Node 22, TypeScript, ESM.
- **Web:** Remix (Vite) + Shopify App Bridge + **Polaris** UI, via `@shopify/shopify-app-remix`. Served by `remix-serve`.
- **Data:** Prisma ORM over **SQLite** (dev, test, and prod — prod uses a file on a Fly volume). Sessions via `@shopify/shopify-app-session-storage-prisma`.
- **Background work:** a long-running Node **worker** process that drains a DB-backed scan queue.
- **Engine:** two pure, Shopify-independent workspace packages under `app/packages/` (`@merchgrid/catalog-core`, `@merchgrid/catalog-checks`) — compiled to `dist` for runtime, aliased to `src` in tests.
- **Tests:** Vitest. `@shopify/shopify-api` pinned to a single version via `overrides` in `app/package.json`.

## Architecture (three layers)
1. **Engine** — `app/packages/`. Pure functions, zero I/O, no Shopify/Prisma imports.
   - `catalog-core`: `NormalizedVariant`/`CatalogSnapshot` types, `normalizeCatalog(raw)` (raw Shopify GraphQL nodes → normalized), admin-URL + GID handling.
   - `catalog-checks`: the 10 checks (`src/checks/mg-0NN.ts`), decimal money helpers (`money.ts`, uses `decimal.js` — **never floats for money**), `runChecks(ALL_CHECKS, ctx)`, CSV serializer (`csv.ts`), the `CatalogCheck`/`CatalogFinding`/`CatalogCheckContext` contract.
   - Designed for reuse by a planned future "MerchGrid: Bulk AI" product (changeset preflight).
2. **App** — `app/app/`.
   - `routes/` — UI (`app._index.tsx` onboarding, `app.scans.$id.tsx` progress+results, `app.settings.tsx`), API resource routes (`api.scans*.tsx`), webhooks (`webhooks.app.uninstalled.tsx`, `webhooks.compliance.tsx`, `webhooks.app.scopes_update.tsx`), `healthz.tsx`.
   - `services/scan/` — the pipeline: `catalog-reader.server.ts` (Shopify GraphQL, paginated, variant-limit guardrail, rate-limit retry) → `runner.server.ts` (`runScan`: read→normalize→runChecks→persist, atomic `$transaction`, failure-safe) → `queue.server.ts` (`enqueueScan`, one-active-per-shop) → `worker-core.server.ts` (`claimAndRunNext`) → `state.ts` (scan state machine). Plus `scan-api.server.ts` (per-shop-authz'd reads: `getScanFindings` SQL-paginated, `getAllFindingsForExport`) and `export.server.ts`.
   - `services/session/` — `EncryptedSessionStorage` (AES-256-GCM at-rest token encryption) + `token-crypto.server.ts`.
   - `models/` — `shop.server.ts` (`ensureShop`, `redactShop`, `markShopUninstalled`), `settings.server.ts`.
   - `shopify.server.ts` — `shopifyApp()` config (scopes, webhooks, `afterAuth`, session storage), `db.server.ts` (Prisma client), `config.ts` (`CATALOG_API_VERSION`).
   - `worker.ts` — the worker entrypoint (poll loop; obtains an offline admin via `unauthenticated.admin(shop)`).
3. **Deploy** — `app/fly.toml`, `app/Dockerfile`, `app/start-production.js` (supervisor: runs migrations then web + worker on one Fly machine), `app/DEPLOY.md` (runbook). Live at https://merchgrid-catalog-audit.fly.dev.

## Data model (Prisma — `app/prisma/schema.prisma`)
- `Session` — Shopify offline access tokens (template model; tokens encrypted at rest when `SESSION_ENCRYPTION_KEY` is set).
- `Shop` — install status, shopDomain (unique). `ShopSettings` — `minimumMarginPercent` (0–90, default 20), `catalogVariantLimit` (default 5000). Cascade delete.
- `Scan` — status (QUEUED→READING_CATALOG→RUNNING_CHECKS→PREPARING_RESULTS→COMPLETED | FAILED), counts, `partial`, `minimumMarginPercentUsed`, `apiVersion`, timestamps, failure fields.
- `Finding` — one per detected issue: checkId, severity (CRITICAL/WARNING/UNAVAILABLE), product/variant ids+titles, adminUrl, `evidenceJson` (String), explanation, `detectedAt`, plus denormalized display fields (price/compareAtPrice/unitCost/currency/sku/barcode/productStatus) and `severityRank`/`searchText` (for SQL sort/filter/paginate). `@@index([scanId, severityRank, checkId])`.
- `ScanArtifact` — optional export/temp storage (cascade from Scan).

## Key flows
- **Install:** OAuth → `afterAuth` → `ensureShop` creates Shop+ShopSettings; offline session stored (encrypted).
- **Scan:** onboarding action → `enqueueScan` (QUEUED) → worker `claimAndRunNext` → `runScan` (readCatalog → normalize → runChecks → persist Findings, atomic; partial/failure-safe) → results route polls `getScanSummary`/`getScanFindings`.
- **Export:** `/api/scans/:id/export` → `getAllFindingsForExport` (authz + status gate) → engine `findingsToCsv`.
- **Uninstall / GDPR:** `webhooks.app.uninstalled` marks shop UNINSTALLED (retains data); `webhooks.compliance` handles the 3 mandatory GDPR topics (`shop/redact` cascades a delete).

## How to run / test / verify
- Local app: `cd app && npm run dev` (web) + `npm run worker` (worker). SQLite dev DB.
- Tests: `cd app && npm test` (132 app tests) · `cd app/packages && npx vitest run` (83 engine tests).
- **Golden eval:** `cd app && npm run eval` — 17 fixtures × expected findings through the real normalize→runChecks pipeline (independently-specified, mutation-verified).
- Typecheck: `cd app && npx tsc --noEmit -p tsconfig.json` (clean). Lint: `npm run lint`.
- Fixture seeder (separate write-token script): `app/scripts/seed-fixtures.ts`.

## Must-not-change constraints
- **READ-ONLY.** Scopes are `read_products,read_inventory` only. NO write scopes, NO product/inventory mutations anywhere in the app. (The fixture seeder is a separate standalone script with its own write token — never the app's creds.)
- **Money is decimal.** Never use floats/`Number()`/`parseFloat` for price/margin — use `catalog-checks/money.ts` helpers (decimal.js).
- **Engine purity.** `app/packages/**` must not import Shopify/Prisma/Remix/fs/network. It stays reusable.
- **Deterministic, not AI.** The MVP is deterministic checks; do not add LLM/AI to the first app (that's the future "MerchGrid: Bulk AI").
- **Data minimization.** Don't retain whole catalog payloads; findings carry only the per-variant fields needed for display/CSV.
- **`SESSION_ENCRYPTION_KEY` must never be rotated** once tokens are encrypted with it (would orphan them → merchants must reinstall).
- **GDPR compliance webhooks** use the `[webhooks.privacy_compliance]` block in `shopify.app.toml` (NOT `[[webhooks.subscriptions]]`).
- Deploy is a **single Fly machine** (web + worker share one SQLite volume) — do not add a `[processes]` block (would split machines that can't share the volume); migrations run in the entrypoint, not a Fly `release_command`.

## Known deferred / follow-ups
- App Store submission (not done, deferred by choice).
- Litestream backups intentionally skipped (data is regenerable; volume has daily snapshots).
- Progress/decision history: `.superpowers/sdd/progress.md` (gitignored).
