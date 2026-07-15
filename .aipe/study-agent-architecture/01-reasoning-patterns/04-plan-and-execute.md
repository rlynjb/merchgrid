# Plan-and-execute

Industry standard. Separate the expensive "figure out the strategy" step from the cheap "carry it out" steps.

## Zoom out, then zoom in

```
Zoom out — the split this pattern would introduce

┌─ Hypothetical Bulk AI agent ─────────────────────────────────┐
│  Plan phase (expensive model, once): "fix these 40 pricing   │
│  findings, in this order, using these strategies"            │
│  Execute phase (cheap model, per finding): apply each fix     │
│  ★ NOT in this codebase — no agent exists to plan anything ★ │
└──────────────────────────────────────────────────────────────────┘

┌─ What this codebase actually has instead ────────────────────┐
│  runChecks() runs all 10 checks, unconditionally, every time  │
│  — there's no "plan" step because there's nothing to decide:  │
│  the plan IS "run everything," hardcoded                      │
└──────────────────────────────────────────────────────────────────┘
```

Plan-and-execute splits the agent-loop-skeleton's `step()` into two phases instead of one: an expensive model call builds a full plan up front (an ordered list of steps), then a cheap/fast model (or no model at all) executes each step without re-deciding the overall strategy every time.

**In this codebase:** not yet implemented — there's no agent, so there's no plan to build. The closest existing analog is `runChecks`'s check list (`ALL_CHECKS`), which is a "plan" in the loosest sense (a fixed ordered list of work), but it's hardcoded at build time, not planned by a model at run time — there's no expensive/cheap split because there's no model involved at all.

## The structure pass

**Layers:** plan phase (one expensive call) sits above execute phase (many cheap calls); the axis that flips between them is **cost per step** — one high-cost call up front buys many low-cost calls after.

**Seam:** the plan/execute boundary is itself the seam — a re-plan trigger has to sit there to catch execution diverging from the plan's assumptions, or the pattern gets brittle mid-run.

## How it works

### Move 1 — the mental model

Think of it as the difference between deciding your whole grocery list before you leave the house versus deciding what to buy aisle by aisle — deciding once up front is cheaper overall as long as the list doesn't need to change once you're in the store.

```
┌─ Plan phase ──────────────────────────────────┐
│  Expensive model builds the full plan up front│
│  (list of steps, dependencies)                │
└──────────────────┬────────────────────────────┘
                   │  plan: [step1, step2, step3]
                   ▼
┌─ Execute phase ───────────────────────────────┐
│  Cheap/fast model runs each step               │
│  (no re-planning per step)                      │
└───────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Why this beats sequential ReAct on structured tasks:** you decouple the strategy (one expensive call) from the grunt work (many cheap calls), and you avoid re-deciding the whole approach on every loop iteration the way a pure ReAct loop would. **The tradeoff:** it's brittle when the plan's assumptions break mid-execution — a step fails, and the plan has no branch for that, because the plan was built before execution revealed the problem. The mitigation is a re-plan trigger: when execution diverges from what the plan assumed, stop and re-plan rather than pushing forward on a stale strategy.

**When to pick which:** ReAct for dynamic/exploratory tasks where the path genuinely can't be predicted ahead of time; plan-and-execute for structured tasks where it can — which is exactly the shape of a catalog changeset task (findings are known up front; the "plan" is largely "which findings to fix, in what order, with what strategy"), making this a stronger candidate for Bulk AI than open-ended ReAct.

### Move 3 — the principle

Plan-and-execute is a cost optimization wearing a reasoning-pattern costume: it's worth it exactly when the expensive reasoning step doesn't need to be repeated per action, and it stops being worth it the moment execution regularly invalidates the plan.

## Primary diagram

```
Plan-and-execute applied to the hypothetical Bulk AI agent

┌─ Plan (expensive, once) ─────────────────────────────────────┐
│  read all findings from runChecks() → build a fix strategy   │
└─────────────────────────┬──────────────────────────────────────┘
                          │ plan: [fix MG-001 findings, fix MG-003...]
┌─ Execute (cheap, per step) ──▼──────────────────────────────────┐
│  for each planned fix: propose changeset → guardrail checks it │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Plan-and-execute trades ReAct's flexibility for cost predictability — you know the plan's shape before you spend a single execution-phase token. It pairs naturally with the deterministic-findings shape this codebase already produces: a list of known, classified problems is close to "the hard part of planning already done for you," which is why this pattern (not ReAct, not multi-agent) is the most plausible fit if Bulk AI is ever built on top of this engine.

## Interview defense

**Q: "When would you pick plan-and-execute over ReAct?"**
A: When the task is structured enough that the full step sequence can be decided up front and doesn't usually change once execution starts — which decouples one expensive reasoning call from many cheap execution calls. If the path genuinely depends on what execution discovers, ReAct's per-step reasoning is worth the extra cost.

**Q: "Does this codebase plan anything?"**
A: Not yet implemented, and only in the loosest sense today — `ALL_CHECKS`' fixed order is a hardcoded "plan," not one built by a model. A real plan-and-execute pattern would need an actual planning step, which requires a model, which this codebase doesn't have.

## See also

- `01-reasoning-patterns/03-react.md` — the pattern this one is an alternative to.
- `01-reasoning-patterns/05-reflexion-self-critique.md` — the pattern that adds a verification loop on top of either.
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — the template whose standard architecture is plan-and-execute plus verification, closest to what Bulk AI would need.
