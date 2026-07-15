# Agents vs. Chains

**Chain (fixed sequential pipeline) vs. Agent (LLM-directed control loop) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where this decision sits in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions          │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  queue.server.ts → runner.server.ts (runScan) → state.ts         │
│  ★ THIS IS THE FORK IN THE ROAD ★ — does code pick the next step │
│  or does a model? In this repo: always code. This is a chain.   │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-core, packages/catalog-checks ──┐
│  normalizeCatalog() → runChecks(ALL_CHECKS, ctx)                 │
│  10 hand-written rules, fixed order, zero ML                     │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Shop, ShopSettings, Scan, Finding tables                          │
└───────────────────────────────────────────────────────────────────┘
```

You already know a chain even if you've never called it that — every `.then().then().then()`, every Express middleware stack, every reducer pipeline is one: the engineer writes the sequence of steps at build time, and the code walks that exact sequence every time it runs, unconditionally. An agent keeps the same "do a step, then another step" shape, but the sequence isn't fixed — at each point a model looks at where things stand and decides what happens next, and that decision isn't knowable in advance by reading the source.

MerchGrid is a chain, full stop. This file teaches the general fork in the road — chain vs. agent — using the real pipeline as the chain worked example, then builds the agent-loop shape as the pure counterfactual: the thing this codebase would become *if* it ever grew the LLM-driven bulk editor its own roadmap names.

## Structure pass

**Layers:** UI (Remix routes) → Service (`runScan`, `state.ts`) → Engine (`runChecks`) → Storage (Prisma/SQLite).

**Axis to trace: control — who decides what happens next?** UI: the merchant decides *when* (clicks "Start scan"). Service: `runScan` (`app/app/services/scan/runner.server.ts` lines 59-225) walks a hardcoded sequence — `readCatalog` → `normalizeCatalog` → `runChecks` → persist — and every hop between stages is gated by `assertTransition` (`app/app/services/scan/state.ts` lines 40-56), which looks the next legal status up in a plain object literal (`LEGAL_FORWARD_TRANSITIONS`, lines 23-28) and throws if anything tries to skip a step. Engine: `runChecks` (`app/packages/catalog-checks/src/run.ts` lines 26-28) is a `flatMap` over a fixed array — same 10 checks, same order, every run.

**Seam:** there isn't one where this axis flips. Code decides at every layer, all the way down — that absence of a flip is the finding itself. The only thing worth naming as a seam-shaped boundary is `queue.server.ts`'s scan-claiming step, which picks *which* scan runs next (oldest `QUEUED`) — a scheduling decision, still code-decided, never a "what steps should this scan take" decision.

## How it works

### Move 1 — the mental model

You've written a `.then()` chain and you've probably sketched a state machine on a whiteboard. A chain is that state machine with exactly one outgoing arrow per node — there's no decision, just a walk. An agent is the same node-and-arrow picture with a model sitting at each node choosing which arrow to take, based on what it's just observed.

```
Pattern — chain vs. agent, side by side

  Chain (engineer writes the steps)

    Input → Step 1 → Step 2 → Step 3 → Output
            (each arrow is fixed at build time;
             nothing "chooses" — it's already written)

  Agent (model writes the steps, at runtime)

    ┌─────────────────────────────────────────┐
    │             Reason → Act → Observe        │
    │   ┌────────┐     ┌────────┐   ┌─────────┐ │
    │   │ Reason │────►│  Act   │──►│ Observe │ │
    │   └────────┘     └────────┘   └────┬────┘ │
    │        ▲                            │      │
    │        └────────── loop or stop ─────┘      │
    └─────────────────────────────────────────┘
```

The underlying strategy in one sentence: pick a chain when you can write every step down before you see the data; reach for an agent only once the step sequence itself depends on something a previous step discovers.

### Move 2 — the step-by-step walkthrough

**Part 1 — the four fixed stages, read as a chain.** Pseudocode for `runScan`'s real shape:

```
function runScan(scanId):
  scan = loadScan(scanId)                        // stage 0: load
  assertTransition(current, READING_CATALOG)      // stage 1
  raw = readCatalog(admin, settings)
  assertTransition(current, RUNNING_CHECKS)        // stage 2
  snapshot = normalizeCatalog(raw)
  findings = runChecks(ALL_CHECKS, ctx)
  assertTransition(current, PREPARING_RESULTS)     // stage 3
  // build finding rows, compute counts
  assertTransition(current, COMPLETED)             // stage 4
  // atomic transaction: delete stale findings, insert fresh, mark COMPLETED
```

Every `assertTransition` call is the code asking "am I allowed to advance?" — and the answer is a table lookup, not a judgment call:

```typescript
// app/app/services/scan/state.ts lines 23-28 — the entire "what's next" procedure
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```

That object literal *is* the control flow. One legal next status per current status — no branch, no "the model looked at the catalog and decided to skip normalization." `assertTransition` throws on any other attempted hop, which is the codebase actively defending its own chain-ness.

**Part 2 — the engine repeats the pattern one layer down.** `runChecks` (`app/packages/catalog-checks/src/run.ts` lines 26-28) is:

```typescript
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

All 10 checks in `ALL_CHECKS` run, every time, in the same order, against the same normalized snapshot. There's no branch where MG-003's result changes whether MG-007 runs. An agentic system might have a router decide "skip the pricing checks, this catalog has no price data" — that's a model-decided branch, and none exists here.

**In this codebase:** fully a chain, nowhere an agent. Grep the repo and there's no LLM call, no place where "what runs next" is read off a model's output instead of a table or an array. If MerchGrid ships the roadmapped "MerchGrid: Bulk AI" (product spec §25.4), the fork this file teaches is exactly where it would show up: a new orchestration layer upstream of the existing pipeline, where an LLM proposes a changeset and decides how to respond to what the deterministic engine reports back — see `03-react-pattern.md` for that loop's shape. The pipeline you just walked (`catalog-core` + `catalog-checks`) would not be rebuilt; it would be reused unmodified as the guardrail the agent has to satisfy (spec §25.4's component-reuse table names `Check engine → Preflight every proposed edit` explicitly).

### Move 3 — the principle

The decision rule generalizes past this repo: use a chain when you can write the steps down before you see the data; reach for an agent only when the step sequence genuinely depends on what a previous step discovers, and a chain can't express that dependency with a guardrail or a config flag instead. MerchGrid never crosses that line — every "what if the catalog is huge" or "what if a check needs another check's output" question is answered with a fixed cap or a fixed order, not a runtime decision. That's deliberate: an audit product's entire value is explainability, and a fixed chain gives a merchant "MG-003 always fires the same way on the same data" for free. An agent would cost you that guarantee for a capability this product doesn't need yet.

## Primary diagram

```
The full picture — MerchGrid's real chain, and the seam it doesn't cross

┌─ runScan() — THE CHAIN ──────────────────────────────────────────┐
│                                                                    │
│  QUEUED ─► READING_CATALOG ─► RUNNING_CHECKS ─► PREPARING_RESULTS │
│                                                       │            │
│                                                       ▼            │
│                                                   COMPLETED        │
│  (state.ts's LEGAL_FORWARD_TRANSITIONS: exactly one next step     │
│   at every stage — no branch, no model, no choice)                │
│                                                                    │
│         ┌───────────────────────────────────────┐                │
│         │  runChecks(ALL_CHECKS, ctx)            │                │
│         │  10 fixed checks, same order, every run│                │
│         └───────────────────────────────────────┘                │
└─────────────────────────┬──────────────────────────────────────────┘
                          │
             ✗ no seam here today — this is where an agent
               (Bulk AI, not built, spec §25.4) would attach,
               with runChecks() re-purposed as its guardrail
```

## Elaborate

"Chain" as a term comes straight out of the early LangChain vocabulary (2022-2023) — a `Chain` was literally a class wrapping a fixed sequence of LLM calls and transformations. "Agent" in that same vocabulary meant a chain where one step was "ask the model which tool to call next," looped until the model said it was done. The industry lesson that followed, fast, was that agents are expensive — variable cost, variable latency, much harder to debug and to reproduce a specific failure — so the standard advice became: start with a chain, escalate to an agent only when a step's necessity depends on a prior step's discovery, and even then keep the loop as small and bounded as you can. MerchGrid is the clean case study for the *first* half of that advice: full determinism is the product requirement (explainability, reproducibility, no write scope), so "start as a chain" was never revisited for this product — and shouldn't be. The interesting escalation lives entirely in the *other*, unbuilt product, MerchGrid: Bulk AI, which has a genuinely different requirement (propose changes, not just detect them) — exactly the kind of requirement that can justify paying for a loop.

## Project exercises

### Convert the fixed pipeline into a toy agent loop, outside production code

- **Exercise ID:** EX-1
- **What to build:** A standalone script (not wired into the app) that takes `runChecks(ALL_CHECKS, ctx)` findings and, instead of always finishing after one pass, feeds a stub "model" a summary of the findings and lets the stub decide whether to re-run a *subset* of checks (e.g., "re-run only pricing checks because a margin finding looked suspicious"). No real API key — the stub is a hardcoded function that inspects the findings and returns a decision.
- **Why it earns its place:** It's the fastest way to feel the actual cost difference between a chain and an agent — you have to build the "decide what happens next" step yourself, including a stopping condition, instead of getting it for free from a table lookup.
- **Files to touch:** New scratch file, e.g. `app/scripts/toy-agent-loop.ts`; imports `ALL_CHECKS`/`runChecks` from `@merchgrid/catalog-checks` and a fixture `CatalogCheckContext`.
- **Done when:** Running the script prints a trace showing at least one "decide to loop again" step and one "decide to stop," using only the real `runChecks` as the executed action each time.
- **Estimated effort:** 1-2 hours.

### Trace the control axis through a real scan, end to end

- **Exercise ID:** EX-2
- **What to build:** Nothing new in production code — a short written trace (comments in a local, uncommitted branch, or a scratch note) annotating every call in `runScan` (`app/app/services/scan/runner.server.ts` lines 59-225) with "who decided this happens": merchant, code, or (hypothetically) model.
- **Why it earns its place:** Internalizing the control axis by tracing a real function is what makes the "MerchGrid is a chain" claim something you can defend from memory rather than recite.
- **Files to touch:** No production files — a scratch note or local comments only.
- **Done when:** You can list all five statuses in `state.ts`'s `LEGAL_FORWARD_TRANSITIONS` from memory and say, for each transition, whether anything other than code could ever have made that call in the current codebase.
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: Does this codebase use any agents?**
A: No. The scan pipeline (`runScan`) is a fixed four-stage chain enforced by an explicit transition table (`state.ts`'s `LEGAL_FORWARD_TRANSITIONS`), and the check engine (`runChecks`) runs the same 10 rule functions in the same order every time. There's no point where a model decides the next step, because there's no model in the runtime.
*Sketch while you say it:* the "one axis, traced down" list from the structure pass — control stays CODE at every layer.

**Q: If you had to add an agent to this system, where would it go?**
A: Not inside the existing pipeline — around it. The product's own roadmap (spec §25.4) names the seam: a future "Bulk AI" product where an LLM proposes catalog changesets, with the existing deterministic engine reused unmodified as the guardrail that validates every proposal before it applies. The engine doesn't get rebuilt; it gets repurposed as the thing the agent has to satisfy.
*Sketch while you say it:* the primary diagram's "no seam here today... this is where an agent would attach" callout.

**Q: Isn't a fixed pipeline just a worse agent — less flexible?**
A: No — it's correct when the product's value is deterministic, explainable output. A merchant needs MG-003 to fire identically on identical data every time; a model deciding at runtime whether to run a check would break that guarantee for no benefit, since the step sequence here never actually depends on what a prior step discovers. The skeleton part people forget to name: termination. Even without a model, this pipeline has to know when to stop — `state.ts` gives it exactly one terminal path (`COMPLETED`) and one failure escape (`FAILED`), the same two-exit discipline an actual reasoning loop needs (see `03-react-pattern.md`).

## See also

- `02-tool-calling.md` — the contract shape (`CatalogCheck`) that would become the agent's callable surface if this pipeline ever grew a model-decided branch.
- `03-react-pattern.md` — the loop shape a Bulk AI agent would run, with `runChecks` as its Action step.
- `06-error-recovery.md` — the same "is this real vs. counterfactual" discipline applied to failure handling instead of control flow.
- Product spec `merchgrid-catalog-audit-product-spec.md` §25.4 — the only place in this repo's own documentation that names an agent-shaped future flow.
