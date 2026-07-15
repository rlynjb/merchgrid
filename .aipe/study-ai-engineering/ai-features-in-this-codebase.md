# AI features in this codebase

This codebase does not currently use any LLM-powered features. MerchGrid: Catalog Audit's 10 checks (`app/packages/catalog-checks/src/checks/mg-001.ts`..`mg-010.ts`) are hand-written, deterministic rules over normalized catalog data — no model inference, no prompt, no LLM call, anywhere in `app/app/`, `app/packages/`, or `app/worker.ts`. This is a deliberate product decision, not an oversight: the product spec calls for "deterministic checks rather than AI" (§27) and explicitly bans "Powered by AI" positioning for this MVP (§17.6), reserving AI for a distinct, later product — **MerchGrid: Bulk AI** — that does not exist in this repo.

The concepts in this guide are covered as study material. Each concept file's Project exercises block identifies a feature that *could* be added to rehearse the pattern against this codebase without waiting for Bulk AI to be built for real.

Two things in this repo are worth naming precisely, because they are not "AI features" but they are the closest this codebase comes to AI-adjacent engineering:

### Feature: the check engine as a designed guardrail for a future LLM product

**What it does for the user:** today, nothing — it's the same deterministic scan engine every merchant uses. It doesn't exist to serve AI yet.

**What it's designed for:** the product spec's future-flow diagram (§25.4) has "MerchGrid: Bulk AI" propose catalog edits (via an LLM, from a merchant prompt or CSV) and then run them through "MerchGrid Engine" — the same check engine this app ships today — as a preflight gate: critical issues block the edit, warnings require merchant review, only then does a write happen. The reusable contract that makes this possible already exists and is real, in `app/packages/catalog-checks/src/contract.ts` (`CatalogCheck { id, name, description, run(ctx): CatalogFinding[] }`, `CatalogCheckContext { variants, settings, now }`) and `app/packages/catalog-checks/src/run.ts` (`runChecks`, a pure `flatMap` over checks). The engine has zero Shopify/Prisma/network imports by design (`app/packages/**` purity is a documented must-not-change constraint), which is exactly what makes it swappable onto a *proposed* changeset instead of the live catalog later.

**Patterns used:** `01-llm-foundations/07-heuristic-before-llm.md` (the heuristic side of a heuristic-then-LLM system, built with no LLM side at all yet), `04-agents-and-tool-use/02-tool-calling.md` (the contract shape is exactly a callable tool's shape, though nothing calls it via an LLM's decision today).

**Why these patterns:** a preflight/verification layer over LLM output is precisely the "guardrail" pattern — code checking a model's proposal before anything is written — and this repo has the guardrail half built and proven (10 checks, real production traffic through it) with the LLM half deliberately not started.

### Feature: the golden-set eval harness

**What it does for the user:** nothing directly — it's a test, not a product feature. It runs in CI/locally via `npm run eval` (`app/package.json`, `"eval": "vitest run test/eval-fixtures.test.ts"`).

**What it's for:** `app/test/eval-fixtures.test.ts` feeds a hand-built 15-product/17-variant fixture catalog through the real production seam (`normalizeCatalog` → `runChecks`) and asserts the findings match an expected-findings table that was derived independently — by reading each check's stated behavior, not by running the engine once and recording whatever it produced. The file's own header comment is explicit that "fixing" a red run by copying the engine's actual output into the expected table "defeats the purpose of the eval." That is the exact discipline any trustworthy LLM eval needs: a hand-labeled ground truth, checked against the same seam production uses, resistant to silent drift.

**Patterns used:** `05-evals-and-observability/01-eval-set-types.md` (this fixture table is a real golden set), `02-eval-methods.md` (the assertion style is exact-match evaluation).

**Why these patterns:** there is no LLM output in this repo to evaluate, so this can't be an "LLM eval" — but the eval *discipline* it demonstrates (golden set + seam-level testing + anti-rubber-stamp anti-pattern awareness) is exactly what would need to carry over the day MerchGrid: Bulk AI starts generating merchant-facing text or proposed changesets that need evaluating.

Everything else — tokenization, embeddings, RAG, agents, LLM caching, prompt injection, provider abstraction, and the rest of this guide's inventory — has no implementation in this codebase at all. Each concept file names this plainly and, where it's an honest fit, notes where in the architecture the pattern would attach if MerchGrid: Bulk AI is ever built.
