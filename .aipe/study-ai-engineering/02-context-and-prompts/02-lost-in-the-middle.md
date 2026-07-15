# 02 — Lost-in-the-middle problem

**Lost-in-the-middle (U-shaped attention bias) — Industry standard, empirically documented.** LLMs recall content near the start and end of a long context reliably, and recall content buried in the middle unreliably — the same total input, reordered, produces measurably different answers. `not yet exercised` in this codebase — there is no LLM call anywhere in the pipeline, so nothing here ever has "the middle" of a prompt to lose. This file teaches the mechanism in full and then contrasts it precisely with how this codebase's real check engine reads its input: with zero positional bias, on purpose, because it isn't a model.

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ UI layer — Remix routes ────────────────────────────────────────┐
│  app.scans.$id.tsx renders every Finding row, unordered by        │
│  "how likely is a human to notice it" — pagination/sort only      │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ Remix loader, HTTP
┌─ Service layer — scan pipeline ─────────────────────────────────▼─┐
│  runner.server.ts: runChecks(ALL_CHECKS, ctx)                     │
│                                                                     │
│  ★ LOST-IN-THE-MIDDLE WOULD MATTER HERE ★ ← not present            │
│    (only matters if the NEXT consumer of these findings is an     │
│     LLM reading them in one prompt — see "How it works")          │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ ctx.variants — a plain array
┌─ Engine layer — @merchgrid/catalog-checks ──────────────────────▼─┐
│  each check iterates ctx.variants top to bottom, full array,      │
│  identical cost per item regardless of array position             │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ Prisma Client
┌─ Storage layer ─────────▼────────────────────────────────────────────┐
│  SQLite: Finding rows, ordered in SQL by severityRank at query time │
└────────────────────────────────────────────────────────────────────────┘
```

Zoom out: every check in this repo walks `ctx.variants` — a plain JS array — start to finish, and every variant costs the same to check regardless of whether it's array index 3 or index 3,000. Zoom in: that flat, position-blind read is exactly what a well-behaved LLM prompt does *not* get for free. Feed a model the same set of facts in a long block and its recall of the fact sitting in the middle drops, even though nothing about "the middle" is semantically different from the edges. That's the concept this file is about — where it comes from, why it happens, and why it simply doesn't apply to code that iterates a `for` loop.

## Structure pass

**Axis: guarantees — does this layer promise to consider *everything* equally, or is it only best-effort on some of it?** Trace it:

- `catalog-reader.server.ts` guarantees a complete read up to `variantLimit` (or marks `partial: true` honestly when it can't — see `01-context-window.md`).
- `normalizeCatalog` guarantees a deterministic 1:1 mapping — nothing dropped, nothing reordered based on "importance."
- Each check function in `@merchgrid/catalog-checks` (e.g. `mg-001.ts` through `mg-010.ts`) guarantees full-coverage iteration — `ctx.variants.filter(...)` or `.forEach(...)` touches every element, and JavaScript's array iteration has no concept of "attending less" to the middle of an array. Every element gets the exact same `if` checks run against it.

**Seam:** the boundary this concept actually lives on is hypothetical in this repo — it's the boundary between "a loop that touches every item at equal cost" (true everywhere in this codebase) and "a model whose attention is uneven across a single input regardless of loop position" (true only if something ever feeds a stuffed list of findings to an LLM in one call). Nothing in this repo crosses that boundary today, which is exactly why lost-in-the-middle has never been a bug here — the seam where it would start to matter doesn't exist yet.

```
The seam — full-coverage iteration vs positional attention

axis traced = "does this consumer treat every item the same regardless of position?"

┌─ this codebase, everywhere ──┐  seam (hypothetical) ┌─ an LLM reading────┐
│  for/filter/forEach:           │ ═══════╪═══════════► │ one long prompt:    │
│  item #1 and item #4,999        │ (would flip here)    │ item #1: strong     │
│  cost/matter identically         │                       │ item #2,500: weak   │
└───────────────────────────────────┘                       │ item #4,999: strong │
                                                              └─────────────────────┘
        this repo has never crossed this seam — no LLM consumer exists
```

## How it works

### Move 1 — the mental model

You've filtered an array with `.filter()` or `.find()` — every element gets the same predicate applied, in the same way, no matter where it sits in the array. Now imagine a "predicate" that gets *worse* the further an element sits from either end — that's the shape of the problem. The strategy in one sentence: **a long input isn't attended to uniformly by a transformer, so position in the prompt is itself a variable that affects the answer, on top of what the content actually says.**

```
Pattern — U-shaped attention over a long context

  attention
  strength
    │
high├──┐                                          ┌──
    │  │                                          │
    │  │        ◄── the middle is where ──►       │
    │  │            recall reliably drops          │
    │  │                                            │
 low├──┴──────────────────────────────────────────┴──
    └──────────────────────────────────────────────────► position in prompt
       start                                          end

  [doc 1 — irrelevant]     ← model attends here (strong)
  [doc 2 — irrelevant]
  [doc 3 — RELEVANT!]      ← model often misses this
  [doc 4 — irrelevant]
  [doc 5 — irrelevant]
  [doc 6 — irrelevant]
  [doc 7 — irrelevant]     ← model attends here (strong)
                              question asked at the end
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the same content, reordered, changes the answer.** This is the empirical finding that makes the concept non-obvious: it's not that the model "runs out of room" (that's the context-window problem from file `01`) — it's that with everything fitting comfortably inside the budget, *where* a fact sits still changes whether the model surfaces it correctly. Two prompts with identical token counts and identical content, differing only in the order of the middle section, can produce measurably different recall.

**Step 2 — the shape is U, not flat.** Recall is high near the start (the model has recently "seen" the system prompt and early instructions) and high near the end (recency — it's closest to where generation begins). The trough is in the middle, and it gets worse as the total context gets longer, because there's more "middle" for a fact to get lost in.

**Step 3 — the practical consequence: stuffing beats curating, until it doesn't.** Naively, more context should only help — more facts available can't hurt, right? Lost-in-the-middle is the reason that's false in practice: dumping twenty loosely-relevant documents into one prompt and asking a question performs *worse* than surfacing the three most relevant documents in a shorter context. More isn't better if the position dilutes what matters.

```
Layers-and-hops — where the mitigation actually lives (generic RAG pipeline)

┌─ Retrieval ──────┐ hop: candidate docs   ┌─ Reranking ────────┐
│  vector search    │ ────────────────────► │  score by relevance │
│  returns top-N     │                       │  to THIS query       │
└──────────────────┘                       └──────────┬──────────┘
                                                        │ hop: reordered docs
                                             ┌─ Prompt assembly ──▼──────┐
                                             │ put highest-relevance doc │
                                             │ FIRST or LAST, never       │
                                             │ buried in the middle       │
                                             └───────────────────────────┘
```

**Step 4 — the mitigation is retrieval + reranking + deliberate placement, not "add more context."** Three moves compose: retrieve fewer, more relevant documents instead of dumping everything you have; rerank what you do retrieve so the most relevant item is explicitly placed at an edge of the prompt; and resist the instinct to solve a recall problem by making the context window bigger, because a bigger window just gives lost-in-the-middle more middle to work with.

**In this codebase:** not yet implemented, and — more precisely than "no LLM exists" — this codebase's actual read pattern is the structural *opposite* of what makes lost-in-the-middle a risk. Point at `@merchgrid/catalog-checks`: every check function (`app/packages/catalog-checks/src/checks/mg-00N.ts`) receives `ctx.variants` and iterates it in full — there's no partial attention, no "the tenth item is less likely to be checked than the first." `severityToRank` (`app/app/services/scan/severity.ts:23-25`) then sorts *findings*, not raw catalog data, purely for display and SQL `ORDER BY` convenience (`severity.ts:9-11`) — a UI sort, not a compensation for a model losing track of anything. There's genuinely nothing to mitigate here because there's no model reading a stuffed prompt.

**Future attachment point (speculative — not built):** if MerchGrid: Bulk AI ever generates a merchant-facing explanation from a shop's findings (see file `01`'s future-attachment note), the moment it feeds more than a handful of `CatalogFinding[]` rows into one prompt, this becomes real. The natural fix, grounded in code that already exists: reuse `severityToRank`'s ordering — put `CRITICAL` findings first *and* repeat the highest-severity summary again near the end of the prompt, rather than trusting the model to weigh a `CRITICAL` finding sitting at position 40 of 60 as heavily as one sitting at position 1. This is a plan, not code — no `services/ai/` directory exists in this repo today.

### Move 3 — the principle

Position is not neutral information — for a model, *where* a fact sits in the input is itself a signal that competes with what the fact says. Any system that assembles a long prompt from multiple sources is making an implicit claim about position, whether it means to or not; the discipline is to make that claim on purpose (rerank, place, repeat) instead of by accident (concatenate whatever order the data arrived in).

## Primary diagram

```
Full recap — lost-in-the-middle: the generic risk vs this codebase's actual read

  GENERIC RISK (would apply to a future LLM consumer)   THIS CODEBASE (real, today)
  ─────────────────────────────────────────────────      ──────────────────────────
  20 documents concatenated into one prompt               ctx.variants: plain array
       │                                                        │
       ▼                                                        ▼
  attention strength:  HIGH ... low ... HIGH                for (const variant of
       start            middle           end                  ctx.variants) { ... }
       │                   │               │                       │
       ▼                   ▼               ▼                       ▼
  doc #1 recalled    doc #10 MISSED    doc #20 recalled     EVERY variant checked,
                     (relevant, buried)                       same predicate, same cost,
                                                               position irrelevant
```

## Elaborate

The name comes from empirical studies (most cited: Liu et al., "Lost in the Middle: How Language Models Use Long Contexts," 2023) that ran the same question-answering task with the correct answer placed at different positions in a long context and measured accuracy against position — the result was a clean U-curve across essentially every model tested at the time. It matters commercially because the industry's initial instinct to fix "the model didn't use my data" was "give it more context," and this result is the evidence that instinct is wrong past a certain point — the fix is architectural (retrieve less, rank better, place deliberately), not just a bigger window. It's the direct reason RAG systems invest heavily in reranking rather than trusting raw vector-similarity order, and why "put the most important instruction last, right before the question" became a standard prompt-engineering habit rather than a superstition.

This codebase's `severityToRank` sort is a good example of a pattern that *looks* similar to a lost-in-the-middle mitigation but isn't one — sorting `Finding` rows by severity for a merchant to scroll through in the Shopify admin is a UI/UX ordering decision, not a compensation for degraded model recall, because there's no model reading them. It's worth being able to say precisely why the two aren't the same move, rather than conflating "we sort things by importance" with "we've handled lost-in-the-middle" — the second only means something once a model, not a human scrolling a table, is the reader.

## Project exercises

### Exercise EX-1 — a position-aware ordering function for findings

- **Exercise ID:** EX-1
- **What to build:** A new module `app/app/services/ai/order-findings-for-explanation.server.ts` exporting `orderForPrompt(findings: CatalogFinding[]): CatalogFinding[]` that places the highest-`severityRank` findings first *and* repeats a short summary of them at the end of the returned list (bookending, not just front-loading) — the concrete ordering discipline a real prompt-assembly step would need before this ever touches a model.
- **Why it earns its place:** Rehearses the exact mitigation this file teaches — deliberate placement at the edges — against real `CatalogFinding` data, and makes "position matters" a testable property instead of an abstract claim.
- **Files to touch:** `app/app/services/ai/order-findings-for-explanation.server.ts` (new), reusing `severityToRank` from `app/app/services/scan/severity.ts`; a test at `app/test/order-findings-for-explanation.test.ts` (new).
- **Done when:** A test asserts that for an input with one `CRITICAL` finding buried in the middle of ten `WARNING` findings, the function's output has that `CRITICAL` finding at index 0 (and its summary reappears at the end).
- **Estimated effort:** 1-2 hours.

### Exercise EX-2 — a naive-vs-ordered mock-prompt diff harness

- **Exercise ID:** EX-2
- **What to build:** A small script that pulls a real scan's `Finding` rows from the dev SQLite DB (via Prisma), builds two mock prompt strings — one by naive `Finding` insertion order, one using EX-1's `orderForPrompt` — and prints both side by side so the structural difference (where the `CRITICAL` items land) is visible without ever calling a model.
- **Why it earns its place:** Makes the abstract "ordering changes what a model would see first" argument concrete against this app's own data, and is a natural rehearsal step before any real LLM call is wired up for Bulk AI.
- **Files to touch:** A new script under `app/scripts/` (new), reading `Finding` rows via `app/app/db.server.ts`'s Prisma client, calling both the naive order and `order-findings-for-explanation.server.ts` from EX-1.
- **Done when:** Running the script against a scan with mixed severities prints two visibly different orderings and a one-line diff summary (e.g., "3 CRITICAL findings moved from positions 12, 27, 41 to positions 0, 1, 2").
- **Estimated effort:** 1 hour.

## Interview defense

**Q: What is the lost-in-the-middle problem, and is it a context-window-size problem?**
A: No — that's the common confusion. Context-window overflow is about not fitting; lost-in-the-middle happens even when everything fits comfortably, purely because of where a fact sits in the input. Diagram: the U-shaped attention curve from Move 1 — point out that the trough is in the *middle* of a context that's well within budget, not at the edge of an overflow.

**Q: Why has this never been a bug in MerchGrid: Catalog Audit?**
A: Because the thing reading the catalog data is a `for` loop over an array in deterministic TypeScript, not a model with position-dependent attention. Every check in `@merchgrid/catalog-checks` applies the same predicate to `ctx.variants[0]` and `ctx.variants[4999]` at identical cost — there's no mechanism by which the 3,000th variant could be "attended to" less than the first. The product spec's deliberate no-LLM design (§2.1, §27) is the reason this class of bug structurally cannot exist here today.

**Q: If Bulk AI is built and starts summarizing findings for a merchant, what's the concrete failure mode you'd be watching for?**
A: A shop with, say, sixty findings gets summarized in one prompt, and the one `CRITICAL` pricing error sitting at finding #35 gets omitted from the model's summary while two cosmetic `WARNING` findings at the start and end get mentioned — the merchant walks away thinking the catalog is fine. The fix, and the load-bearing part people skip: don't just sort by severity for display (this repo already does that, harmlessly, via `severityToRank`) — actively place the highest-severity items at *both* edges of whatever gets fed to the model, because sorting alone doesn't defeat a U-shaped attention curve if the sorted list is still long enough to have a middle.

## See also

- `01-context-window.md` — the budget problem this file's U-curve compounds once the budget is nearly full.
- `03-prompt-chaining.md` — breaking one long summarization prompt into smaller single-purpose steps is itself a mitigation, since each step's input is shorter and has less "middle" to lose things in.
- `../../study-system-design/03-engine-app-boundary.md` — the pure, position-blind check functions this file contrasts the concept against.
