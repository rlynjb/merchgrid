# 01 — Context window

**Context window — Industry standard.** The fixed slice of text an LLM inference call can actually see: system prompt, conversation history, retrieved documents, and reserved room for the response, all competing for the same finite token budget. `not yet exercised` in this codebase — MerchGrid: Catalog Audit never calls a model, so nothing here ever fills, trims, or overflows one. This file still teaches the mechanism in full, and points at the one place in this codebase that already manages a *different* kind of fixed budget — worth understanding as a contrast, not a substitute.

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ UI layer — Remix routes ───────────────────────────────────────┐
│  app.scans.$id.tsx  (loader reads Scan + Finding rows)           │
└─────────────────────────┬─────────────────────────────────────────┘
                          │ Remix loader, HTTP
┌─ Service layer — scan pipeline (app/app/services/scan/) ────────▼─┐
│  queue.server.ts → worker-core.server.ts → runner.server.ts       │
│  runner.server.ts assembles CatalogCheckContext, then calls       │
│  runChecks(ALL_CHECKS, ctx)                                        │
│                                                                     │
│  ★ A CONTEXT WINDOW WOULD ASSEMBLE HERE ★ ← not present            │
│    (no LLM call exists in this pipeline — see "How it works")     │
└─────────────────────────┬─────────────────────────────────────────┘
                          │ ctx: { variants, settings, now }
┌─ Engine layer — deterministic packages ─────────────────────────▼─┐
│  @merchgrid/catalog-checks: 10 pure functions read ctx in full,   │
│  no truncation, no token cost, no attention decay                 │
└─────────────────────────┬─────────────────────────────────────────┘
                          │ Prisma Client
┌─ Storage layer ─────────▼───────────────────────────────────────────┐
│  SQLite: Scan, Finding, ShopSettings rows                          │
└──────────────────────────────────────────────────────────────────────┘
```

Here's the whole thing: a scan reads a shop's catalog, normalizes it, hands one in-memory object to ten deterministic check functions, and writes findings back to SQLite. Nowhere in that path is there a model call — so nowhere in that path is there a context window. The box marked above is where one *would* assemble if this pipeline ever fed a prompt instead of a pure function. Zooming in: a context window is the answer to one question — "how much can the model see on this one call, and who decides what makes the cut?" That's the mechanism this file builds, and then it tells you exactly why this app has never had to answer it.

## Structure pass

**Axis: state — who owns the assembled payload, and what bounds its size?** Trace it across the pipeline:

- `catalog-reader.server.ts`'s `readCatalog` owns nothing durable — it streams paginated GraphQL pages and stops once a caller-supplied `variantLimit` is hit (`catalog-reader.server.ts:23-26`, the `ReadCatalogOptions.variantLimit` field).
- `normalizeCatalog` (in `@merchgrid/catalog-core`) turns that raw, possibly-truncated read into a `snapshot` with a bounded `variants` array.
- `runner.server.ts:125-129` assembles the one payload that matters here — `CatalogCheckContext` — by copying `snapshot.variants`, the shop's `minimumMarginPercent` setting, and a timestamp into a plain object.
- `runChecks(ALL_CHECKS, ctx)` (`runner.server.ts:130`) receives that object whole. No check function ever sees a partial `ctx` — it's all in, every time.

**Seam:** the hop from "unbounded-ish paginated Shopify read" to "one bounded, in-memory struct handed to a function call" is a real seam — it's exactly the seam a context-window assembly step would sit on if a model were the next consumer instead of `runChecks`. What's missing on this side of the seam is everything that makes a context window a *management problem*: no token count, no priority-based truncation, no eviction, no position sensitivity in what order `variants` sits in the array. The seam exists; the budget logic that would make it interesting for an LLM doesn't, because the consumer is deterministic code that costs the same to run whether item #1 or item #4,999 gets checked.

```
The seam — bounded read hands off to a whole-payload call

axis traced = "who owns the size limit on this payload?"

┌─ catalog-reader.server.ts ─┐  seam: CatalogCheckContext  ┌─ runChecks ─┐
│  variantLimit: soft cap      │ ══════════╪══════════════► │ reads ALL   │
│  (business guardrail,        │  (assembly happens here)    │ of ctx,     │
│   default 5000 variants)     │                              │ every item, │
└───────────────────────────────┘                              │ equal cost  │
                                                                 └─────────────┘
        this is the shape a context window would also need —
        it's just not measuring tokens, and nothing downstream
        cares about ORDER the way an LLM's attention would
```

## How it works

### Move 1 — the mental model

You already build one of these every time you assemble a payload for a single function call — `CatalogCheckContext` is a payload with exactly three fields, built once, handed to `runChecks` in one shot. A context window is the same idea, scaled up and given a much stricter, *quantified* budget: everything a model gets to see for one inference call, measured in tokens, with a hard numeric ceiling that the provider enforces and bills you for. The strategy in one sentence: **treat "what the model sees this turn" as a fixed-size container you have to actively pack, not an ever-growing scratchpad.**

```
Pattern — the context window as a fixed container

┌──────────────────────────────────────────────────────┐
│              Context window (finite, e.g. 200K tokens)│
│                                                        │
│  System prompt      [██████░░░░░░░░░░░░░░░░░░░░░░]   │
│  Conversation history [████████████░░░░░░░░░░░░░░]   │
│  Retrieved context   [████░░░░░░░░░░░░░░░░░░░░░░░░]   │
│  Reserved response    [░░░░░░░░░░░░░░░░████████████]   │
│                                                        │
│  Total: FIXED. Every section competes for the same    │
│  space. Overflow doesn't error gracefully by default — │
│  it gets silently truncated or the call gets rejected. │
└──────────────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Step 1 — the budget is finite and shared.** Every provider caps a model's context window at some token count (128K, 200K, 1M — the number moves, the ceiling doesn't disappear). System prompt, conversation history, retrieved documents, and the space reserved for the model's own output all draw from that same pool. Grow one section and you shrink what's left for the others — there's no "add more RAM" move at inference time.

**Step 2 — assembly happens once, right before the call.** Somewhere in the code, right before the API request goes out, something has to decide: which history turns make the cut, which retrieved chunks get included, in what order. That assembly step is a real function with real logic — it's not the model's problem, it's yours.

```
Assembly — what happens right before the call

  system prompt (fixed)
        │
  + conversation history (grows every turn)
        │
  + retrieved documents (0 to N chunks)
        │
        ▼
  ┌─────────────────────┐    over budget?     ┌───────────────┐
  │ does it fit in       │ ──────yes────────► │ truncate /     │
  │ (limit − reserved     │                     │ evict / drop   │
  │  response tokens)?    │                     │ lowest-priority│
  └──────────┬────────────┘                     └───────────────┘
             │ no (fits)
             ▼
        send the request
```

**Step 3 — eviction/truncation strategy decides what's cut, and this is where most bugs live.** The naive strategy is "drop the oldest conversation turns" (a sliding window) — simple, but it silently forgets facts a user stated early on. Better strategies: summarize dropped history instead of deleting it, rank retrieved chunks by relevance and keep only the top-K, or reserve a fixed slice for "must-keep" system instructions that never get evicted regardless of pressure. **What breaks if you skip this entirely:** the provider either errors the whole call (context length exceeded) or, worse, silently truncates from one end and the model answers confidently against half the intended input.

**Step 4 — position inside the window isn't neutral.** Two payloads with identical content but different *ordering* get different quality answers from the same model — burying the one relevant fact in the middle of ten irrelevant ones measurably hurts recall compared to putting it first or last. That's not a footnote here; it's the entire subject of the next file (`02-lost-in-the-middle.md`). A context-window manager that only tracks token count and ignores position is solving half the problem.

**In this codebase:** not yet implemented — there is no LLM call anywhere in `app/app/`, `app/packages/catalog-checks/`, or `app/packages/catalog-core/`, so there is no prompt and no token budget to manage. The nearest real analog is `settings.catalogVariantLimit` (`app/prisma/schema.prisma:54`, defaulting to `5000`), enforced in `readCatalog`'s pagination loop (`catalog-reader.server.ts:410-451`) and its per-product sub-pagination (`catalog-reader.server.ts:309-344`). It's worth naming precisely why that cap is *not* a context window, even though the shape rhymes:

| | `catalogVariantLimit` (real, in this repo) | A context window (not in this repo) |
|---|---|---|
| Unit | variant count | tokens |
| Why it exists | bound a Shopify API crawl's calls/memory (`catalog-reader.server.ts:378-389`) | bound what a model can attend to per call |
| On overflow | mark `partial: true`, keep what fit, stop cleanly | truncate/evict/reject — quality degrades, not just coverage |
| Ordering sensitivity | none — every kept variant costs `runChecks` the same | high — position affects recall (see file `02`) |
| Who consumes it | deterministic TypeScript, equal-cost per item | a model whose attention is uneven across the payload |

**Future attachment point (speculative — not built):** if MerchGrid: Bulk AI is ever built, its planned preflight/explanation layer would take a shop's `CatalogFinding[]` (already the exact shape `runner.server.ts:153-180` persists) and a proposed changeset, and hand both to an LLM to generate a merchant-facing risk explanation. The moment that happens, someone has to answer: a shop with thousands of findings can't all fit in one prompt, so what gets summarized, what gets dropped, and in what order does it get packed? That's a context-window-assembly function that doesn't exist yet, sitting logically right after `runner.server.ts`'s existing `runChecks` call and before any new `services/ai/` layer. This is a plan, not code — nothing under `app/app/services/ai/` exists today.

### Move 3 — the principle

A context window is not memory — it's a per-call budget, and the engineering work is entirely outside the model, in what you choose to put in front of it before you ever press send. Every mitigation in this space (RAG instead of long-context stuffing, summarization of old history, priority-ranked retrieval, prompt caching for a stable prefix) is really the same move: shrink or reorder what competes for the fixed space, because the space itself never grows on demand.

## Primary diagram

```
Full recap — context window assembly, generic pattern vs this codebase today

  GENERIC PATTERN (not in this repo)              THIS CODEBASE (real, today)
  ───────────────────────────────────              ──────────────────────────
  system prompt ─┐                                  catalog-reader.server.ts
  history ────────┼─► assemble ─► token          ◄──(rhymes with, is NOT)
  retrieved docs ─┤     payload     budget check     variantLimit soft cap
  response room ──┘         │           │            (5000 variants, default)
                            │      over budget?             │
                            ▼           │                   ▼
                     ┌─────────────┐    ▼            CatalogCheckContext
                     │ send to LLM │  truncate/       { variants, settings, now }
                     │ (not built) │  evict/drop            │
                     └─────────────┘                        ▼
                                                       runChecks(ALL_CHECKS, ctx)
                                                       reads ALL of ctx, always
```

## Elaborate

Context windows exist because attention in a transformer costs compute (and historically, quadratically) in the length of the input — a bigger window isn't free, it's slower and pricier per call, which is why providers cap it rather than letting it grow unbounded. The industry's response has split two ways: push the ceiling up (128K → 200K → 1M-token windows), and build retrieval systems (RAG) that keep the window small but *well-chosen*. Neither fully wins — a huge window still degrades in the middle (next file), and RAG adds its own failure mode (retrieving the wrong chunk). Prompt caching (reusing a stable prefix's computed state across calls instead of re-paying for it every time) is the production answer to the cost half of this problem, not the quality half.

None of that machinery shows up in this codebase, and that's a deliberate design choice, not a gap — the product spec states it directly (`merchgrid-catalog-audit-product-spec.md:74`: *"Deterministic: Findings come from explicit validation rules rather than an LLM"*) and explicitly reserves LLM work for the future **MerchGrid: Bulk AI** product (spec line 23, line 1639). The `catalogVariantLimit` cap this file leaned on as the closest analog solves a completely different problem — bounding a paginated GraphQL crawl's call count and memory footprint — and it's worth being precise about that difference rather than pretending the two caps are the same mechanism wearing different clothes.

## Project exercises

### Exercise EX-1 — a token-budget simulator over real findings

- **Exercise ID:** EX-1
- **What to build:** A new module `app/app/services/ai/context-budget.server.ts` (new file) exporting a function like `fitToBudget(findings: CatalogFinding[], tokenBudget: number, estimateTokens: (f: CatalogFinding) => number): { kept: CatalogFinding[]; dropped: number }`. It sorts by `severityRank` (reuse `severity.ts`'s `severityToRank`) so `CRITICAL` findings are kept first, then greedily fills the budget and reports how many were dropped. No LLM call, no API key — just the allocation logic a real context-window packer would need.
- **Why it earns its place:** This is the exact decision — "what gets cut when it doesn't fit" — that a real context-window manager has to make, rehearsed against real `Finding` shapes from this repo instead of an invented example.
- **Files to touch:** `app/app/services/ai/context-budget.server.ts` (new), a test at `app/test/context-budget.test.ts` (new), reads `severityToRank` from `app/app/services/scan/severity.ts`.
- **Done when:** A test asserts that given a mixed-severity `CatalogFinding[]` and a small budget, `CRITICAL` findings survive before `WARNING`/`UNAVAILABLE` ones, and `dropped` is non-zero exactly when the input doesn't fit.
- **Estimated effort:** 1-2 hours.

### Exercise EX-2 — measure what a real context window could actually hold

- **Exercise ID:** EX-2
- **What to build:** A small script or test that queries the dev SQLite DB (via Prisma, `app/prisma/schema.prisma`'s `Finding` model) for a scan's findings, serializes each one the way a prompt would (title + explanation + evidenceJson), and sums a rough token estimate (chars / 4 is close enough) to answer: "how many of this shop's findings would fit in a 200K-token window if we just dumped them all in?"
- **Why it earns its place:** Makes the abstract "you can't just stuff everything in" claim concrete against this app's own data shape — `evidenceJson` (`runner.server.ts:168`) is a JSON blob per finding, and some shops' scans produce hundreds of findings, which is exactly the scale where naive context stuffing breaks down.
- **Files to touch:** A new script under `app/scripts/` (new) or a test under `app/test/`, reading from `app/prisma/dev.db` via the existing Prisma client (`app/app/db.server.ts`).
- **Done when:** The script prints a real number (e.g., "42 findings ≈ 18,400 estimated tokens for shop X") pulled from actual rows, not a hypothetical.
- **Estimated effort:** 1 hour.

## Interview defense

**Q: What is a context window, in one sentence, and why can't it just grow?**
A: It's the fixed token budget an LLM inference call gets — system prompt, history, retrieved context, and response room all drawing from the same pool — and it can't grow freely because attention cost scales with input length, so providers cap it and charge for it. Diagram: the fixed-container box from Move 1 — point at how every section competes for the same total.

**Q: Why doesn't MerchGrid: Catalog Audit have to manage a context window at all?**
A: Because it never calls a model. The product spec is explicit about this being a deliberate choice, not an oversight — §2.1 states findings come from "explicit validation rules rather than an LLM," and §17.6 bans "Powered by AI" messaging for this MVP specifically so the product doesn't imply capability it doesn't have. `runner.server.ts` hands `CatalogCheckContext` to ten pure functions that read it in full every time — there's no attention mechanism to feed, so there's no budget to manage. Diagram: point at the Structure Pass seam diagram — the payload assembly step exists, the token-budget logic downstream of it does not, because the consumer is deterministic code.

**Q: If MerchGrid: Bulk AI is built, where does context-window management first become a real problem?**
A: The moment a preflight/explanation layer takes a shop's `CatalogFinding[]` — already the exact persisted shape in `Finding` rows — and has to summarize it for a merchant-facing LLM call. A shop with a few thousand findings cannot go into one prompt; someone has to write the equivalent of the EX-1 `fitToBudget` function above, prioritizing by severity, before that feature can ship. The load-bearing part people forget: it's not "call the LLM," it's the packing function that runs *before* the call — that's genuinely new code this repo doesn't have yet, not an extension of anything existing.

## See also

- `02-lost-in-the-middle.md` — why *where* something sits inside the window matters as much as whether it fits.
- `03-prompt-chaining.md` — the multi-step pattern a future Bulk AI summarize/explain flow would need, and this repo's existing structural cousin (the scan pipeline).
- `../study-prompt-engineering/04-token-budgeting.md` — this repo's dedicated prompt-engineering guide covers the same "not yet exercised" ground from a working-AI-engineer angle.
- `../../study-system-design/02-atomic-idempotent-scan-pipeline.md` — the real pipeline `CatalogCheckContext` is assembled inside.
