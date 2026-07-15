# Study — System Design: MerchGrid: Catalog Audit

A per-repo system-design guide for the MerchGrid: Catalog Audit codebase — a read-only embedded Shopify admin app that audits a merchant's product catalog with 10 deterministic checks (no LLM/AI) and never mutates the store.

## Reading order

1. **`00-overview.md`** — the whole system in one diagram. Read this first, even if you only read one file.
2. **`audit.md`** — the 8-lens walk (system map, request flow, state ownership, caching, storage, failure handling, scale, red flags). Read this second — it's the map of what's here and cross-links to the deep-dive files below.
3. **`01`–`06`** — the discovered patterns, each a full concept file (mental model → mechanism → this repo's code → interview defense):
   - `01-single-worker-db-queue.md` — the DB-backed job queue with exactly one poll-loop worker
   - `02-atomic-idempotent-scan-pipeline.md` — the state-machine-gated, transaction-committed scan run
   - `03-engine-app-boundary.md` — the pure, Shopify-independent engine packages
   - `04-encrypted-token-at-rest.md` — AES-256-GCM envelope encryption for OAuth tokens
   - `05-shop-scoped-authorization.md` — per-tenant isolation and anti-enumeration on every read
   - `06-single-machine-shared-volume.md` — the one-Fly-machine, one-SQLite-volume deploy topology

## Cross-links to neighboring foundation guides

This guide owns architectural boundaries and tradeoffs only. For mechanism-level depth, go to:

- **`.aipe/study-database-systems/`** — SQLite engine internals, transaction/isolation mechanics behind the `$transaction` calls this guide references.
- **`.aipe/study-data-modeling/`** — the shape of `schema.prisma` (denormalization choices on `Finding`, indexing strategy).
- **`.aipe/study-distributed-systems/`** — not applicable yet; this repo runs a single worker process (see `audit.md` → scale-bottlenecks lens, `not yet exercised`).
- **`.aipe/study-runtime-systems/`** — the Node event loop / process model underneath `worker.ts`'s poll loop and `start-production.js`'s child-process supervision.
- **`.aipe/study-dsa-foundations/`** — no repo-specific data-structure/algorithm curriculum lives here; this repo's "queue" is a SQL table, not an in-memory structure.
