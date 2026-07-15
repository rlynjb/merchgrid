# Context and prompts — MerchGrid: Catalog Audit

All three concepts in this sub-section are `not yet exercised` in this codebase, and for the same reason: **this app has no LLM integration, so there is no prompt and no context window to manage.** MerchGrid: Catalog Audit is a deterministic, rule-based Shopify app — ten hand-written checks (`MG-001` through `MG-010` in `app/packages/catalog-checks/src/checks/`) run TypeScript comparisons, groupings, and threshold math over a normalized Shopify catalog snapshot. There is no LLM call anywhere in `app/app/`, `app/packages/catalog-checks/`, or `app/packages/catalog-core/`.

That's a deliberate product decision, not a gap. The product spec states it directly:

- §2.1 — *"Deterministic: Findings come from explicit validation rules rather than an LLM."*
- §17.6 — bans "Powered by AI" messaging for this MVP specifically, so the product never implies capability it doesn't have.
- §27 — *"Use deterministic checks rather than AI."*

A future, separate product — **MerchGrid: Bulk AI** — is named in the spec (§25.4) as the place LLM-assisted bulk editing would eventually live, reusing this app's normalization and check engine as a preflight layer. Every file below teaches its concept in full, against real transferable knowledge, and — where honestly possible — names the specific place in this codebase's real architecture a future Bulk AI feature would need to attach that concept. Those notes are marked speculative; nothing under `app/app/services/ai/` exists in this repo today.

## Files

| File | Concept | This codebase |
|---|---|---|
| `01-context-window.md` | Context window — the fixed token budget an LLM call gets | `not yet exercised` — no LLM call exists; closest real analog is `settings.catalogVariantLimit` (a variant-count cap, not a token budget — the file is explicit about the difference) |
| `02-lost-in-the-middle.md` | Lost-in-the-middle — position inside a long prompt affects recall | `not yet exercised` — this repo's check engine reads `ctx.variants` in full, at equal cost regardless of array position, which is the structural opposite of what makes this problem a risk |
| `03-prompt-chaining.md` | Prompt chaining — decomposing one LLM task into single-purpose sequential calls | `not yet exercised` as an LLM chain, but the real scan pipeline (`enqueueScan → claimAndRunNext → runScan`) already has the identical fixed-sequence, single-purpose-step shape — with code, not a model, deciding every step |

## Reading order

Read in file order — each concept builds on the last. `01` establishes the fixed-budget container. `02` shows that fitting inside the budget isn't enough because position matters. `03` shows the standard mitigation for both: break a long, single-shot ask into several short, single-purpose steps, each with less to lose track of.

## See also

- `../01-llm-foundations/` — what an LLM is, tokenization, sampling — the layer beneath everything in this sub-section.
- `../../study-prompt-engineering/` — this repo's dedicated prompt-engineering guide, covering overlapping "not yet exercised" ground (`04-token-budgeting.md` in particular) from a working-AI-engineer angle, plus the one real anchor this codebase does have: the hand-written `title`/`explanation` copy on every finding.
- `../../study-system-design/` — the real scan pipeline (`01-single-worker-db-queue.md`, `02-atomic-idempotent-scan-pipeline.md`) that `03-prompt-chaining.md` reads as its structural anchor.
