# Routing

Industry standard. Pick the right handler before committing to a reasoning loop.

## Zoom out, then zoom in

```
Zoom out — the closest thing this codebase has to routing

┌─ Worker layer ────────────────────────────────────────────────┐
│  claimAndRunNext(): picks the oldest QUEUED scan               │
│  ★ a real routing DECISION — but it routes SCANS to a worker, │
│    not a query to a tool or agent ★                            │
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Engine layer ────────────────▼──────────────────────────────────┐
│  runChecks(ALL_CHECKS, ctx): no routing — every check runs,    │
│  every time, unconditionally                                   │
└──────────────────────────────────────────────────────────────────┘
```

Routing picks the right handler for a given input before committing further work to it — a fast heuristic layer up front (regex, rules) for the high-volume predictable cases, an LLM router behind it for the ambiguous ones. It's the bridge between this guide's Section A and Section C: in a single-agent system, routing picks a tool; in a multi-agent system, the same pattern picks which *agent* handles the request (a supervisor's core job).

**In this codebase:** not yet implemented in the LLM-router sense — there is no model anywhere making a classification decision. The one real routing-shaped decision in this repo is `claimAndRunNext` picking which scan to run next, and it's a plain SQL query (oldest `QUEUED` row), not a decision between multiple *kinds* of handling.

## The structure pass

**Axis to trace: cost vs. ambiguity.** A heuristic router is nearly free and handles the predictable majority of cases; an LLM router costs a model call but handles cases a heuristic can't classify confidently. The seam is exactly where "confident heuristic match" stops and "ambiguous, needs judgment" starts.

## How it works

### Move 1 — the mental model

You've written this as a plain `if/else if/else` dispatcher before picking a fallback handler — routing is that, with the fallback branch sometimes replaced by a model call for the genuinely ambiguous cases.

```
Input
  │
  ▼
┌─────────────────────┐
│ Heuristic router    │ fast, deterministic
│ (regex, rules)      │
└─────────┬───────────┘
          │ no clear match
          ▼
┌─────────────────────┐
│ LLM router          │ classify intent, pick
│ (model-decided)     │ the handler/agent/tool
└─────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Production pattern:** heuristic at the front for the high-volume predictable routes, LLM router at the back for the ambiguous ones — never LLM-route everything, because most traffic doesn't need it and the cost adds up. **In this codebase**, `claimAndRunNext` (`app/app/services/scan/worker-core.server.ts:30-80`) is worth reading as a routing decision that's entirely heuristic and never needs an LLM tier at all: "route to the oldest QUEUED scan" is unambiguous by construction — there's exactly one legal answer to "which scan runs next," so there's no ambiguous case for an LLM tier to catch. That's actually the interesting finding: routing only needs an LLM layer when the classification is genuinely fuzzy, and this repo's one routing-shaped decision isn't.

If Bulk AI is ever built, routing would show up differently: deciding which *kind* of fix strategy applies to a given finding (a price-below-cost finding needs a different fix strategy than a missing-SKU finding) is a plausible router — and here a heuristic router based on `checkId` (MG-001 vs MG-006, say) probably covers most cases, with an LLM router reserved only for findings whose fix genuinely depends on judgment a rule can't express.

### Move 3 — the principle

Routing is worth an LLM tier only for the residual ambiguity a heuristic can't resolve — reach for the free tier first, and measure how much traffic actually needs the expensive one before building it.

## Primary diagram

```
Routing, heuristic vs. LLM tier, applied to this codebase's shapes

┌─ Real, today: claimAndRunNext ───────────────────────────────┐
│  heuristic only — "oldest QUEUED" has exactly one answer      │
│  no LLM tier needed; no ambiguity to resolve                   │
└──────────────────────────────────────────────────────────────────┘

┌─ Hypothetical Bulk AI fix-strategy router ────────────────────┐
│  heuristic tier: route by checkId (covers most findings)      │
│  LLM tier: only for findings whose fix needs judgment          │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Routing is the same pattern at every altitude of this guide — SECTION B's retrieval routing (which knowledge source to query) and SECTION C's supervisor delegation (which agent handles this) are both this file's heuristic-then-LLM tiering, applied to a different kind of "handler." Learning it once here means recognizing it everywhere else in the guide instead of re-deriving it.

## Interview defense

**Q: "How would you decide between a heuristic router and an LLM router?"**
A: Heuristic first, always — it's nearly free and correctly resolves the predictable majority of cases. Reach for an LLM tier only for the residual cases a heuristic can't classify confidently, and measure how much of your actual traffic falls into that residual before building the expensive tier.

**Q: "Does this codebase route anything?"**
A: One real routing-shaped decision — `claimAndRunNext` picks which scan runs next (oldest `QUEUED`) — but it's fully heuristic (a SQL ordering), because the decision has exactly one correct answer. There's no ambiguous case here that would ever justify an LLM tier.

## See also

- `01-reasoning-patterns/01-chains-vs-agents.md` — where this file's "unambiguous heuristic decision" observation about `claimAndRunNext` is grounded in the same real worker code.
- `02-agentic-retrieval/` — skipped in this guide, but retrieval routing is this same pattern applied to picking a knowledge source; see that sub-section's `README.md` for why it's out of scope here.
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — where routing becomes a supervisor's core job, one level up.
