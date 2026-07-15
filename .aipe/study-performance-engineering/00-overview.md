# Performance Engineering — Overview

## The one-diagram version

```
  MerchGrid: Catalog Audit — where performance decisions live

  ┌─ UI layer (Remix + Polaris) ───────────────────────────────────────┐
  │  app.scans.$id.tsx: PAGE_SIZE=50 IndexTable, 2500ms revalidate poll│  ← lens 7
  └──────────────────────────────┬─────────────────────────────────────┘
                                  │ loader() reads
  ┌─ Service layer ───────────────▼─────────────────────────────────────┐
  │  scan-api.server.ts   getScanFindings(): SQL orderBy + where.contains│ ← 02
  │  queue.server.ts      enqueueScan(): one active scan per shop       │ ← lens 6
  │  worker-core.server.ts claimAndRunNext(): single global claim       │ ← lens 3/6
  │  runner.server.ts     runScan(): read → normalize → checks → 1 txn  │ ← lens 6
  │  catalog-reader.server.ts readCatalog(): variantLimit guardrail,   │ ← 01, 03
  │    exponential backoff + jitter on Shopify THROTTLED               │
  │  catalog-checks/*     runChecks(): O(checks × n), groupBy kernel   │ ← 04, lens 4
  └──────────────────────────────┬─────────────────────────────────────┘
                                  │ Prisma
  ┌─ Storage layer ───────────────▼─────────────────────────────────────┐
  │  SQLite, single file, single writer (web+worker share one machine) │ ← lens 5, 8
  │  Finding @@index([scanId, severityRank, checkId])                  │ ← 02
  └──────────────────────────────┬─────────────────────────────────────┘
                                  │ Admin GraphQL (query-only)
  ┌─ Provider layer ───────────────▼────────────────────────────────────┐
  │  Shopify Admin API — cost-throttled, 100 products/100 variants page │ ← 01, 03
  └──────────────────────────────────────────────────────────────────────┘
```

Every box on this diagram is a design-time performance decision — something built to hit a budget. None of them has a runtime measurement behind it yet. That's the theme of this whole guide: **the shape is right, the proof isn't written down.**

## What's actually measured — the honest number

Zero. `grep -r "performance.now\|autocannon\|clinic\|k6\|artillery\|perf_hooks"` across `app/` and `app/packages/` returns nothing outside this guide. The golden eval (`app/test/eval-fixtures.test.ts`, run via `npm run eval`) checks **correctness** against 17 fixtures — it asserts findings match expectations, not that they arrived within a time budget. `app/scripts/seed-fixtures.ts` seeds a small demo catalog (one fixture per check, not a 500- or 5,000-variant load), so even the tool that could generate a load-test dataset today generates the wrong size for one.

The product spec (`merchgrid-catalog-audit-product-spec.md:848-856`, §11.2) writes three targets:

1. Dashboard loads within 2 seconds under normal conditions (excluding active scan processing).
2. A 500-variant catalog completes in a "merchant-acceptable period" — deliberately no number yet: "Exact scan-time promises should not appear in the listing until production measurements are available" (line 856).
3. The findings table stays responsive with at least 5,000 findings, "through server-side pagination or equivalent techniques."

Targets 1 and 2 are unverified — no timer wraps the dashboard load or a 500-variant scan anywhere in the code. Target 3 is the one target this codebase actually built a named mechanism for (`02-sql-side-pagination-and-severity-index.md`) — and even that mechanism has never been benchmarked at 5,000 rows; it's a correct-by-construction design (SQL does the sort/filter, not JavaScript), not a measured one.

## Ranked findings (full detail in `audit.md` → lens 8)

1. **No profiling or load test has ever run.** The two written performance targets in §11.2 are unverified by any timer, trace, or benchmark. Highest-leverage next step: extend `seed-fixtures.ts` (or a sibling script) to generate a 5,000-variant catalog and wrap `runScan`'s phases in `performance.now()` markers.
2. **Single Fly machine, single SQLite writer** is a deliberate, documented scale ceiling (`fly.toml:1-9`, `DEPLOY.md`) — the right call for a per-merchant on-demand tool today, and the wall you'd hit first if usage grew.
3. **`enqueueScan`'s active-scan check is a named, accepted race** (`queue.server.ts:54-62`) — a TOCTOU the comment itself documents as low-probability today, exactly the kind of thing a load test would actually exercise.
4. **The worker's fixed 5-second idle poll** (`worker.ts:25`, `POLL_MS = 5000`) caps queue-pickup latency at up to 5s when idle — an accepted, unmeasured latency budget.

## `not yet exercised` — where this guide has nothing to teach from evidence

- **Measurement and profiling** (lens 2) — no instrumentation, no profiler runs, no captured before/after anywhere in the repo.
- **Latency/throughput distributions** (lens 3) — no p95/p99, no queue-depth metric; the throughput ceiling below is inferred from the single-worker architecture, not measured.
- **Rendering/client metrics** (lens 7) — no bundle-size budget, no Lighthouse/Core Web Vitals run, no client-side profiling.
- **Caching** (lens 6) — there is no cache anywhere in the app. Read as an honest design absence for a read-once-per-scan workload, not a gap to fill reflexively.

## Reading order

Start with `audit.md` for the full 8-lens walk, then the four pattern files for the mechanisms worth understanding at depth. See `README.md` for cross-links to neighboring guides that own the architecture/mechanism internals this guide only measures.
