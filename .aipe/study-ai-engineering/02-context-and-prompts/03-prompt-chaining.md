# 03 — Prompt chaining

**Prompt chaining (sequential LLM pipeline / single-purpose chains) — Industry standard.** Breaking one big ask to a model into several smaller calls, each with one job, where step N's output becomes step N+1's whole input. `not yet exercised` in this codebase — there is no LLM call anywhere, so there is no chain of prompts. But this repo already has the *structural* shape a prompt chain would use — a fixed sequence of single-job steps, each handed exactly the prior step's output — in its scan pipeline. This file teaches the pattern in full, then walks that real pipeline as the closest possible anchor, and names precisely where the difference is (code decides every step here; an LLM would decide the *content* of at least one step in a real chain).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ UI layer — Remix routes ────────────────────────────────────────┐
│  app.scans.tsx (action) triggers a scan; app.scans.$id.tsx polls  │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ Remix action → enqueueScan()
┌─ Service layer — the scan pipeline IS a chain shape ─────────────▼─┐
│  queue.server.ts:enqueueScan → worker-core.server.ts:claimAndRunNext│
│    → runner.server.ts:runScan                                       │
│      (read catalog → normalize → runChecks → persist)                │
│                                                                        │
│  ★ THIS IS THE CHAIN SHAPE, MINUS ANY LLM STEP ★                      │
│    every step: one job, fixed order, output feeds the next            │
└─────────────────────────┬──────────────────────────────────────────────┘
                          │ pure function calls, in-memory
┌─ Engine layer — @merchgrid/catalog-core + catalog-checks ────────▼──────┐
│  normalizeCatalog(), runChecks() — each a single-purpose pure function  │
└─────────────────────────┬──────────────────────────────────────────────────┘
                          │ Prisma Client, one $transaction
┌─ Storage layer ─────────▼────────────────────────────────────────────────┐
│  SQLite: Scan (status machine), Finding rows                             │
└──────────────────────────────────────────────────────────────────────────┘
```

Zoom out: this app already runs a strict, ordered, single-purpose pipeline — enqueue, claim, read, normalize, check, persist — where each stage does exactly one thing and hands its output to the next stage as that stage's entire input. Zoom in: that is the *exact shape* of prompt chaining, mechanically. The only thing missing is a model making a decision at any of those steps — every step here is code, deciding deterministically, every time. Prompt chaining is what happens when you take this same shape and let an LLM own the transformation at one or more of the steps instead of a pure function.

## Structure pass

**Axis: control — who decides what happens at each step, and in what order?** Trace it down the real pipeline:

- `queue.server.ts:enqueueScan` (lines 44-78) — code decides: is there already an active scan for this shop? If not, create a `QUEUED` row. No branching on content, no judgment call — a fixed check against `ACTIVE_STATUSES`.
- `worker-core.server.ts:claimAndRunNext` (lines 30-80) — code decides: claim the single oldest `QUEUED` scan, obtain an admin client, hand off to `runScan`. Deterministic selection (`orderBy: { createdAt: "asc" }`), not a judgment call.
- `runner.server.ts:runScan` (lines 59-225) — code decides the *entire* sequence: `assertTransition` (from `state.ts`) gates every stage advance, so the order `READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS → COMPLETED` cannot be skipped or reordered, ever.
- Inside `runScan`, `runChecks(ALL_CHECKS, ctx)` runs ten independent check functions — each one a "single-purpose" unit doing exactly one check, with no dependency on another check's output.

**Seam:** every hop in this pipeline is a seam where one step's typed output becomes the next step's entire typed input — `readCatalog`'s `RawCatalog` becomes `normalizeCatalog`'s input, `normalizeCatalog`'s `snapshot` becomes `CatalogCheckContext`, `runChecks`'s `CatalogFinding[]` becomes the persist step's input. That's the identical seam shape a prompt chain uses (step 1's completion becomes step 2's prompt input) — the only axis-flip that would happen if this became a *real* prompt chain is right here: at least one of those hops would flip from "code decides the transformation" to "a model decides the transformation," and that flip is the entire reason chaining exists as a discipline instead of just "sequential function calls."

```
The seam — where control would flip from code to model

axis traced = "who decides the output of this step?"

┌─ this pipeline, every step, today ─┐  seam (hypothetical, Bulk AI) ┌─ a real chain ─┐
│  CODE decides:                       │ ══════════╪═════════════════► │ MODEL decides:  │
│  read → normalize → check → persist  │  (control would flip here)     │ summarize step, │
│  (deterministic, same output          │                                 │ classify step,   │
│   every time for the same input)      │                                 │ explain step     │
└────────────────────────────────────────┘                                 └──────────────────┘
        this repo has never crossed this seam — every step is still code
```

## How it works

### Move 1 — the mental model

You already know the "single responsibility function" idea — a function that does one thing is easier to test, retry, and reason about than one giant function that does five things and fails halfway with no clear rollback point. Prompt chaining is that same discipline applied to LLM calls: instead of one enormous prompt asking a model to summarize, classify, and explain all in one shot, you run three smaller calls, each with one job, and wire step N's output as step N+1's input. The strategy in one sentence: **decompose one hard prompt into several easy ones, in a fixed sequence, so each step can be tested, retried, and priced independently.**

```
Pattern — the chain shape

  input
    │
    ▼
┌────────────────────────┐
│  Step 1: single job     │   e.g. "summarize the raw facts,
│  (one prompt, one call) │        tone-agnostic"
└────────────┬─────────────┘
             │ output of step 1 = ENTIRE input to step 2
             ▼
┌────────────────────────┐
│  Step 2: single job     │   e.g. "given the summary,
│  (one prompt, one call) │        classify risk"
└────────────┬─────────────┘
             │ output of step 2 = ENTIRE input to step 3
             ▼
┌────────────────────────┐
│  Step 3: single job     │   e.g. "given the summary + risk,
│  (one prompt, one call) │        write the final explanation"
└────────────┬─────────────┘
             │
             ▼
       final output
```

### Move 2 — the step-by-step walkthrough

**Step 1 — decompose the ask before you decompose the code.** The design work happens before any function gets written: what's the smallest, most independently-testable unit of "thing an LLM needs to decide"? "Summarize this data" is one job. "Given a summary, decide if it's risky" is a different job. Bolting both into one prompt means one bad output taints both concerns and you can't tell which half failed.

**Step 2 — each step gets its own typed contract.** Just like a normal function signature, a chain step should have an explicit input type and output type — not "whatever text the model happened to write." This is what makes chaining debuggable: you can unit-test step 2 by handing it a fixed, known-good step-1 output, without ever calling a model for step 1.

```
Execution trace — a two-step chain, values at each hop

  step        input                          output
  ──────      ─────                          ──────
  Step 1      raw facts (500 words)       →  summary (80 words, tone-neutral)
  Step 2      summary (80 words)          →  final explanation (120 words,
              + target tone/history           merchant-facing tone)

  note: step 2 NEVER sees the original 500 words — only step 1's output.
  this is the isolation the pattern buys: step 2's prompt stays short,
  and a bug in step 2 can be reproduced with just the 80-word summary.
```

**Step 3 — errors are isolated to one step, and you can mix model tiers.** If step 2 (classification) fails or returns garbage, you know it's step 2 — you don't have to guess whether the summary or the classification logic broke, because they're separate calls with separate inputs and outputs. This also unlocks running a cheap, fast model on the "grunt work" steps (summarizing raw facts) and reserving the expensive, capable model for the step that actually needs judgment (the final synthesis).

**Step 4 — the tradeoff is real: more latency, more cost, more plumbing.** N sequential calls take roughly N times the latency of one call (they can't run in parallel — step 2 needs step 1's output to exist). N calls also cost N times the per-call overhead. And now there's error-handling code between steps that didn't exist when it was one call. Chaining is a deliberate trade of simplicity-per-call for reliability-and-testability-across-the-whole-task — not a free lunch.

**In this codebase:** not yet implemented as an LLM chain, but the *scaffolding* already exists and is worth reading closely, because it's the same shape with the "step" content just being code instead of a model call. `queue.server.ts:enqueueScan` (lines 44-78) → `worker-core.server.ts:claimAndRunNext` (lines 30-80) → `runner.server.ts:runScan` (lines 59-225) is a fixed, single-worker, single-purpose sequence — and inside `runScan` itself, `state.ts`'s `assertTransition` (referenced in `runner.server.ts:95, 111, 132, 139`) enforces that the four internal stages (`READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS → COMPLETED`) can never run out of order, exactly the discipline a chain orchestrator needs to enforce between LLM calls. The one thing missing, precisely: every step in this real pipeline is deterministic TypeScript. A prompt chain's defining feature — a model making a genuinely non-deterministic decision at one or more steps — doesn't happen anywhere here.

**Future attachment point (speculative — not built):** the product spec itself names the plausible shape (spec §25.4, line 1639: *"MerchGrid: Catalog Audit component | MerchGrid: Bulk AI use"*) — this app's check engine becomes a preflight layer for a future changeset tool. A concrete future chain, sitting logically right after today's `runChecks` call and not yet built anywhere in this repo: **normalize catalog data → summarize the proposed changeset → classify its risk → generate a merchant-facing explanation**, each step a separate call, wired the same way `runScan`'s internal stages are wired today (fixed order, one step's typed output feeding the next step's typed input). This is a plan, not code — no `services/ai/` directory exists yet.

### Move 3 — the principle

Chaining trades one big, hard-to-debug call for several small, easy-to-debug ones — the same "decompose into single-responsibility units" instinct that makes small functions easier to reason about than one giant one, just applied to a boundary (an LLM call) where you can't step through the logic with a debugger. The skeleton part everyone forgets: a chain's steps must be genuinely independent in what they need to know — the moment step 3 secretly needs the *original* raw input that only step 1 saw, the chain has silently become one job wearing three prompts, and the whole benefit (isolated failures, mixed model tiers, independent testing) evaporates.

## Primary diagram

```
Full recap — a generic chain vs this repo's real single-purpose pipeline

  GENERIC PROMPT CHAIN (not in this repo)          THIS REPO'S REAL PIPELINE (today)
  ──────────────────────────────────────            ──────────────────────────────────
  raw input                                          scan triggered (Remix action)
      │                                                    │
      ▼                                                    ▼
  Step 1: summarize (LLM call)                       enqueueScan() — QUEUED row created
      │ output = summary                                   │ claimed by worker
      ▼                                                    ▼
  Step 2: classify risk (LLM call)                   claimAndRunNext() → runScan()
      │ output = risk label                                │
      ▼                                                    ▼
  Step 3: explain (LLM call)                         READING_CATALOG → RUNNING_CHECKS →
      │                                                PREPARING_RESULTS → COMPLETED
      ▼                                                    │ (assertTransition-gated,
  final merchant-facing text                                 code decides every hop)
                                                             ▼
                                                       Finding rows persisted (1 $transaction)

  same shape (fixed sequence, one job per step, output→input handoff) —
  every step on the right is CODE; a real chain needs a MODEL at ≥1 step
```

## Elaborate

Prompt chaining is the LLM-era descendant of Unix pipe philosophy — "do one thing well, and compose" — applied to a component (a model call) that's expensive, slow, and occasionally wrong in ways a pure function never is. It became a named discipline once teams noticed that giant "do everything" prompts were both unreliable (the model would drop instructions buried in the middle of a long ask — this is `02-lost-in-the-middle.md` showing up as a chaining motivation) and undebuggable (a bad output gave no signal about which of five embedded tasks actually failed). The more advanced descendants of chaining — agentic loops that choose their *own* next step rather than following a fixed sequence — are a different pattern (see `study-agent-architecture/` in this repo's guide family for that), and it's worth keeping the two straight: a chain's sequence is fixed by the code that wires it; an agent's sequence is chosen by the model at each turn. This repo's pipeline is unambiguously the fixed-sequence kind, if it ever gets an LLM step at all.

## Project exercises

### Exercise EX-1 — a two-step mock chain: summarize → explain

- **Exercise ID:** EX-1
- **What to build:** Stub a two-step chain: `app/app/services/ai/summarize-changeset.server.ts` (new) → `app/app/services/ai/explain-risk.server.ts` (new). Each exports a typed function (`summarizeChangeset(findings: CatalogFinding[]): ChangesetSummary` and `explainRisk(summary: ChangesetSummary): string`) that calls a **fake/mock "LLM"** — a local function that pattern-matches on input shape and returns canned, deterministic text (no API key, no network call). `summarizeChangeset` consumes `CatalogFinding[]` (the real persisted shape from `runner.server.ts:153-180`); `explainRisk` consumes only `summarizeChangeset`'s output, never the raw findings — enforcing the isolation the pattern requires.
- **Why it earns its place:** This is the exact seam named in this file's Move 2 "In this codebase" note, built out concretely, so the interface between "deterministic findings" and "a future LLM layer" exists in code before Bulk AI needs it for real — swapping the fake call for a real Anthropic API call later should mean touching only the inside of these two functions, not their signatures.
- **Files to touch:** `app/app/services/ai/summarize-changeset.server.ts` (new), `app/app/services/ai/explain-risk.server.ts` (new), a shared type in the same directory or `app/app/services/ai/types.ts` (new), tests at `app/test/summarize-changeset.test.ts` and `app/test/explain-risk.test.ts` (new).
- **Done when:** A test feeds a `CatalogFinding[]` with a mix of severities through both steps in sequence and asserts the final string mentions the highest-severity finding, and a second test asserts `explainRisk` never receives a raw `CatalogFinding` — only a `ChangesetSummary`.
- **Estimated effort:** 2-3 hours.

### Exercise EX-2 — a chain orchestrator mirroring the real scan pipeline's shape

- **Exercise ID:** EX-2
- **What to build:** A `runChain` orchestrator (`app/app/services/ai/run-changeset-chain.server.ts`, new) that wires EX-1's two steps together the way `worker-core.server.ts:claimAndRunNext` wires `runScan`, including its own tiny state enum (`SUMMARIZING → EXPLAINING → DONE | FAILED`) modeled on `state.ts`'s `assertTransition` shape, so a step can't run out of order and a failure in either step routes to a safe `FAILED` state instead of a partial result.
- **Why it earns its place:** Rehearses, at small scale, the exact "fixed order + gated transitions + safe failure path" discipline `runner.server.ts`/`state.ts` already prove out for the deterministic pipeline — so when a real model call eventually replaces the fake one in EX-1, the orchestration discipline around it doesn't have to be invented from scratch under time pressure.
- **Files to touch:** `app/app/services/ai/run-changeset-chain.server.ts` (new), a small state module alongside it (or reusing `app/app/services/scan/state.ts`'s pattern as a template), a test at `app/test/run-changeset-chain.test.ts` (new).
- **Done when:** A test asserts that calling `runChain` with a step forced to throw lands in a `FAILED` state without ever reaching `DONE`, and a happy-path test asserts each step only ever received the previous step's typed output, never the original raw input.
- **Estimated effort:** 2 hours.

## Interview defense

**Q: What is prompt chaining, and why not just write one big prompt?**
A: It's decomposing one hard LLM task into several single-purpose calls, wired so each step's output is the next step's whole input. One big prompt is harder to debug (a bad answer doesn't tell you which embedded sub-task failed) and more prone to lost-in-the-middle (see file `02`) because it's carrying more instructions at once. Diagram: the three-step summarize → classify → explain chain from Move 1 — point at the output→input handoff arrows as the load-bearing part.

**Q: Why doesn't this codebase have any prompt chains today?**
A: Because it has no LLM calls at all — the product is deliberately deterministic. The product spec states this directly: §2.1 defines findings as coming from "explicit validation rules rather than an LLM," and §27 tells the team to "use deterministic checks rather than AI." What this repo *does* have is the structural shape a chain would use — `enqueueScan → claimAndRunNext → runScan`'s internal `assertTransition`-gated stages — just with code deciding every step's output instead of a model. Diagram: point at the Primary Diagram's side-by-side comparison — same shape, different decision-maker at each step.

**Q: If you built the summarize → explain chain from EX-1 for real, what's the part people usually get wrong first?**
A: Letting step 2 secretly depend on the original raw input "just this once," instead of strictly on step 1's output — the moment that happens, the chain isn't actually isolated anymore, and a bug in step 2 might really be a bug in the data step 1 was supposed to have fully summarized. The test worth writing first isn't "does the final output look right" — it's "does step 2 ever receive anything except step 1's typed output," because that's the property that makes the whole pattern worth the extra latency and cost in the first place.

## See also

- `01-context-window.md` — the token budget each chain step's prompt still has to respect on its own.
- `02-lost-in-the-middle.md` — one of the concrete reasons chaining beats one giant prompt: shorter per-step inputs have less "middle" to lose things in.
- `../../study-system-design/01-single-worker-db-queue.md` — the real `enqueueScan`/`claimAndRunNext` hop this file reads as the outer half of the pipeline shape.
- `../../study-system-design/02-atomic-idempotent-scan-pipeline.md` — the real `runScan`/`assertTransition` internals this file reads as the inner half of the pipeline shape.
