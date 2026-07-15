# Agent architecture — MerchGrid: Catalog Audit

**Say it plainly, up front: this app has no AI agents.** There is no LLM call anywhere in the runtime, no reasoning loop, no tool-calling model, no retrieval, no prompt. MerchGrid: Catalog Audit is a **deterministic** Shopify admin app — it reads a merchant's catalog, runs 10 fixed rule-based checks (`MG-001`…`MG-010`) against it, and writes out explainable findings. `.aipe/project/context.md` says it directly: *"Deterministic, not AI... do not add LLM/AI to the first app."*

That's not a gap in this guide — it's a fact about the codebase, and this guide names it honestly rather than inventing an agent that isn't there.

```
Zoom out — where "agent architecture" would live, if it lived anywhere

┌─ UI layer ───────────────────────────────────────────────────┐
│  Remix routes (Polaris) → poll scan progress → render findings│
└─────────────────────────────┬──────────────────────────────────┘
                              │ HTTP (same-process)
┌─ Service layer ─────────────▼──────────────────────────────────┐
│  runScan()  =  read → normalize → runChecks → persist          │
│  ★ THIS IS A FIXED PIPELINE — CODE decides the next step ★     │
│  worker-core.server.ts: claimAndRunNext() — bounded poll loop  │
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Engine layer (pure) ───────▼──────────────────────────────────┐
│  runChecks(ALL_CHECKS, ctx) → CatalogFinding[]                 │
│  10 deterministic rule functions, zero I/O                     │
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Storage layer ─────────────▼──────────────────────────────────┐
│  SQLite (Prisma) — Scan, Finding, ShopSettings                 │
└──────────────────────────────────────────────────────────────────┘

┌─ Where an agent COULD live (does not exist yet) ────────────────┐
│  "MerchGrid: Bulk AI" (planned, future product)                 │
│  an LLM proposes catalog changesets (price fixes, SKU cleanup)  │
│  → runChecks() is the designed PREFLIGHT/GUARDRAIL that would   │
│    validate the agent's proposed changes before they ship       │
└──────────────────────────────────────────────────────────────────┘
```

## The one real, transferable structure in this repo

Every generic agent-architecture concept — ReAct, plan-and-execute, supervisor-worker, agentic RAG — is marked `not yet exercised` throughout this guide, because none of it exists in the code. But one real structure in this repo IS a genuine orchestration system, and it's worth studying carefully because it's the same *shape* of problem an agent loop solves, solved a different way:

**The scan pipeline + worker** (`app/app/services/scan/runner.server.ts`, `worker-core.server.ts`, `state.ts`, plus the bounded pagination loop in `app/app/services/shopify/catalog-reader.server.ts`) is a **deterministic orchestration**: a fixed-order pipeline (`read → normalize → runChecks → persist`), a state machine that only allows one legal next status, and a bounded worker loop that polls, claims, and yields — never spins unbounded, never gets stuck on a poison-pill row.

The teaching payoff of studying this system under an "agent architecture" lens is the contrast it sets up. An agent loop and this pipeline solve the same category of problem — "run a sequence of steps toward a goal, and know when to stop" — with one variable flipped:

```
One question, held constant — "who decides what happens next?"

  ┌─────────────────────────────────────────────┐
  │  MerchGrid's scan pipeline (runScan)         │   → CODE decides
  │  read → normalize → runChecks → persist       │     (fixed order,
  │  the next status is looked up in a table,    │      hardcoded in
  │  never chosen at runtime                     │      state.ts)
  └─────────────────────────────────────────────┘
                        vs.
  ┌─────────────────────────────────────────────┐
  │  An agent loop (not in this codebase)        │   → MODEL decides
  │  reason → act → observe → reason again        │     (the LLM picks
  │  the next action is chosen per-step by an     │      the next tool
  │  LLM inspecting the current state             │      call, per turn)
  └─────────────────────────────────────────────┘

  same shape (loop + state + termination) — different decision-maker
```

This is the seam this guide keeps coming back to: **where would this pipeline flip from code-decided to model-decided, and what would that cost?** `01-reasoning-patterns/01-chains-vs-agents.md` and `01-reasoning-patterns/02-agent-loop-skeleton.md` walk this in full, grounded in the real files and line numbers.

The second real connection: `runChecks()` (`app/packages/catalog-checks/src/run.ts:26-28`) isn't just today's audit engine — per `.aipe/project/context.md`, the two engine packages (`catalog-core`, `catalog-checks`) are **"designed for reuse by a planned future 'MerchGrid: Bulk AI' product (changeset preflight)."** That's the actual, designed-in future seam where an agent would show up: an LLM proposing catalog changes, with this deterministic check engine sitting in front of it as the guardrail that validates every proposed change before it's allowed to apply. `04-agent-infrastructure/01-guardrails-and-control.md` and the SECTION F templates in `06-orchestration-system-design-templates/` work that out concretely.

## How this guide is organized

```
.aipe/study-agent-architecture/
  00-overview.md                              ← you are here
  README.md                                   ← reading order
  01-reasoning-patterns/                      ← the real orchestration lives here
  02-agentic-retrieval/                       ← skipped — no retrieval anywhere
  03-multi-agent-orchestration/               ← one boundary file only
  04-agent-infrastructure/                    ← guardrails, grounded in runChecks
  05-production-serving/                      ← skipped — zero LLM calls in prod
  06-orchestration-system-design-templates/   ← always generated; the Bulk-AI refactor
  agent-patterns-in-this-codebase.md          ← the honest inventory
```

**Codebase shape: workflow/chain** — fixed, known steps; no autonomous loop; the closest of the three generic shapes (workflow/chain, single-agent, multi-agent) to what this repo actually does, even though "workflow" itself implies an LLM filling slots and this codebase doesn't even have that. Every "In this codebase" section in every concept file is honest about that. Where a concept doesn't apply to this codebase's shape at all (agentic retrieval, production serving for agent loops), the sub-section is skipped outright rather than padded with a hollow "not yet implemented" write-up — see each skipped sub-section's `README.md` for the one-line reason.

Read `agent-patterns-in-this-codebase.md` next for the concrete inventory, or jump straight to `01-reasoning-patterns/01-chains-vs-agents.md` for the deterministic-pipeline-vs-agent-loop contrast that's the spine of this whole guide.
