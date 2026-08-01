# MerchGrid: Catalog Audit

A read-only, embedded Shopify admin app that scans a merchant's product
catalog and shows the pricing, inventory, and merchandising problems that
may be costing them sales — without ever changing store data.

## What it checks

Ten deterministic rules (no AI/LLM involved): below-cost pricing, margin
below a merchant-set threshold, zero/negative pricing, invalid or
no-op compare-at (sale) prices, duplicate or missing SKUs, duplicate
barcodes, and price outliers within a product. See
`merchgrid-catalog-audit-product-spec.md` (repo root) for the full spec,
or `.aipe/study-software-design/04-check-registry-pattern.md` for how the
check engine is built.

## Local development

```bash
npm install

# terminal 1 — the embedded web app (opens a Shopify CLI tunnel)
npm run dev

# terminal 2 — the background scan worker (required; scans stay QUEUED
# forever without it)
npm run worker
```

Seed a connected dev store with fixture products that exercise every
check (needs its own write-scoped Admin API token — never the app's own
read-only credentials):

```bash
FIXTURE_SHOP=your-dev-store.myshopify.com \
FIXTURE_ADMIN_TOKEN=shpat_xxx \
npm run seed:fixtures

# tear them down later:
npm run seed:fixtures:clean
```

## Testing

```bash
npm test        # app test suite (Prisma-backed, isolated test.sqlite)
npm run eval     # golden-set regression eval — known fixtures -> known findings
cd packages && npx vitest run   # the pure check-engine package tests
```

## Deployment

Production runbook: [`DEPLOY.md`](./DEPLOY.md). Single Fly.io machine
running the web app and worker together, SQLite on a persistent volume.

## Architecture docs

Sixteen-plus generated study guides live under `.aipe/study-*/` — start at
`.aipe/study-system-design/00-overview.md` for the whole-system picture.
