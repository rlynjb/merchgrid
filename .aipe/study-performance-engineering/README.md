# Study — Performance Engineering: MerchGrid: Catalog Audit

A per-repo performance-engineering guide for the MerchGrid: Catalog Audit codebase — a read-only embedded Shopify admin app that audits a merchant's product catalog with 10 deterministic checks (no LLM/AI) and never mutates the store.

The honest headline: this repo has **strong performance-shaped design decisions and zero performance measurement**. Every budget in the product spec (§11.2) is a target written in prose, not a number backed by a trace. This guide teaches the mechanisms that were built to hit those targets, and says plainly, at every lens, whether there's evidence behind them.

## Reading order

1. **`00-overview.md`** — the whole performance picture in one diagram, the ranked risk list, and the `not yet exercised` summary. Read this first.
2. **`audit.md`** — the 8-lens walk (budget, measurement, latency/throughput, CPU/memory, I/O, caching/batching/backpressure, rendering, red flags). Read this second — it's the map of what's here and cross-links to the deep-dive files below.
3. **`01`–`04`** — the discovered patterns, each a full concept file (mental model → mechanism → this repo's code → interview defense):
   - `01-bounded-catalog-read.md` — the variant-limit guardrail that caps a scan's Shopify reads and memory before they start
   - `02-sql-side-pagination-and-severity-index.md` — the mechanism that keeps the findings table responsive at 5,000+ rows
   - `03-exponential-backoff-with-jitter.md` — the retry policy that absorbs Shopify's cost-throttling without hammering it
   - `04-linear-time-grouped-checks.md` — the hash-map grouping kernel that keeps 4 of the 10 checks O(n) instead of O(n²)

## Cross-links to neighboring guides

This guide owns **measured and measurable** cost — budgets, baselines, latency/throughput, allocation, I/O, batching/backpressure, rendering, and cost. It does not re-teach architecture or mechanism internals that belong to a neighbor:

- **`.aipe/study-system-design/01-single-worker-db-queue.md`** — the single-worker DB-backed queue this guide's `audit.md` treats as the system's *de facto* backpressure/concurrency ceiling (lens 3 and lens 6). Read that file for the mechanism; this guide only measures its consequence (throughput = 1 scan globally, no p95/p99 captured).
- **`.aipe/study-system-design/02-atomic-idempotent-scan-pipeline.md`** — the single `$transaction` this guide's `audit.md` cites as the batching decision behind persist (lens 6). Read that file for the correctness/idempotency mechanics; this guide only names the batching payoff (1 round trip instead of N).
- **`.aipe/study-system-design/06-single-machine-shared-volume.md`** — the one-Fly-machine, one-SQLite-volume deploy topology this guide's `audit.md` treats as a fixed cost floor (`min_machines_running = 1`, always-on billing) and a scale ceiling (lens 8).
- **`.aipe/study-database-systems/`** — SQLite's actual index/query-execution mechanics behind `02-sql-side-pagination-and-severity-index.md`'s `@@index([scanId, severityRank, checkId])`.
- **`.aipe/study-data-modeling/`** — the denormalization choices on `Finding` (why `searchText`/`severityRank` exist as columns at all).
- **`.aipe/study-runtime-systems/`** — the Node event loop and process model underneath `worker.ts`'s poll loop, which this guide only measures (fixed 5s idle latency), not explains.
- **`.aipe/study-networking/`** — HTTP/GraphQL retry semantics underneath `03-exponential-backoff-with-jitter.md`, if you want the transport-layer view instead of the cost/latency view.
- **`.aipe/study-dsa-foundations/`** — the general hash-map/grouping primitive underneath `04-linear-time-grouped-checks.md`, if you want the data-structure view instead of the applied-cost view.
