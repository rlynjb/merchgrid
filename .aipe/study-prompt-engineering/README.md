# Prompt engineering — MerchGrid: Catalog Audit

A per-repo prompt-engineering study guide, written in a working-AI-engineer voice. Start with `00-overview.md` — it states the one thing that governs every file here: **this app has no LLM and no prompts.** The ten checks in `app/packages/catalog-checks/src/checks/` are deterministic TypeScript. Prompt engineering, as a discipline, activates in the planned future product, **MerchGrid: Bulk AI** (an LLM proposing catalog changesets), not in the shipped app.

Where a concept genuinely has a deterministic cousin in this codebase — the finding `title`/`explanation` copy, the `CatalogFinding` schema, the golden eval, the single-purpose check pipeline — the file teaches the transferable principle against that real code. Everywhere else the file says `not yet exercised` and points at Bulk AI as the buildable target.

## Reading order

### Operational discipline — read these first

| File | Concept | This codebase |
|---|---|---|
| `01-anatomy.md` | Anatomy of a production prompt | Not yet exercised — closest cousin: `CatalogFinding`'s one-field-per-concern shape |
| `02-structured-outputs.md` | Structured outputs via tool calling and schemas | Deterministic cousin exercised — `contract.ts` + `findingFor()` |
| `03-prompts-as-code.md` | Prompts as code: versioning and observability | Deterministic cousin exercised — checks are versioned, reviewed source |
| `04-token-budgeting.md` | Token budgeting and context window management | Not yet exercised — no context window in this app |
| `05-eval-driven-iteration.md` | Eval-driven prompt iteration | Genuinely exercised — `npm run eval`, 17 golden fixtures |

### Specific techniques

| File | Concept | This codebase |
|---|---|---|
| `06-single-purpose-chains.md` | Single-purpose chains | Genuinely exercised — 10 single-job checks composed by `runChecks` |
| `07-output-mode-mismatch.md` | Output mode mismatch | Prevented structurally by TypeScript, not by prompt-engineering discipline |
| `08-few-shot.md` | Few-shot prompting | Not yet exercised |
| `09-chain-of-thought.md` | Chain-of-thought (CoT) | Not yet exercised |
| `10-self-critique.md` | Self-critique and self-consistency | Not yet exercised |
| `11-meta-prompting.md` | Meta-prompting | Not yet exercised |
| `12-prompt-injection-defense.md` | Prompt injection defenses (author side) | Not yet exercised for an LLM — real, unaddressed deterministic-sibling gap in CSV export |
| `13-forbidden-patterns.md` | Forbidden patterns and rotating formulas | Not yet exercised — no generative chain exists |

## The one real anchor

`app/packages/catalog-checks/src/checks/mg-0NN.ts` — each of the ten checks carries a hand-written `title` and `explanation` string a merchant reads in the Shopify admin. That copy is carefully hedged ("may be intentional," "this is a low-confidence signal," "not business advice") to avoid false certainty about data the check can't fully interpret. It's deterministic output design, not prompt or response design — but the same principles govern both. Concepts `01`, `02`, `03`, `05`, `06`, and `12` pull real line numbers from this copy and its surrounding contract/pipeline code.
