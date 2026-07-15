# Study guide — Agent architecture (MerchGrid: Catalog Audit)

This codebase has no AI agents. Read `00-overview.md` first — it says so plainly and shows where an agent would attach if one is ever built (the planned future "MerchGrid: Bulk AI" product). This guide is honest throughout: most concepts are marked `not yet exercised`, and the ones that aren't are grounded in the one real orchestration structure this repo has — the deterministic scan pipeline and worker.

## Reading order

1. **`00-overview.md`** — the honest framing, the system map, and the codebase's shape (workflow/chain).
2. **`agent-patterns-in-this-codebase.md`** — the concrete inventory: what's real, what isn't, where an agent would go.
3. **`01-reasoning-patterns/`** — start here for the actual teaching content. `01-chains-vs-agents.md` and `02-agent-loop-skeleton.md` are grounded in real code (`runner.server.ts`, `state.ts`, `worker-core.server.ts`, `worker.ts`, `catalog-reader.server.ts`); the rest of the sub-section is honest curriculum for patterns this codebase doesn't exercise.
4. **`02-agentic-retrieval/`** — skipped (see its `README.md`); no LLM, no retrieval of any kind exists here.
5. **`03-multi-agent-orchestration/`** — one file only: `01-when-not-to-go-multi-agent.md`, the escalation gate every guide carries regardless of current shape.
6. **`04-agent-infrastructure/`** — one file only: `01-guardrails-and-control.md`, the second most load-bearing file in this guide — `runChecks` is already, structurally, the output-guardrail half of a control envelope for a future agent.
7. **`05-production-serving/`** — skipped (see its `README.md`); zero LLM calls means no agent-serving concerns exist yet.
8. **`06-orchestration-system-design-templates/`** — always generated. Read in order of fit: `03-agentic-coding-system.md` (strongest — MerchGrid's engine is already this template's verify stage), `02-agentic-support-system.md`, `01-multi-agent-research-assistant.md` (weakest fit, included for completeness).

## The one sentence that summarizes this guide

MerchGrid: Catalog Audit is a deterministic pipeline, not an agent — but its check engine (`runChecks`) is already built to be the guardrail a future agent would have to satisfy, and that seam (`01-reasoning-patterns/01-chains-vs-agents.md`, `04-agent-infrastructure/01-guardrails-and-control.md`) is the load-bearing idea in this whole guide.
