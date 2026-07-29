# Study — Non-Functional Requirements: MerchGrid: Catalog Audit

A per-repo NFR audit for the MerchGrid: Catalog Audit codebase — a
read-only embedded Shopify admin app that audits a merchant's product
catalog with 10 deterministic checks (no LLM/AI) and never mutates the
store. This guide asks one cross-cutting question, framed per *Designing
Data-Intensive Applications, 2e* Chapter 2: **which non-functional
requirements does this codebase actually meet, and how do we know?**

## Reading order

1. **`00-overview.md`** — the NFR verdict table in one page. Read this
   first, even if you only read one file.
2. **`audit.md`** — the 8-lens walk (functional requirements, reliability,
   scalability, maintainability, latency/performance budgets,
   availability/security/privacy, observability/cost, ranked red flags).
   Read this second — it's the map of what's here and cross-links to the
   deep-dive files below and to every sibling guide.
3. **`01`–`04`** — the discovered NFR patterns, each a full concept file
   (mental model → mechanism → this repo's code → interview defense):
   - `01-documented-tradeoff-as-nfr-governance.md` — the repo's dominant
     NFR-governance style: every accepted gap is named in a comment at its
     exact call site, not fixed preemptively or hidden silently.
   - `02-structural-budgets-without-slos.md` — `catalogVariantLimit`,
     `MAX_PAGE_SIZE`, and `POLL_MS` as informal latency/scalability/cost
     budgets substituting for measured SLOs.
   - `03-always-on-single-machine-availability-cost-bundle.md` — one Fly
     topology decision serving as an availability ceiling, a cost floor,
     and a reliability mechanism simultaneously.
   - `04-gdpr-bounded-retention-and-regenerable-durability.md` — why lax
     backups and strict GDPR-triggered deletion are the same underlying
     call about this data's value.

## This guide's partition — what it owns vs. what it cross-links

This spec owns the **cross-cutting NFR audit**: one page, all eight lenses,
a verdict per lens, grounded in real evidence. It does not re-teach any
sibling's deep mechanics. For mechanism-level depth behind any verdict
above, go to:

- **`.aipe/study-system-design/`** — architecture, request/data flow, state
  ownership, failure-handling and scale-bottleneck lenses (this guide's
  reliability and scalability verdicts lean on its lenses 6 and 7).
- **`.aipe/study-security/`** — trust boundaries, authn/authz, input
  validation, secrets, data exposure, dependencies, LLM/agent security
  (this guide's security lens defers entirely to its 8-lens audit).
- **`.aipe/study-performance-engineering/`** — measurement, latency,
  throughput, memory, I/O, caching, and cost (this guide's latency and
  cost lenses lean on its budget, measurement, and bottleneck lenses).
- **`.aipe/study-debugging-observability/`** — logs, metrics, traces, state
  snapshots, incidents (this guide's observability lens defers entirely to
  its 8-lens audit).
- **`.aipe/study-testing/`** — test design, coverage, flakiness, the AI-eval
  seam (this guide's reliability-testing evidence leans on its risk-map and
  determinism lenses).
- **`.aipe/study-software-design/`** — module quality, complexity,
  information hiding, layering (this guide's maintainability/simplicity
  verdict defers entirely to its 8-lens AOSD audit).
- **`.aipe/study-distributed-systems/`** — coordination under partial
  failure, the single-worker queue's non-atomic claim, TOCTOU races (this
  guide's reliability/scalability ranked findings lean directly on its
  ranked red-flags file).
- **`.aipe/study-data-modeling/`** — schema shape, indexing vs. query
  patterns, migrations and evolution (this guide's maintainability/
  evolvability verdict leans on its migrations file and red-flags audit).
- **`.aipe/study-database-systems/`** — storage-engine mechanics: the
  rollback journal, durability, recovery, the unbounded queue-claim table
  scan (this guide's reliability and scalability rankings cross-link its
  WAL/durability file and ranked red-flags file directly).

A finding belongs in *this* guide's `audit.md` when it states an NFR
verdict and cites evidence (or a sibling's deep walk). It belongs in a
sibling guide when it explains *how* the mechanism actually works.
