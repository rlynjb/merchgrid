# Agent patterns in this codebase

Said plainly: **this codebase does not currently use any autonomous agent loop, and has no LLM calls anywhere in its runtime.** MerchGrid: Catalog Audit is fully deterministic — the product spec and `.aipe/project/context.md` both say so directly ("Deterministic, not AI... do not add LLM/AI to the first app").

## Agent patterns table

| Feature | Pattern / shape | Why this pattern |
|---|---|---|
| Scan pipeline (`runScan`) | Fixed chain (workflow, no LLM) | The product's value is deterministic, reproducible, explainable audit results — a merchant needs MG-003 to fire identically on identical data every time. An agent choosing whether to run a check would break that guarantee for no benefit, since no step's necessity ever depends on what a prior step discovers. |
| Worker (`claimAndRunNext`) | Bounded poll loop, code-decided | Scheduling ("which scan runs next") is a code decision (oldest `QUEUED`), not a reasoning decision — there's exactly one legal answer, so there's nothing for a model to decide. |
| Check engine (`runChecks`) | Deterministic rule engine (no reasoning) | 10 fixed, independently-testable rule functions running unconditionally against a normalized snapshot — this is the product itself, not a component that stands in for a reasoning step. |

That's the whole table. There is no ReAct loop, no plan-and-execute, no reflexion, no tree of thoughts, no supervisor-worker, no retrieval of any kind — because there's no model anywhere in the runtime to instantiate any of those patterns.

## What IS here, described honestly

Two real orchestration structures exist and are genuinely worth studying, even though neither is agentic:

- **The scan pipeline as a deterministic orchestration.** `runScan` (`app/app/services/scan/runner.server.ts:59-225`) walks a fixed four-stage sequence (`read → normalize → runChecks → persist`), enforced by an explicit state-machine transition table (`app/app/services/scan/state.ts:23-28`) that allows exactly one legal next status per stage and throws on any attempted deviation. Full walkthrough: `01-reasoning-patterns/01-chains-vs-agents.md`.
- **The worker as a bounded loop.** `worker.ts:69-89`'s poll loop and `app/app/services/shopify/catalog-reader.server.ts:410-451`'s pagination loop both carry the same load-bearing discipline a reasoning loop needs — state, execution, and two real termination exits (a success condition and a hard budget/shutdown signal) — with a fixed, non-model step function. Full walkthrough: `01-reasoning-patterns/02-agent-loop-skeleton.md`.

**Control envelope, for both:** neither loop needs an iteration cap in the agentic sense, because neither has an unbounded reasoning step — but both already carry the equivalent discipline: `catalog-reader.server.ts`'s `variantLimit` is a hard budget cap on the read loop, and `worker.ts`'s `SIGINT`/`SIGTERM` handling is a graceful, externally-triggered shutdown for the poll loop. **Eval:** none in the agentic sense (no trajectory, no tool-call accuracy to measure) — correctness is instead verified by unit tests over each check function (`app/packages/catalog-checks/tests/`) and a golden-eval fixture suite (`npm run eval`, 17 fixtures with independently-specified expected findings) that checks the deterministic engine's output directly, which is a stronger guarantee than any agent trajectory eval could offer for this kind of task.

## Where an agent would go, if one is ever built

Per `.aipe/project/context.md`, the two engine packages (`catalog-core`, `catalog-checks`) are already "designed for reuse by a planned future 'MerchGrid: Bulk AI' product (changeset preflight)." That's the actual, designed-in seam:

```
An agent would attach here — not by replacing the engine, but by
wrapping it:

  Bulk AI (not built): LLM proposes a catalog changeset
        │
        ▼
  runChecks() re-run against the proposed state ─── THE GUARDRAIL
        │                                            (already built,
        ▼                                             already tested)
  approved → human-gated apply step → Shopify write (no write
             scope exists today, by design)
```

See `06-orchestration-system-design-templates/03-agentic-coding-system.md` for the closest system-design template to this shape, and `04-agent-infrastructure/01-guardrails-and-control.md` for the full breakdown of what's built (`runChecks` as the output guardrail) versus what's still missing (iteration caps, a human-in-the-loop gate, write scopes).
