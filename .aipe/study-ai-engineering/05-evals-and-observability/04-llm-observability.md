# LLM Observability

Traces / spans / replay — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Worker layer ────────────────────────────────────────────────┐
│  app/services/scan/runner.server.ts — runScan()                 │
│  status: QUEUED → READING_CATALOG → RUNNING_CHECKS →             │
│          PREPARING_RESULTS → COMPLETED (or FAILED)                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌─ Engine seam ────────────▼──────────────────────────────────────┐
│  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)                 │
│  no model call anywhere on this path                                │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌─ CI / eval layer ────────────▼───────────────────────────────────┐
│  npm test · npm run eval (app/test/eval-fixtures.test.ts)          │
│  → observes the PIPELINE's correctness, not an LLM call             │
│                                                                      │
│  ★ THIS CONCEPT (traces/spans/replay of an LLM call) has no         │
│    real estate to occupy here — there is no LLM call to trace ★     │
└───────────────────────────────────────────────────────────────────┘
```

LLM observability is the discipline of being able to answer, after the fact, "what exactly did the model see, what did it decide, and why" — for a system whose behavior isn't fully determined by its source code the way a normal function's is. A trace records one end-to-end request through a pipeline. A span records one step inside that trace (one model call, one tool invocation, one retrieval). Replay means being able to re-run that exact recorded input against the model again — for debugging, for regression-checking after a prompt change, or for building a new eval fixture from something that actually happened in production.

This repo has no LLM calls anywhere in its request path, so there's nothing to trace, span, or replay — `not yet exercised`. What this repo *does* have — a fully deterministic pipeline with its own strong observability story — is worth naming honestly as the non-LLM analog, without overstating what it is.

## Structure pass

**Layers:** traces, spans, and replay describe three different granularities of the same recorded artifact — a trace is the whole request, a span is one step inside it, replay is the ability to re-execute a recorded span or trace later. None of the three require an LLM conceptually (you can trace and span a deterministic pipeline too, and MerchGrid's status-machine logging is a cousin of exactly that) — but "replay" only becomes interesting as a debugging tool once a step in the pipeline is non-deterministic, which is precisely the property an LLM call has and a deterministic check doesn't.

**Axis to trace: is the recorded step deterministic or not?**

```
One axis — "does replaying this step reproduce the original output?" — traced across step types

┌─ deterministic step ──────────┐   replay(input) == original output, always
│  (e.g. runChecks, a SQL query) │   → replay is a nice-to-have for debugging,
│                                 │      not the only way to reconstruct behavior
├─ non-deterministic step ───────┤   replay(input) may != original output
│  (an LLM call, temperature > 0) │   → replay is often the ONLY way to see
│                                 │      exactly what happened, because the
│                                 │      live call can't be perfectly re-derived
│                                 │      from the input alone
└─────────────────────────────────┘
```

**Seam:** the boundary that makes LLM observability its own discipline (rather than just "logging, but for AI") is the seam between "this step's output is a pure function of its input" and "this step's output depends on a model's sampling behavior, which recorded logs can capture but application code can't re-derive." MerchGrid's engine sits entirely on the deterministic side of that seam — `runChecks` given the same variants and settings always returns the same findings, which is exactly why the golden-set eval in `01-eval-set-types.md` can assert exact equality instead of needing a replay log to understand a past run.

## How it works

### Move 1 — the mental model

You've used your browser's network tab to see exactly what request went out, what headers it carried, and what came back — that's a trace of one HTTP call. LLM observability is the same idea, generalized to a pipeline that might make several model calls, tool calls, and retrieval steps in sequence: a trace is the whole waterfall, a span is one bar in that waterfall, and the strategy of "keep the actual request/response pairs around so you can look at them later" is replay.

```
The trace/span/replay pattern — one request, nested spans, recorded for later

┌─ trace: one end-to-end pipeline run ───────────────────────────┐
│                                                                    │
│   ┌─ span: retrieve context ──┐                                    │
│   │ input → docs               │                                    │
│   └─────────────┬───────────────┘                                   │
│                 │                                                    │
│   ┌─ span: LLM call ───────────▼──┐                                  │
│   │ prompt + docs → model → text   │  ← recorded input/output pair    │
│   └─────────────┬───────────────────┘     is what makes REPLAY        │
│                 │                            possible later            │
│   ┌─ span: parse/validate ──────▼──┐                                   │
│   │ text → structured result        │                                  │
│   └──────────────────────────────────┘                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Move 2 — the three pillars, one at a time

**Traces — the record of one full pipeline run, start to finish.**

A trace answers "what happened during this one request." In an LLM system it typically includes every step the request touched — retrieval, prompt assembly, the model call itself, any tool calls, post-processing — stitched together with a shared trace ID so you can reconstruct the whole sequence later, usually visualized as a waterfall (this step took 40ms, that one took 1.2s, they ran in this order). Purpose-built tools for this (Langfuse, LangSmith, and similar) exist specifically because ad-hoc `console.log` calls scattered across a codebase don't give you a single queryable, chronologically ordered view of one request — you'd have to grep and manually reassemble the timeline. `not yet exercised` in this repo — there's no LLM pipeline whose steps would need stitching into a trace.

**Spans — one step inside a trace, with its own input, output, and timing.**

A span is the trace's unit of granularity: one model call, one retrieval query, one tool invocation, each with its own recorded input, output, latency, and (for a model call specifically) token counts and cost. Spans nest — a single "handle this request" trace might contain a "retrieve" span, then an "LLM call" span, then a "validate output" span, each timestamped and attributable on its own. The reason this matters for debugging is specificity: without spans, "the request was slow" tells you nothing; with spans, "the retrieval span took 8ms and the LLM-call span took 2.1s" tells you exactly where to look. `not yet exercised` — no model call exists here to give a span something non-trivial to record.

**Replay — re-running a recorded input against the model again, later, deliberately.**

Replay means keeping the exact recorded input (prompt, context, parameters) from a real trace around so you can re-submit it — to reproduce a bug a user reported, to check whether a prompt change fixes a specific failure without waiting for it to recur naturally in production, or to mine a real production failure into a new golden-set fixture (this is the direct link back to `01-eval-set-types.md`: a well-instrumented LLM pipeline's replay log is often where new golden-set rows come from, harvested from real failures rather than invented from a spec). Because the model's output can vary run to run, replaying the same input twice won't always reproduce the same output byte-for-byte — but it reproduces the same *conditions*, which is what debugging actually needs. `not yet exercised` here, for the same reason as the other two: there's no non-deterministic step in this pipeline that a replay log would add value to.

**The honest non-LLM analog this repo does have.**

None of the above exists here, and it shouldn't be dressed up as if it does. But it's worth being precise about what *does* provide pipeline-level observability in this codebase, because the discipline rhymes even though the tooling doesn't. Two things carry real weight:

1. **The scan state machine as a coarse-grained trace.** `runner.server.ts` (lines 85–224) advances a `Scan` row through explicit states — `READING_CATALOG` → `RUNNING_CHECKS` → `PREPARING_RESULTS` → `COMPLETED`, with `assertTransition` (line 95, 111, 132, 139) guarding each hop and a persisted `FAILED` state (lines 208–224) carrying a safe, non-leaking failure message. That status column, updated in the database as the pipeline advances, is a trace in the loosest sense — a durable, queryable record of exactly how far one specific run got and whether it succeeded — but it's coarse-grained (four states, not per-model-call spans) and has no equivalent of "replay the exact catalog that was read" if you wanted to reproduce a failure precisely; the raw Shopify catalog that produced a given scan isn't retained anywhere (the product spec's §12.1 retention hypothesis discusses this).
2. **`npm test` / `npm run eval` as pipeline-correctness observability, not runtime tracing.** The golden-set eval (`app/test/eval-fixtures.test.ts`) and the wider `npm test` suite give you confidence about the *pipeline's* correctness before it ships, not visibility into what a *live* run did — that's a meaningfully different kind of observability from a trace, which is about a specific past execution, not a pre-deployment guarantee.
3. **The atomic `$transaction` block (lines 187–207) as a durability guarantee, not a trace.** Wrapping the delete-old-findings / insert-new-findings / mark-COMPLETED sequence in one Prisma transaction guarantees a crash mid-pipeline can never leave a scan `COMPLETED` with stale or missing findings — that's a correctness property of the pipeline's failure handling, worth knowing, but it's not tracing or replay in the LLM-observability sense; it doesn't let you inspect what happened after the fact the way a trace would, it only guarantees the persisted state is never inconsistent.

Be precise about the boundary: none of these three give you a trace ID, a span waterfall, or a replay log the way Langfuse or LangSmith would for an LLM pipeline. They're this codebase's actual observability story, and they're solid ones for a deterministic pipeline — but they answer "did this run complete correctly" and "is the pipeline correct before it ships," not "what exactly did step 3 see and produce, and can I re-run just that step."

### Move 3 — the principle

Observability tooling should match what's actually uncertain about the system. A deterministic pipeline's uncertainty is almost entirely about *whether it completed and in what state* — which a status-machine column and a transaction boundary answer well. An LLM pipeline's uncertainty is about *what the model actually saw and produced on this specific run*, which only a trace/span/replay system answers, because the model's behavior isn't re-derivable from the surrounding code the way a deterministic function's is. Reaching for LLM-grade tracing on a pipeline with no LLM in it would be instrumentation without a question to answer; the reverse — shipping an LLM pipeline with only a status column and no trace of what the model actually did — is the mistake this concept exists to prevent.

## Primary diagram

```
LLM observability — the three pillars, and what stands in for them here

┌───────────────────────────────────────────────────────────────┐
│  TRACE — one full pipeline run, start to finish                  │
│    LLM system: every retrieval/model/tool step, one trace ID       │
│    this repo: Scan.status column, READING_CATALOG → COMPLETED       │
│                (coarse-grained, 4 states, no per-call detail)        │
├───────────────────────────────────────────────────────────────┤
│  SPAN — one step inside the trace, own input/output/timing         │
│    LLM system: retrieval span, LLM-call span (tokens, cost),         │
│                validation span                                        │
│    this repo: not present — no per-step instrumentation inside        │
│                runScan() beyond the four coarse status hops             │
├───────────────────────────────────────────────────────────────┤
│  REPLAY — re-submit a recorded input, later, deliberately            │
│    LLM system: re-run a recorded prompt to reproduce a bug or          │
│                mine a new golden-set fixture from a real failure        │
│    this repo: not present — the raw catalog read for any given scan      │
│                is not retained; there's nothing to replay                 │
└───────────────────────────────────────────────────────────────────┘

  status: not yet exercised — no LLM call exists in this codebase to
  trace, span, or replay
```

## Elaborate

Trace/span/replay tooling grew out of classic distributed-tracing systems (think OpenTelemetry, Jaeger) adapted specifically for LLM pipelines, where the thing worth tracing isn't just latency across services but the actual content of a prompt and a model's response — because unlike a normal RPC, you can't reconstruct what an LLM call would have returned just by knowing the code that made it. That's why LLM-specific tools (Langfuse, LangSmith, and similar) emerged as a distinct category rather than teams just reusing generic APM: the payload worth capturing (full prompts, full completions, token/cost accounting) and the debugging workflow (replay a specific past prompt against a new model version to check for regressions) don't map cleanly onto generic request tracing.

If this product line ever adds an LLM call — MerchGrid: Bulk AI generating a suggested catalog fix, for instance — the natural sequence would be: add spans around the model call first (input/output/tokens/cost, at minimum), stitch them into a trace per bulk-edit session, and only then reach for replay once there's a real incident or prompt-migration need to replay against. That sequencing mirrors the order these three pillars are usually built in production: span first (you can't trace without something to span), trace second (stitches spans together), replay last (needs a retained corpus of real traces to be worth building).

## Project exercises

There is no LLM call in this codebase to trace, span, or replay, so there's no exercise that would build real tracing infrastructure without inventing a fictional model call first. The closest legitimate hands-on move is auditing the analog this repo does have.

### Audit the scan pipeline's actual observability surface

- **Exercise ID:** EX-1
- **What to build:** Read `app/services/scan/runner.server.ts` end to end and write down, for each of the five states (`READING_CATALOG`, `RUNNING_CHECKS`, `PREPARING_RESULTS`, `COMPLETED`, `FAILED`), exactly what gets persisted to the database at that point (which columns, on which model) versus what's only ever visible in the process's stdout via `console.error` (line 213) and therefore lost once the process exits. Produce a short table: state → persisted fields → ephemeral-only fields.
- **Why it earns its place:** This is the concrete version of the honest claim this file makes — that MerchGrid's pipeline has real observability (a durable status column) but not trace/span-grade observability (no per-step timing, no retained inputs). Doing the audit yourself, rather than taking the file's word for it, is what turns "not yet exercised" from a label into something you've verified by reading the actual code.
- **Files to touch:** none to modify — this is a read-only audit of `app/services/scan/runner.server.ts` and the `Scan`/`Finding` Prisma models (`app/prisma/schema.prisma`).
- **Done when:** You can name, for a scan that failed at `RUNNING_CHECKS`, exactly what a support engineer could reconstruct from the database alone (the `failureCode`, `failureMessageSafe`, the timestamp) versus what only existed in a log line that's already gone (the actual error object passed to `console.error`) — and you can say precisely which piece of information would need a real trace/log-retention system to recover if it mattered.
- **Estimated effort:** 30-45 minutes.

## Interview defense

**Q: This repo has `npm test` and `npm run eval` passing in CI — doesn't that count as observability?**

A: It's a different kind of confidence, and conflating the two is the mistake to avoid. `npm test` and `npm run eval` tell you the pipeline is *correct before it ships* — they're pre-deployment guarantees, run against fixtures, not runtime visibility into what a specific live scan actually did. A trace tells you what happened during one particular past execution — which prompt a model saw, which document a retrieval step returned, at 2:47pm on a Tuesday when a specific merchant ran a specific scan. Passing tests don't give you that; they give you confidence the code is right, which is necessary but answers a completely different question than "what happened on this one run."

```
Two different questions, two different tools

┌─ npm test / npm run eval ────────┐   ┌─ trace / span / replay ─────────┐
│ "is the pipeline correct,          │   │ "what did THIS specific past      │
│  in general, before it ships?"      │   │  execution actually do?"           │
│ answered once, pre-deployment        │   │ answered per-request, post-hoc      │
└─────────────────────────────────────┘   └───────────────────────────────────┘
```

**One-line anchor:** tests prove the pipeline is right in general; traces show you what one specific run actually did.

**Q: Given this app is fully deterministic, is there any real argument for adding LLM-style tracing to it?**

A: No — and that's a defensible answer, not a hedge. Trace/span/replay earn their cost specifically because a model's output can't be re-derived from its inputs the way a deterministic function's can; the whole point of replay is recovering something you otherwise couldn't reconstruct. `runChecks` given the same variants and settings always returns the same findings — you can reconstruct any past scan's findings by re-running the code against the same inputs, which is exactly what the golden-set eval already proves works. Adding trace/span/replay infrastructure to a pipeline with that property would be paying the cost of the tooling without the problem it exists to solve. The honest answer is: this pipeline's actual gap is coarser (no retained raw catalog per scan, four status states instead of per-step spans) — worth naming, but it's a logging/retention gap, not a case for LLM-grade observability tooling.

**One-line anchor:** LLM observability earns its cost when the step it's watching is non-reproducible from its own inputs — this pipeline's steps aren't.

## See also

- `01-eval-set-types.md` — where a real trace/replay corpus would eventually feed new golden-set fixtures, if this repo ever had one.
- `02-eval-methods.md` — the methods ladder a traced LLM pipeline's outputs would need to be graded against.
- `03-llm-as-judge-bias.md` — the judge-reliability problem that sits downstream of a traced pipeline's outputs, once there's something for a judge to read.
