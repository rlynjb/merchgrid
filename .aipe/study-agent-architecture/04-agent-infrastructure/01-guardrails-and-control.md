# Guardrails and control

Industry standard. The controls that bound an autonomous loop and keep its output from causing harm before a human or a downstream system reviews it.

## Zoom out, then zoom in

```
Zoom out — the guardrail that already exists, and what it's built for

┌─ This codebase, today ───────────────────────────────────────┐
│  runChecks(ALL_CHECKS, ctx) → CatalogFinding[]                │
│  10 deterministic rule functions, each returning a structured │
│  verdict (severity, evidence, explanation) — this IS a        │
│  guardrail-shaped engine, just with no agent in front of it   │
│  yet to guard                                                  │
└─────────────────────────────┬──────────────────────────────────┘
                              │ per .aipe/project/context.md:
                              │ "designed for reuse by a planned
                              │  future 'MerchGrid: Bulk AI' product
                              │  (changeset preflight)"
┌─ Hypothetical Bulk AI ────────▼──────────────────────────────────┐
│  an LLM proposes a changeset (price fix, SKU cleanup, etc.)    │
│  ★ runChecks() re-runs against the PROPOSED state as the      │
│    preflight gate before anything is allowed to apply ★        │
└──────────────────────────────────────────────────────────────────┘
```

A guardrail is a control point that sits around an autonomous loop and refuses to let it do something bad — validating input before the loop sees it, capping how long or how expensively it can run, and, most importantly, never letting the loop's own output trigger a real side effect directly. The output guardrail routes back through code you trust, not through whatever the model just said.

**In this codebase:** this is the one file in this sub-section with real code to point at, because the *guardrail itself* already exists — it's just not wired up to an agent yet. `runChecks` (`app/packages/catalog-checks/src/run.ts:26-28`) and its 10 check functions are, structurally, exactly the shape a guardrail needs: a deterministic function that takes a proposed state and returns a structured, explainable verdict. `.aipe/project/context.md` names this explicitly — the two engine packages (`catalog-core`, `catalog-checks`) are "designed for reuse by a planned future 'MerchGrid: Bulk AI' product (changeset preflight)." The other pieces of a full guardrail envelope (iteration caps, cost ceilings, a human-in-the-loop gate) are not yet implemented, because there's no loop yet to wrap.

## The structure pass

**Layers:** input guardrail (validate what comes in) → the loop itself (caps, budget) → output guardrail (never let the loop's output act directly). This codebase today only has the middle layer's cousin (a fixed pipeline with its own transitions) and the *output guardrail's engine* — `runChecks` — sitting ready but unattached.

**Axis to trace: trust — what is allowed to cause a real side effect, and who checked it first?**

```
One axis, traced through today's real code and the hypothetical future

  ┌──────────────────────────────┐
  │ today: runChecks()            │  → produces a FINDING, never a
  │ (reads a snapshot, returns    │    mutation. The app's own Shopify
  │  findings, never mutates)     │    scopes are read-only (read_products,
  │                                │    read_inventory) — there is no
  │                                │    write path to guard, because none
  │                                │    exists at all.
  └──────────────────────────────┘
        ┌──────────────────────────────┐
        │ future: Bulk AI proposes a    │  → an LLM's output is UNTRUSTED
        │ changeset                     │    by definition until it clears
        └──────────────────────────────┘    a check
              ┌──────────────────────────────┐
              │ future: runChecks() re-run    │  → the guardrail is the ONLY
              │ against the proposed state    │    thing standing between the
              └──────────────────────────────┘    model's output and a real
                                                    write to Shopify

  the axis flips exactly once, and it flips at the boundary this
  file is about: model output is untrusted until a deterministic
  check clears it.
```

**Seam:** the guardrail boundary is precisely "model output → deterministic check → allowed effect." Today there's no model output to check, so the seam is dormant, not absent — the check function contract (`CatalogCheck.run(ctx): CatalogFinding[]`) is already shaped to receive *some* catalog state and return a structured verdict, whether that state comes from a real read (today) or a proposed write (Bulk AI).

## How it works

### Move 1 — the mental model

You've built a form validator that runs before a submit handler is allowed to fire — the guardrail here is the same idea at a bigger scale: don't let untrusted input (a model's proposal) reach a real effect (writing to Shopify) without a validation pass in between that you, not the model, control.

```
┌───────────────────────────────────────────────┐
│  Input guardrail   (validate / sanitize)      │
└────────────────────┬──────────────────────────┘
                     ▼
┌───────────────────────────────────────────────┐
│  Agent loop                                   │
│   • iteration cap (max steps)                 │
│   • token / cost budget (halt at ceiling)     │
│   • human-in-the-loop pause (gated actions)   │
└────────────────────┬──────────────────────────┘
                     ▼
┌───────────────────────────────────────────────┐
│  Output guardrail  (schema, safety check,     │
│  never let agent output trigger side effects  │
│  directly — go through your code)             │
└───────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Why this is its own concept, not just "add validation":** an agent without caps loops silently and burns tokens (the budget-exit failure named in `01-reasoning-patterns/02-agent-loop-skeleton.md`); an agent whose output triggers side effects directly is a prompt-injection liability — a malicious or malformed input to the loop (a poisoned product title, say) could otherwise steer the model into proposing a harmful action that executes unchecked. The output guardrail is the fix: the model's output is a *proposal*, never an action, and something deterministic has to approve it first.

**The real code that already plays this role.** Read `runChecks` next to the guardrail diagram above — this is Move 1's bottom box, already built:

```typescript
// app/packages/catalog-checks/src/run.ts:26-28
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

And the shape of what one check returns — this is the "structured verdict" a guardrail needs, not a free-text judgment:

```typescript
// app/packages/catalog-checks/src/contract.ts:11-25
export interface CatalogFinding {
  id: string;
  checkId: string;
  severity: FindingSeverity;   // CRITICAL / WARNING / UNAVAILABLE
  // ...
  explanation: string;          // human-readable, why this fired
  evidence: Record<string, string | number | boolean | null>;  // the exact data that triggered it
  detectedAt: string;
}
```

`severity`, `evidence`, and `explanation` together are exactly what an output guardrail needs to hand back to a proposing agent: not just pass/fail, but *which* rule fired, *why*, and *what data* triggered it — enough for the agent to revise a rejected proposal instead of just retrying blindly. This is the same "grounded observation" idea `01-reasoning-patterns/03-react.md`'s Observation step needs, already built, just not yet wired to a loop.

**What's genuinely missing, named honestly.** Three things this codebase does not have yet, and why each matters for Bulk AI specifically:

- **Iteration cap / cost ceiling** — nothing in this repo bounds "how many times can the agent revise and resubmit a rejected changeset." Without one, a changeset the guardrail keeps rejecting could loop indefinitely — the exact budget-exit lesson from the agent-loop-skeleton file, not yet needed because no loop exists.
- **Human-in-the-loop gate** — MerchGrid's own read-only scope constraint (`read_products,read_inventory` only, no write scopes at all, per `.aipe/project/context.md`) means *nothing in the current app can write to Shopify regardless of any guardrail*. Bulk AI would need write scopes and, almost certainly, a human-approval gate before any changeset actually applies — the guardrail rejecting a bad proposal isn't the same as a human approving a good one.
- **Never let agent output trigger the effect directly** — this is the rule Bulk AI would have to hold from day one: the agent proposes, `runChecks` (or its Bulk-AI-specific extension) validates, and only a separate, human-gated apply step ever calls a Shopify mutation. The agent should never be one step away from a live write.

### Move 3 — the principle

A guardrail's value isn't that it blocks bad output — it's that it turns a model's output from an action into a proposal, with a deterministic, explainable check standing between the two. This codebase already built the deterministic, explainable half of that pair as its core product; it just hasn't needed the "proposal" half yet, because there's no agent generating proposals. That ordering — build the guardrail before the thing it guards — is the right order to have built it in.

## Primary diagram

```
The guardrail envelope, today's real piece marked, the rest as the
Bulk AI gap

┌─ Input guardrail (not yet implemented — nothing to sanitize yet) ─┐
└─────────────────────────┬─────────────────────────────────────────┘
                          │
┌─ Agent loop (not yet implemented — no loop exists) ────────────────┐
│  • iteration cap — MISSING                                        │
│  • cost ceiling — MISSING                                          │
│  • human-in-the-loop pause — MISSING (write scopes don't exist    │
│    either, so nothing to gate yet)                                 │
└─────────────────────────┬─────────────────────────────────────────┘
                          │
┌─ Output guardrail ───────▼─────────────────────────────────────────┐
│  ★ THE ENGINE ★ runChecks(ALL_CHECKS, ctx) — REAL, BUILT TODAY    │
│  app/packages/catalog-checks/src/run.ts:26-28                     │
│  contract.ts's CatalogFinding: severity + evidence + explanation  │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

Guardrails-and-control is the discipline most agent demos skip and most production incidents trace back to — an agent without a hard iteration cap that burns an unbounded budget, or an agent whose output writes directly to a database with no human or deterministic check in between, is a well-documented failure class in the industry (see `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md`'s coordination-cost framing for the multi-agent version of the same over-trust mistake). This codebase's own product-safety posture — read-only Shopify scopes, no write path anywhere, decimal-only money math, `SESSION_ENCRYPTION_KEY` handling — is the same instinct applied to the *current*, non-agentic product: build the safety rail before you build the thing that needs restraining. Bulk AI inherits that instinct for free if it reuses `runChecks` as its guardrail rather than rebuilding validation from scratch.

## Interview defense

**Q: "Does this codebase have agent guardrails?"**
A: Not as a wired-up control envelope — there's no agent loop to guard yet. But the *engine half* of a guardrail already exists and is explicitly designed for this reuse: `runChecks` (`app/packages/catalog-checks/src/run.ts`) is a deterministic function that takes a catalog state and returns structured, explainable verdicts (severity, evidence, explanation per `contract.ts`) — exactly the shape a future agent's proposed changesets would need to clear before they're allowed to apply.
*Sketch while you say it:* the primary diagram, pointing at the "real, built today" box.

**Q: "What's still missing before this could safely guard an actual agent?"**
A: Three things, and I'd name them unprompted: an iteration cap / cost ceiling on however many times the agent can revise and resubmit; a human-in-the-loop approval gate, since the app currently has zero write scopes to Shopify at all; and the discipline that the agent's output only ever becomes a proposal that a separate apply step executes — never a mutation the agent triggers directly.

**Q: "Why build the guardrail before the agent it guards?"**
A: Because the guardrail is also this product's actual value proposition today — deterministic, explainable catalog checks are the whole app. Building it first meant it could ship as a real product on its own, and it happens to be exactly the control a future agent would need, without having been built as an afterthought bolted onto a rushed agent.

## See also

- `01-reasoning-patterns/01-chains-vs-agents.md` — the layers-and-hops diagram showing exactly where this guardrail would attach if Bulk AI is built.
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the iteration-cap / budget-exit discipline this file's "missing pieces" section points back to.
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — the closest system-design template to Bulk AI's shape (plan/propose → verify → apply), with this file's guardrail as the verification stage.
- `.aipe/project/context.md` — "Engine purity" and the explicit Bulk-AI-reuse note this file's grounding comes from.
