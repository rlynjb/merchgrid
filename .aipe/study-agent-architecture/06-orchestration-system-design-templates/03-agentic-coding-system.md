# System design template — agentic coding / build system

- **The prompt:** "Design an agent that completes a task across a structured target — read, plan, edit/propose, verify."
- **Standard architecture:** plan-and-execute (plan the changes, then execute per item) + verifier-critic (check the result, loop on failure) + guardrails (scope what's writable, cap iterations).

```
┌─ Plan ────────────┐   ┌─ Execute ──────────┐   ┌─ Verify ──────────┐
│ read the target,  │──►│ propose a change   │──►│ check the change  │
│ build a plan       │   │ per planned item    │   │ against a fixed  │
└────────────────────┘   └────────────────────┘   │ rule set          │
                              ▲                     └─────┬──────────┘
                              │ re-plan on failure          │ fail
                              └──────────────────────────────┘
```

- **Data model:** target context (the full state to read — a file tree for a coding agent, a catalog snapshot here), the plan, the proposed diff/changeset, verification results, an iteration counter.
- **Key components:** retrieval over the target (which parts matter), planning, execution (the proposed change), verification (the fixed rule set / tests), the re-plan trigger on verification failure. Decision: plan-and-execute vs. pure ReAct for the propose loop.
- **Scale concerns:** a large target blows the context budget (retrieval/routing over it), long tasks blow the iteration cap, cost per task.
- **Eval framing:** task success (the change passes verification), trajectory efficiency (edits and re-plans to completion), regression rate (did it break something the verification step didn't check for).
- **Common failure modes:** proposing changes outside the intended scope, plan assumptions breaking mid-execution (needs a re-plan trigger), the verifier sharing the producer's blind spots, context loss across long tasks.
- **Applies to this codebase:** Partially — not as a system that runs today, but this is the template MerchGrid's own architecture is already shaped to become. The "verify" stage of this template already exists and is production-grade: `runChecks(ALL_CHECKS, ctx)` (`app/packages/catalog-checks/src/run.ts:26-28`) is exactly a fixed rule set that checks a state and returns structured, explainable results (`CatalogFinding`'s `severity` / `evidence` / `explanation`, `contract.ts:11-25`). What's missing is everything upstream of it — there's no plan, no propose/execute step, because there's no agent. `.aipe/project/context.md` names this gap directly: the engine is "designed for reuse by a planned future 'MerchGrid: Bulk AI' product (changeset preflight)" — "preflight" is this template's verify stage, named in the product's own docs.
- **How to make it apply:** The concrete refactor, in order: (1) build a plan step — given the findings `runChecks` already produces, an expensive model call decides which findings to fix and in what order (a natural fit, since the findings are already a known, bounded list rather than an open-ended target to explore); (2) build an execute step — a cheaper model call per planned finding, proposing a specific changeset (a price correction, an SKU fix); (3) re-run `runChecks` against the *proposed* post-change state as the verify stage, unmodified — this is the one piece that's already built and battle-tested, and it's the reason building Bulk AI on this engine is materially cheaper than building a changeset agent from scratch; (4) add a re-plan trigger for when a proposed fix fails verification, capped at a fixed retry budget (the two-exit termination discipline from `01-reasoning-patterns/02-agent-loop-skeleton.md`); (5) gate the actual Shopify write behind human approval, since the app has zero write scopes today by design. This is the strongest-fitting template of the three in this sub-section, and the reason is structural, not aspirational: this codebase's core product IS the verify stage of an agentic coding-style system, built and shipped years before the agent that would use it.
