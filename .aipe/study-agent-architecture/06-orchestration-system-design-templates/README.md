# 06 — Orchestration system design templates

Generated for every codebase regardless of shape — these reframe the studied repo as the answer to a standard "design an agentic X system" interview prompt. Same code, interview framing.

## Reading order

Read in the order that mirrors how well each currently fits this codebase, best first:

1. **`03-agentic-coding-system.md`** — the strongest fit. `runChecks` is already this template's verify stage, built and shipped; the product's own docs (`.aipe/project/context.md`) name the reuse plan directly ("changeset preflight").
2. **`02-agentic-support-system.md`** — a plausible fit if "MerchGrid: Bulk AI" is framed as resolving problems rather than reporting them; the concrete refactor path (add write scopes, add an agent, reuse the guardrail, gate on human approval) is spelled out.
3. **`01-multi-agent-research-assistant.md`** — the weakest fit; MerchGrid has no research-question shape and no roadmap need for one. Included because every guide in this family generates all three templates, not because it's a natural direction for this product.

## What "Applies to this codebase" means here

None of the three templates describe a system that runs in this repo today — MerchGrid has zero agents. Read "Applies to this codebase: partially/no" as an honest answer, and "How to make it apply" as the concrete engineering path, grounded in real files, that would get there.
