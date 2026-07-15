# Study — AI Engineering: MerchGrid: Catalog Audit

A per-repo AI-engineering comprehension guide for the MerchGrid: Catalog Audit codebase. Start with `00-overview.md` for the system map, then read `ai-features-in-this-codebase.md` for the honest one-page answer to "does this app use AI."

## The honest headline

This app has **no AI**. It's a deterministic, rule-based Shopify catalog auditor — 10 hand-written checks, decimal-money arithmetic, zero LLM/ML anywhere — and that's a deliberate product decision (spec §2.1, §17.6, §27), with AI reserved for a separate, later product (**MerchGrid: Bulk AI**) that does not exist in this repo. So most concepts in this guide are honestly marked **`not yet exercised`**: taught in full as transferable knowledge, with an honest verdict and, where it genuinely fits, a note on where the pattern would attach if Bulk AI is built.

**Codebase shape:** not a clean match for any of the three AI-work shapes (LLM application engineering / prompt-engineering-as-discipline / classical ML). It's a **pre-AI verification substrate** — a deterministic engine explicitly designed to become the guardrail layer of a future LLM product.

## What's genuinely grounded in real code (read these first)

Three things in this repo earn real, code-anchored treatment despite the absence of AI:

- **The eval harness** — `05-evals-and-observability/01-eval-set-types.md` and `02-eval-methods.md`, grounded in `app/test/eval-fixtures.test.ts` (run via `npm run eval`). A real golden-set eval over the production `normalizeCatalog → runChecks` seam with independently-specified expectations. The single most AI-adjacent artifact here — the eval discipline transfers directly to LLM evals.
- **The check engine as a guardrail** — `01-llm-foundations/07-heuristic-before-llm.md` and `04-agents-and-tool-use/02-tool-calling.md`, grounded in `app/packages/catalog-checks/src/contract.ts` + `run.ts`. A reusable, typed, deterministic verification contract purpose-built to preflight LLM-proposed changesets later (spec §25.4).
- **Shopify API retry/backoff** — `06-production-serving/04-rate-limiting-backpressure.md` and the retry half of `05-retry-circuit-breaker.md`, grounded in `app/app/services/shopify/catalog-reader.server.ts`. Real exponential-backoff-with-jitter against a rate-throttled API — same code shape an LLM-provider client needs.

## Sub-sections

Most concepts are self-contained; read by interest. Each sub-section has its own README with per-file status.

- **`01-llm-foundations/`** (9 files) — what an LLM is, tokenization, sampling, structured outputs, streaming, token economics, heuristic-before-LLM, provider abstraction, user-override locks. Mostly `not yet exercised`; **07-heuristic-before-llm** is the anchor (the whole check engine is a 100%-heuristic/0%-LLM system by design); **08-provider-abstraction** cites the real `AdminGraphqlClient` port.
- **`02-context-and-prompts/`** (3 files) — context window, lost-in-the-middle, prompt chaining. All `not yet exercised`; the real scan pipeline is the closest structural anchor for prompt chaining.
- **`03-retrieval-and-rag/`** (12 files) — embeddings through GraphRAG. All `not yet exercised` (no corpus, no vectors); **05-dense-vs-sparse** is the one real anchor (`Finding.searchText` SQL filtering as the sparse side, with no dense counterpart).
- **`04-agents-and-tool-use/`** (6 files) — agents vs chains, tool calling, ReAct, tool routing, agent memory, error recovery. All `not yet exercised`; **02-tool-calling** and **06-error-recovery** are the richest (the `CatalogCheck` contract is structurally a tool; the real retry/transaction handling is precisely distinguished from agent error recovery).
- **`05-evals-and-observability/`** (4 files) — eval set types, eval methods, LLM-as-judge bias, LLM observability. **01** and **02** grounded in the real eval harness; **03** and **04** `not yet exercised`.
- **`06-production-serving/`** (5 files) — LLM caching, cost optimization, prompt injection, rate limiting/backpressure, retry/circuit-breaker. **04** and the retry half of **05** grounded in real Shopify-client code; the rest `not yet exercised`.
- **`07-system-design-templates/`** (2 files) — search-ranking and tech-support-chatbot interview reframes (9-labelled-bullet shape, not the concept template). Both land at **applies: no**, with honest "how to make it apply" refactors.

## Not included

- **Machine learning** (would be sub-sections 08/09) — omitted entirely. There is no trained model, recommender, or on-device inference anywhere in this repo to anchor ML concepts to. `ml-features-in-this-codebase.md` is likewise not generated.

## A note on the reading experience

Because this codebase is deliberately AI-free, the value here is twofold: (1) the concepts themselves as study material for the pivot into AI engineering, and (2) the honest map of *where the seams already are* — the engine contract, the eval discipline, the retry logic — so that when MerchGrid: Bulk AI is built, the reader already knows which existing, proven pieces the AI layer will attach to, and which patterns are genuinely new ground.
