# Reflexion / self-critique loop

Industry standard. The agent evaluates its own output and retries before returning it.

## Zoom out, then zoom in

```
Zoom out — where self-critique would sit vs. what exists today

┌─ This codebase, today ───────────────────────────────────────┐
│  runChecks() has no self-critique — a check either fires or   │
│  it doesn't; there's no step where the engine second-guesses  │
│  its own finding. Determinism means there's nothing to        │
│  critique: the same input always produces the same finding.   │
└──────────────────────────────────────────────────────────────────┘

┌─ Hypothetical Bulk AI ────────────────────────────────────────┐
│  agent drafts a changeset → critic step asks "is this correct"│
│  → revise + retry (capped) → return                           │
│  ★ NOT built — no agent, no critic ★                          │
└──────────────────────────────────────────────────────────────────┘
```

Reflexion sits a critic step on top of a base reasoning pattern (usually ReAct): the base pattern produces a draft, a critic step asks "is this correct and complete," and on "flawed," the agent revises and retries, capped at a fixed number of rounds.

**In this codebase:** not yet implemented. There's nothing to self-critique — a deterministic check either detects a problem or it doesn't, and running it twice on the same data always gives the same answer. Self-critique is a mitigation for an unreliable "smart" step; MerchGrid's checks aren't unreliable, so the concept has no attachment point here.

## The structure pass

**Layers:** critic sits above the base pattern, observing its output rather than its internals — the critic never re-derives the answer from scratch, it judges the answer that's already there.

**Seam:** the retry cap is the seam that matters — without it, a critic that never approves becomes an unbounded loop, the same budget-exit failure mode from `02-agent-loop-skeleton.md`.

## How it works

### Move 1 — the mental model

Picture a linter that runs after your code compiles: it doesn't redo the compile, it looks at the output and flags what's wrong, and you fix and recompile.

```
┌──────────────────────────────────────────────┐
│  base pattern (ReAct) produces a draft answer │
└────────────────────┬─────────────────────────┘
                     ▼
┌──────────────────────────────────────────────┐
│  Critic step: "is this correct / complete?"   │
└────────────────────┬─────────────────────────┘
            ┌─────────┴─────────┐
            ▼ good              ▼ flawed
        return            revise + loop
                          (cap the retries)
```

### Move 2 — the step-by-step walkthrough

**The hard limit that matters:** a model critiquing its own output shares the blind spots that produced the output in the first place. Self-critique catches format and obvious-error failures well (a malformed changeset, a missing field); it catches subtle-reasoning failures poorly (a price fix that's syntactically fine but strategically wrong). The cost is real too — roughly 2-5x the tokens of the base pattern alone, for one extra reliability step.

**Where this codebase already gets the equivalent benefit for free:** the reason self-critique doesn't need to exist here is that `runChecks`' determinism removes the failure mode reflexion exists to catch. A model can produce a subtly wrong answer that looks plausible; a deterministic rule function either correctly implements its check or has a bug that a test catches at build time (`app/packages/catalog-checks/tests/`), not at runtime. That's a structurally stronger guarantee than reflexion buys you — reflexion is a runtime patch for a reliability problem this codebase doesn't have.

### Move 3 — the principle

Self-critique is worth its 2-5x cost only when the base pattern's failure mode is real and the critique step's blind spots don't fully overlap with the producer's. If a system can be made deterministic instead — as this codebase's audit engine is — that's a strictly stronger guarantee than any amount of self-critique can buy.

## Primary diagram

```
Reflexion applied to a hypothetical Bulk AI changeset agent

┌─ Producer ──────────────────────────────────────────────────┐
│  drafts a changeset from the findings                        │
└─────────────────────┬─────────────────────────────────────────┘
                      ▼
┌─ Critic (same or different model) ────────────────────────────┐
│  "does this changeset actually fix the finding, cleanly?"     │
└──────────┬─────────────────────┬───────────────────────────────┘
           ▼ approved            ▼ flawed (capped retries)
    hand to guardrail        revise, resubmit to critic
    (runChecks, unchanged)
```

## Elaborate

Reflexion (Shinn et al., 2023) formalized "let the model grade its own work and try again" as a named pattern, but the self-preference bias it inherits — a model sharing blind spots with itself — is the same failure named in `study-ai-engineering.md`'s LLM-as-judge material (this repo doesn't have that guide yet, but the bias is the same one). The mitigation industry teams reach for is a different model family for the critic than the producer, when the stakes justify the extra cost.

## Interview defense

**Q: "What's the failure mode of self-critique?"**
A: The critic shares the producer's blind spots — a model grading its own output catches obvious errors well and subtle reasoning errors poorly, because the same reasoning that produced the flaw is doing the grading. Using a different model family for the critic mitigates but doesn't eliminate this.

**Q: "Why doesn't this codebase need reflexion?"**
A: Because it isn't reflexion's problem to begin with — reflexion exists to patch an unreliable "smart" step at runtime, and this codebase's checks are deterministic rule functions, not model calls. The equivalent reliability guarantee here comes from unit tests over the check functions (`app/packages/catalog-checks/tests/`) and the golden-eval fixture suite, both caught at build time rather than patched at runtime.

## See also

- `01-reasoning-patterns/03-react.md` — the base pattern reflexion typically sits on top of.
- `04-agent-infrastructure/01-guardrails-and-control.md` — a critic step is one way to catch a bad output; a deterministic guardrail (this codebase's real, built example) is a structurally stronger way, when the domain allows it.
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the debate/verifier-critic topology is this same idea with two *separate* agents instead of one agent critiquing itself.
