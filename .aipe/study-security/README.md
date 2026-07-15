# Study — Security: MerchGrid: Catalog Audit

A per-repo security audit for the MerchGrid: Catalog Audit codebase — a **read-only** embedded Shopify admin app (`read_products,read_inventory` only, no write scopes anywhere) that runs 10 deterministic catalog checks and never mutates a merchant's store.

## The through-line

Every finding in this guide answers one question: **what can an attacker reach, and what happens when they do?**

```
trace the trust axis across every boundary
   where does untrusted input enter?      → the attack surface (lens 1)
   who is allowed past this boundary?      → authn/authz (lens 2)
   what's hidden, what's exposed?          → secrets / data (lenses 4, 5)
   what do dependencies let in?            → supply chain (lens 6)
```

The single most exposed boundary in this repo is the multi-tenant one: one app instance, one SQLite file, every installed shop's Sessions/Scans/Findings sitting in the same tables. Every read has to prove it isn't leaking one shop's rows into another shop's response — see `02-per-shop-tenant-isolation.md`.

## Reading order

1. **`00-overview.md`** — the trust map in one diagram, the three highest-risk findings. Read this first.
2. **`audit.md`** — the 8-lens walk (trust boundaries, authn/authz, input validation, secrets, data exposure, dependencies, LLM/agent security, red-flags checklist). Cross-links to the deep-dive files below.
3. **`01`–`05`** — the discovered security controls, each a full concept file (mental model → mechanism → this repo's code → interview defense):
   - `01-encrypted-session-storage-at-rest.md` — AES-256-GCM envelope encryption defending the OAuth access token against database/backup exposure
   - `02-per-shop-tenant-isolation.md` — the ownership check + same-error-shape anti-enumeration defense on every scan read
   - `03-read-only-scope-enforcement.md` — how "this app cannot mutate a store" is enforced at three layers, not just claimed in a config file
   - `04-gdpr-compliance-webhooks.md` — the mandatory data-deletion pipeline and its PII-in-logs discipline
   - `05-sanitized-failure-boundary.md` — the recurring "log the real error, return a generic one" seam that keeps internals out of API responses

## Honest gaps

- **LLM/agent security (lens 7) is `not yet exercised`.** This is a deterministic app by design (`.aipe/project/context.md`: "10 deterministic checks... no LLM"). No prompt injection surface, no tool-calling, no model output reaching a sink. See `audit.md` → lens 7 for what a future AI feature (the planned "MerchGrid: Bulk AI") would need to add.
- **Distributed-systems-scale attacks (DDoS, multi-region) are out of scope.** Single Fly machine, single worker — see `.aipe/study-system-design/` for the architecture picture.

## Cross-links to neighboring guides

- **`.aipe/study-system-design/`** — `04-encrypted-token-at-rest.md` and `05-shop-scoped-authorization.md` cover the same two files from an architecture/dependency-injection angle. This guide covers the identical code from the attacker's angle: what's the blast radius if the control fails, who's the adversary, what's the concrete capability defended.
- **`.aipe/study-data-modeling/`** — schema shape and denormalization choices on `Finding`; this guide only covers who may read/write those rows and how that's enforced.
