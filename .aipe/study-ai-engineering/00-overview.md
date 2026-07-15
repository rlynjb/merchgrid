# AI Engineering — MerchGrid: Catalog Audit

MerchGrid: Catalog Audit is a **deterministic, rule-based** Shopify app — 10 hand-written checks, decimal-money arithmetic, zero LLM/AI/ML anywhere in the code — and that absence is a deliberate product decision, not a gap the team forgot to fill: the product spec states outright that findings "come from explicit validation rules rather than an LLM" (§2.1), bans "Powered by AI" messaging for this app (§17.6), and calls for "deterministic checks rather than AI" as a build constraint (§27), because a read-only, rules-only MVP is the fastest path through Shopify App Store review while a *second*, harder product — **MerchGrid: Bulk AI**, LLM-assisted bulk catalog editing — gets built later on top of the same check engine.

```
System map — where AI would attach, if it existed here

┌─ UI layer (Remix + Polaris) ──────────────────────────────────────┐
│  app._index (onboard) · app.scans.$id (results) · app.settings   │
└──────────────────────────────┬─────────────────────────────────────┘
                                │ HTTP (loader/action)
┌─ Service layer (app/app/services/) ───────────────────────────────┐
│  scan/runner.server.ts   read → normalize → runChecks → persist  │
│  scan/queue.server.ts    enqueueScan (DB-backed queue)            │
│  scan/worker-core.server.ts   claimAndRunNext (worker poll loop)  │
│  shopify/catalog-reader.server.ts   Shopify GraphQL + retry/backoff│
│                                          ★ 06 prod-serving anchors★│
└──────────────────────────────┬─────────────────────────────────────┘
                                │ in-process call
┌─ Engine layer (app/packages/, pure, zero I/O) ────────────────────┐
│  catalog-core:   normalizeCatalog(raw) → CatalogSnapshot           │
│  catalog-checks: ALL_CHECKS + runChecks(checks, ctx) → Finding[]  │
│                  ★ THE GUARDRAIL: designed for reuse as the       │
│                    preflight/verification layer in front of       │
│                    future LLM-proposed changesets (Bulk AI) ★     │
└──────────────────────────────┬─────────────────────────────────────┘
                                │ Prisma
┌─ Storage layer (SQLite) ──────▼────────────────────────────────────┐
│  Shop · ShopSettings · Scan · Finding (searchText, severityRank)  │
│  — relational rows, not a retrieval corpus                        │
└─────────────────────────────────────────────────────────────────────┘

┌─ Test layer ───────────────────────────────────────────────────────┐
│  app/test/eval-fixtures.test.ts  — golden-set eval over the real   │
│  normalize→runChecks seam, independently-specified expectations   │
│  ★ THE ONE GENUINELY AI-ADJACENT ARTIFACT IN THIS REPO ★          │
│  (an eval harness — the model behind the seam is incidental;      │
│   the eval discipline is what transfers to LLM evals later)       │
└─────────────────────────────────────────────────────────────────────┘

┌─ Not present anywhere in this codebase ───────────────────────────┐
│  no LLM calls · no prompts · no context window · no embeddings   │
│  no vector store · no agent loop · no tool-calling LLM · no ML    │
│  training · no recommender · no on-device inference               │
└─────────────────────────────────────────────────────────────────────┘
```

**Codebase shape:** none of the three recognizable AI-work shapes (LLM application engineering, prompt-engineering-as-discipline, classical ML) fit — this is a **pre-AI substrate**: a deterministic verification engine explicitly built to become the guardrail layer for a *future* LLM application (Bulk AI's changeset preflight). Almost every concept in this guide is honestly `not yet exercised`. Two things in this repo earn real, code-grounded treatment despite the absence of AI:

- **The check engine as a guardrail design** — `app/packages/catalog-checks/src/contract.ts` (the `CatalogCheck`/`CatalogCheckContext`/`CatalogFinding` contract) and `run.ts` (`runChecks`) are a reusable, typed, deterministic verification layer purpose-built to sit in front of LLM-proposed edits later (product spec §25.4's future flow: `proposed changeset → MerchGrid Engine → critical issues blocked / warnings require review → merchant approval`). Covered mainly in `01-llm-foundations/07-heuristic-before-llm.md` and `04-agents-and-tool-use/02-tool-calling.md`.
- **The golden-set eval harness** — `app/test/eval-fixtures.test.ts` (run via `npm run eval`) is a real, working, independently-specified golden-set eval against the production `normalizeCatalog → runChecks` seam. No LLM output is being judged, but the discipline — hand-labeled ground truth, checked against the exact seam production uses, resistant to snapshot-and-rubber-stamp drift — is precisely what makes any eval trustworthy, LLM or not. Covered in `05-evals-and-observability/01-eval-set-types.md` and `02-eval-methods.md`.
- **Shopify API retry/backoff** — `app/app/services/shopify/catalog-reader.server.ts` has real exponential-backoff-with-jitter retry logic against Shopify's rate-throttled GraphQL API, plus budget-based backpressure on total variants pulled. Same code shape an LLM-provider client needs; just pointed at a different API today. Covered in `06-production-serving/04-rate-limiting-backpressure.md` and the retry half of `05-retry-circuit-breaker.md`.

Everything else in this guide — tokenization, sampling, embeddings, RAG, agents, LLM caching, prompt injection, and the rest — is taught as transferable knowledge with an honest `not yet exercised` verdict and, where it's a genuine fit, a note on where in this architecture it would attach if MerchGrid: Bulk AI is built. Machine learning (sub-sections 08/09) is omitted entirely from this guide: there is no trained model, recommender, or on-device inference surface anywhere in this repo to anchor it to.

See `README.md` for the full file index and reading order, and `ai-features-in-this-codebase.md` for the one-page honest answer to "does this app use AI."
