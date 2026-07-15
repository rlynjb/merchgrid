# Chains vs. agents — the boundary

Industry standard. The first fork in the road for any system that runs a multi-step process: does the *code* decide what happens next, or does a *model* decide?

## Zoom out, then zoom in

```
Zoom out — where this decision sits in MerchGrid

┌─ UI layer ───────────────────────────────────────────────────┐
│  onboarding action → triggers a scan → polls for progress    │
└─────────────────────────────┬──────────────────────────────────┘
                              │ enqueueScan()
┌─ Service layer ─────────────▼──────────────────────────────────┐
│  worker-core.server.ts: claimAndRunNext()                     │
│  runner.server.ts:      runScan()                              │
│  ★ THIS IS THE BOUNDARY ★ — is the next step chosen by code   │
│  or by a model? In this repo: always by code.                 │
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Engine layer ───────────────▼──────────────────────────────────┐
│  runChecks() — 10 deterministic rule functions                 │
└──────────────────────────────────────────────────────────────────┘
```

You already know the shape of a chain even if you've never called it that — every `.then().then().then()` you've written, every Express middleware stack, every reducer pipeline is one. A chain is: the engineer writes the sequence of steps at build time, and the code walks that fixed sequence every time it runs. An agent is the same *shape* of "do step, then step, then step" — except the sequence isn't fixed. At each point, a model looks at where things stand and decides what the next step should be, and that decision is not knowable in advance.

MerchGrid is a chain, full stop — and a well-built one. There is no point in this codebase where a model chooses the next action, because there is no model in this codebase at all. This file walks the real pipeline as the chain worked example, then builds the agent loop shape *only* as the counterfactual you'd be comparing against if this codebase ever grew one (which, per the product's own future plans, it might).

## The structure pass

**Layers:** UI (Remix routes) → Service (`runScan`, `claimAndRunNext`) → Engine (`runChecks`) → Storage (SQLite/Prisma).

**Axis to trace: control — who decides what happens next?**

```
One axis, traced down through MerchGrid's real layers

  ┌────────────────────────────────────┐
  │ UI: onboarding action              │  → USER decides to start a scan
  └────────────────────────────────────┘
        ┌────────────────────────────────────┐
        │ Service: runScan's pipeline         │  → CODE decides the next
        │ (read → normalize → runChecks →     │    stage (state.ts's
        │  persist)                           │    transition table)
        └────────────────────────────────────┘
              ┌────────────────────────────────────┐
              │ Engine: runChecks(ALL_CHECKS, ctx)  │  → CODE decides which
              │                                     │    checks run (all of
              │                                     │    them, every time)
              └────────────────────────────────────┘

  the answer never flips — it's CODE all the way down.
  this IS the finding: there's no seam here for control to
  hand off to a model, because nothing hands off. that's what
  "chain" means structurally.
```

**Seam:** the one seam worth naming is the boundary between the worker (`worker-core.server.ts`) and the pipeline (`runner.server.ts`) — `claimAndRunNext` decides *which scan* runs next (oldest QUEUED), but never *what steps* that scan takes. That's a scheduling decision, not a control-flow decision, and it stays code-decided too. There is no boundary in this repo where the axis flips from code to model — which is exactly the fact this file is teaching you to recognize and name.

## How it works

### Move 1 — the mental model

Picture the two shapes side by side. A chain looks like a hallway with fixed doors in a fixed order; an agent looks like a room with a person in it deciding which door to open next based on what they see.

```
Chain (engineer writes the steps)

  Input → Step 1 → Step 2 → Step 3 → Output
          (each step is fixed code; nothing
           "chooses" what runs next — it's
           already written down)

Agent (model writes the steps, at runtime)

  ┌───────────────────────────────────────────────┐
  │              Agent control loop                │
  │   ┌─────────┐                                  │
  │   │ Reason  │ ← model decides next action       │
  │   └────┬────┘                                  │
  │        ▼                                       │
  │   ┌─────────┐                                  │
  │   │ Act     │ ← call a tool                     │
  │   └────┬────┘                                  │
  │        ▼                                       │
  │   ┌─────────────┐                              │
  │   │ Observe     │ ← read result                 │
  │   └────┬────────┘                              │
  │        └──────────── loop or stop               │
  └───────────────────────────────────────────────┘
```

The underlying strategy in one sentence: pick a chain when you know every step in advance and the order never depends on what a previous step found out; reach for an agent only once the step sequence genuinely can't be written down ahead of time.

### Move 2 — the pipeline, read as a chain

**The four fixed stages.** `runScan` (`app/app/services/scan/runner.server.ts:59-225`) walks exactly one sequence, every single time, for every shop:

```python
# runner.server.ts:95-139 — plain-English shape of the real code
assertTransition(currentStatus, "READING_CATALOG")     # stage 1
raw = readCatalog(admin, { variantLimit, ... })

assertTransition(currentStatus, "RUNNING_CHECKS")       # stage 2
snapshot = normalizeCatalog(raw, { shopId, currencyCode, ... })
findings = runChecks(ALL_CHECKS, ctx)

assertTransition(currentStatus, "PREPARING_RESULTS")    # stage 3
# (compute counts, build finding rows)

assertTransition(currentStatus, "COMPLETED")            # stage 4
# atomic transaction: delete stale findings, insert fresh, mark COMPLETED
```

Every one of those four `assertTransition` calls is the code asking "am I allowed to move to the next stage?" — and the answer is looked up in a table, not decided in the moment. Here's the actual table:

```typescript
// state.ts:23-28 — the ENTIRE decision procedure for "what comes next"
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```

That object literal *is* the control flow. There is exactly one legal next status for any given status — no branching, no "the model looked at the catalog and decided to skip normalization." `assertTransition` (`state.ts:40-56`) throws if anything ever tries to violate that table, which is the codebase actively defending its own chain-ness: even a bug that tried to jump straight from `QUEUED` to `COMPLETED` would be caught and thrown, not silently allowed.

**The engine step is the same story, one layer down.** `runChecks` (`app/packages/catalog-checks/src/run.ts:26-28`) is:

```typescript
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

Every one of the 10 checks in `ALL_CHECKS` runs, every time, in the same order, against the same normalized snapshot. There's no branch where check MG-003's result changes whether MG-007 runs. Compare that to an agentic system, where a router or a supervisor might decide "skip the pricing checks, this catalog has no price data" — that's a model-decided branch, and this codebase has none.

**Bridge to what you already know:** this whole pipeline is a `.then()` chain wearing a state-machine costume. `readCatalog(...).then(normalizeCatalog).then(runChecks).then(persist)` is functionally what's happening — `state.ts` just makes each hop an explicit, checkable, persisted fact (so a crashed process can tell you exactly which stage it died in) instead of an implicit promise chain that vanishes on crash.

### Move 2 — what an agent loop would look like here, and where it would attach

The counterfactual matters because the product roadmap names it directly: **"MerchGrid: Bulk AI"** (per `.aipe/project/context.md`) is a planned future product where an LLM proposes catalog changesets. If that ships, here's the seam that would flip:

```
Layers-and-hops — where control would flip from code to model

┌─ Today (this repo) ─────────────────────────────────────────┐
│  runScan(): CODE walks read → normalize → runChecks →       │
│             persist, in that fixed order, always            │
└──────────────────────────┬────────────────────────────────────┘
                           │  the pipeline stays — Bulk AI reuses
                           │  catalog-core + catalog-checks as-is
┌─ Future (Bulk AI, not built) ─────────▼────────────────────────┐
│  an LLM reasons over findings → proposes a changeset          │
│  (hop: model emits an "action" — a proposed price/SKU fix)    │
│  ★ runChecks() re-runs as the GUARDRAIL against the proposal ★│
│  (hop: guardrail approves/rejects — feeds back to the model)  │
│  MODEL decides whether to revise the changeset and retry      │
└──────────────────────────────────────────────────────────────────┘
```

Notice what does *not* change: `catalog-core` and `catalog-checks` stay exactly as they are today — pure, deterministic, Shopify-independent (per `.aipe/project/context.md`'s "Engine purity" rule). The flip only happens one layer up, in a new orchestration layer that doesn't exist yet. That's the load-bearing insight: **you don't rebuild the deterministic engine to add an agent — you wrap it.** The engine becomes the guardrail an agent has to satisfy, not something the agent replaces. `04-agent-infrastructure/01-guardrails-and-control.md` and the SECTION F templates work this out concretely.

### Move 3 — the principle

The decision rule generalizes past this repo: use a chain when you can write the steps down before you see the data; reach for an agent only when the step sequence itself depends on what a previous step discovers, and you've confirmed a chain genuinely can't express that dependency. MerchGrid never crosses that line — every "what if the catalog is huge" or "what if a check needs another check's output" question it faces is answered with a guardrail (a variant-limit cap, a fixed check order), not a model decision. That's a deliberate, correct choice for an audit product where the whole value proposition is explainability: a merchant needs to trust that MG-003 always fires the same way given the same inputs, and a fixed chain gives you that for free. An agent would not.

## Primary diagram

```
The full picture — MerchGrid's real chain, and the agent seam it doesn't cross

┌─ Worker (bounded poll loop) ──────────────────────────────────┐
│  claimAndRunNext() — picks oldest QUEUED scan (code-decided)  │
└─────────────────────────┬──────────────────────────────────────┘
                          │ scanId, admin client
┌─ runScan() — THE CHAIN ─▼──────────────────────────────────────┐
│                                                                │
│  QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED
│  (state.ts's LEGAL_FORWARD_TRANSITIONS: exactly one next step │
│   at every stage — no branch, no model, no choice)             │
│                                                                │
│         ┌───────────────────────────────────────┐             │
│         │  runChecks(ALL_CHECKS, ctx)            │             │
│         │  10 fixed checks, same order, every run│             │
│         └───────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────────┘
                          │
             ✗ no seam here today — this is where an agent
               (Bulk AI, not built) would attach, with
               runChecks() re-purposed as its guardrail
```

## Elaborate

The chain-vs-agent distinction is one of the first things every serious LLM-application team relearns the hard way: agents are expensive (variable cost, variable latency, harder to debug) and most tasks don't need one. The pattern of "start as a chain, escalate to an agent only when a step's necessity depends on a prior step's discovery" is standard industry wisdom now — see `01-reasoning-patterns/03-react.md`'s escalation framing for the single-agent version of the same discipline. This codebase is the clean opposite case study: an audit product where full determinism is the *product requirement* (explainability, reproducibility, no write scopes), so the "start as a chain" default was never revisited — and shouldn't be, for this product as it exists today. The interesting future work is entirely in Bulk AI, a genuinely different product with a genuinely different requirement (propose changes, not just detect them), which is exactly the kind of requirement that can justify an agent.

## Interview defense

**Q: "Does this codebase use any agents?"**
A: No — MerchGrid: Catalog Audit is fully deterministic. The scan pipeline (`runScan`) is a fixed four-stage chain enforced by an explicit state-machine transition table (`state.ts`'s `LEGAL_FORWARD_TRANSITIONS`), and the check engine (`runChecks`) runs the same 10 rule functions in the same order every time. There's no point where a model decides the next step, because there's no model in the runtime at all.
*Sketch while you say it:* the "one axis, traced down" diagram from the structure pass — control stays CODE at every layer.

**Q: "If you had to add an agent to this system, where would it go?"**
A: Not inside the existing pipeline — around it. The product's own roadmap names the seam: a future "Bulk AI" product where an LLM proposes catalog changesets, with the existing deterministic engine (`catalog-core` + `catalog-checks`) reused unmodified as the guardrail that validates every proposal before it's allowed to apply. The engine doesn't get rebuilt; it gets repurposed as the thing the agent has to satisfy.
*Sketch while you say it:* the layers-and-hops "today vs future" diagram from Move 2.

**Q: "Isn't a fixed pipeline just a worse agent — less flexible?"**
A: No — it's the correct choice when the product's value is deterministic, explainable output. A merchant needs MG-003 to fire identically on identical data every time; an agent deciding at runtime whether to run a check would break that guarantee for no benefit, since the step sequence here never actually depends on what a prior step discovers (every check runs against the same normalized snapshot regardless of what other checks found). The load-bearing skeleton part people forget to name: termination. Even without a model, this pipeline still has to know when to stop — `state.ts` gives it exactly one terminal path (`COMPLETED`) and one failure escape (`FAILED` from any non-terminal status), which is the same two-exit discipline `02-agent-loop-skeleton.md` teaches for an actual reasoning loop.

## See also

- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel an agent loop would need if this pipeline's control did flip to model-decided; termination and the two-exit rule get their own file.
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the equivalent escalation gate one level up, for whether Bulk AI would ever need more than one agent.
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — the closest system-design template to what Bulk AI would be: an agent that plans and executes changes against a codebase-like target, verified before it applies them.
- `.aipe/project/context.md` — "Engine purity" and the Bulk AI mention that ground this file's counterfactual.
