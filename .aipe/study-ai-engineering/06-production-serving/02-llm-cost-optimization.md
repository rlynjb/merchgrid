# LLM cost optimization

Subtitle: **Token budgeting / model tiering / cost governance** — Industry standard (not yet exercised in this repo).

## Zoom out, then zoom in

```
  Zoom out — where this concept would live in MerchGrid

  ┌─ UI layer (Remix) ───────────────────────────────────────────┐
  │  app.scans.$id.tsx  →  loader shows findings                  │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Service layer ───────────▼───────────────────────────────────┐
  │  runner.server.ts (pipeline: read → normalize → check → save)  │
  │                                                                  │
  │  ★ variantLimit already bounds Shopify-API-cost work here ★     │
  │    (catalog-reader.server.ts:24-25, 400-452) — same PRINCIPLE   │
  │    as LLM cost bounding, applied to a non-LLM budget             │
  │                                                                  │
  │  ☐ NO LLM CALL / TOKEN BUDGET EXISTS — not present               │
  └───────────────────────────┬───────────────────────────────────┘
                              │  GraphQL query
  ┌─ Provider: Shopify Admin API ──────────────────────────────────┐
  │  query-cost throttled, not token-billed                         │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Engine packages ──────────▼──────────────────────────────────┐
  │  @merchgrid/catalog-core → @merchgrid/catalog-checks            │
  │  (10 deterministic checks — CPU-bound, effectively free)         │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  Prisma → SQLite                                                │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: LLM cost optimization is the discipline of keeping a system's per-request dollar cost under control while it still clears the quality bar — model choice, token budgets, prompt size, batching, caching. MerchGrid has no LLM billing surface at all, so this file teaches the discipline as general knowledge and names the gap honestly. But there's a genuinely useful bridge worth drawing precisely, not invented: **this repo already practices the underlying principle** — bound the costly unit of work per call — it's just applied to Shopify API/variant-processing cost, not token cost. That's a real, citable line of code, not a stretch.

## Structure pass

**Axis: cost**, traced across the real layers, same as `01-llm-caching.md`'s structure pass — no layer in this repo bills per token, because no layer calls an LLM. But look at the *shape* of the one cost-control mechanism this repo does have: `variantLimit` (`catalog-reader.server.ts:23-25`) caps how much work one `readCatalog` invocation will do, checked at `:400-452` (the main products loop) and `:320-325` (per-product variant sub-pagination). Read that mechanism through the cost axis specifically (as opposed to `04-rate-limiting-backpressure.md`'s failure axis on the same lines): the *question* `variantLimit` answers is "how much of this costly, paginated unit of work am I willing to pay for in one call," which is structurally identical to the question an LLM cost-optimization system answers with a token budget or a `max_tokens` cap. **Same seam, different axis** — that's the honest, precise parallel this file draws, without claiming the repo does LLM cost optimization it doesn't do.

## How it works

### Move 1 — the mental model

Cost optimization for LLM systems is triage: not every request needs the most expensive model, not every response needs to run to its maximum possible length, and not every prompt needs to be sent from scratch every time (that's caching — see `01-llm-caching.md`). The mental model is a spending policy, not a single trick: pick the cheapest tool that clears the bar, cap how much any single request can spend, and don't repeat spend you don't have to.

```
  Pattern — the cost-optimization lever stack

  ┌─────────────────────────────────────────────┐
  │ 1. Caching        — don't re-pay for repeated│
  │                      prefixes (see 01)        │
  ├─────────────────────────────────────────────┤
  │ 2. Model tiering  — cheap model for easy work,│
  │                      expensive model only when│
  │                      quality requires it       │
  ├─────────────────────────────────────────────┤
  │ 3. Token budgets  — cap input context AND      │
  │                      output length per request │
  ├─────────────────────────────────────────────┤
  │ 4. Batching       — non-interactive workloads   │
  │                      run at a bulk discount      │
  └─────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Model tiering.** Providers ship a ladder of models at different price/quality points (for example, a fast/cheap tier, a balanced mid tier, and a top-quality/expensive tier). The lever is routing each request to the cheapest tier that will produce an acceptable result for that specific task, instead of defaulting every call to the top tier out of caution.

```
  Pseudocode — routing by task complexity

  function chooseModelTier(task):
    if task.type == "classification" or task.expectedOutputTokens < 50:
      return "cheap-fast-tier"           // simple, bounded-output tasks
    if task.requiresMultiStepReasoning or task.highStakes:
      return "top-tier"                  // correctness matters more than cost here
    return "mid-tier"                    // default for everything else
```

The failure mode on both ends is real: routing everything to the cheap tier to save money produces silently worse output on tasks that needed more reasoning; routing everything to the top tier "to be safe" is the single most common cause of an LLM feature's cost blowing past its budget in production, because most requests didn't need it.

**Token budgets — input and output, separately.** Input tokens (what you send: prompt, context, retrieved documents) and output tokens (what the model generates) are usually billed differently and controlled differently. Capping input means trimming context to what's actually needed — not sending an entire document when a relevant excerpt would do. Capping output means setting an explicit `max_tokens` ceiling so a model that starts rambling doesn't silently 10x your cost on a single request.

```
  Layers-and-hops — where a token budget check would sit in a request

  ┌─ Caller ───────────┐  hop 1: build prompt, truncate/       ┌─ LLM provider ──┐
  │  assembles context  │  summarize context to fit input       │  bills per input │
  │  (docs, history)    │  budget BEFORE sending                 │  token AND per   │
  └─────────────────────┘ ─────────────────────────────────────► │  output token,   │
                                                                    │  capped by       │
  ┌─ Caller ───────────┐  hop 2: response, truncated at          │  max_tokens       │
  │  reads response,     │  max_tokens if the model didn't        │  parameter        │
  │  tracks actual cost  │ ◄───────────────────────────────────── └───────────────────┘
  │  against budget       │
  └─────────────────────┘
```

**Batching.** For workloads that don't need an immediate response — summarizing a backlog overnight, bulk-classifying a dataset — providers typically offer a batch API at a substantial discount (commonly around half the real-time price) in exchange for higher latency (results come back within hours, not seconds). The lever here is recognizing which parts of a workload are actually latency-sensitive and which aren't, and routing only the latency-sensitive slice through the expensive real-time path.

**Caching.** Already its own file (`01-llm-caching.md`) because it's dense enough to earn one — but it belongs on this list because it's a cost lever first and a latency lever second. Skipping it here would be incomplete.

**In this codebase.** There's no token budget, no model tier, no batch job, because there's no LLM call. What *is* real and worth citing precisely: `variantLimit` (`ReadCatalogOptions`, `catalog-reader.server.ts:24-25`) is a hard cap on how much of a paginated, costly external-API read one call will do — checked after every product (`:400-452`) and before every variant sub-page fetch (`:320-325`), with the docstring at `:378-389` spelling out that it's a soft cap enforced at variant granularity so no single oversized product can blow past it. That is the exact same *shape* of decision as an LLM token budget — "cap the unit of costly work per call, and report partial results honestly (`partial: true`) rather than silently doing unbounded work." The difference is what's being metered: variants pulled from Shopify, not tokens generated by a model. Naming that difference precisely is more honest, and more useful in an interview, than pretending the repo has LLM cost controls it doesn't.

### Move 3 — the principle

Cost optimization, whether the meter is tokens or API calls, is the same discipline: know what a unit of work actually costs, cap how much of it any single request is allowed to spend, and reach for the cheapest tool that still clears your quality bar — the specific meter changes per system, the discipline of bounding and choosing deliberately doesn't.

## Primary diagram

```
  Full recap — the cost-lever stack (general pattern) vs. this repo's real analog

  GENERAL LLM COST STACK                      THIS REPO'S REAL EQUIVALENT
  ┌────────────────────────┐                  ┌──────────────────────────────┐
  │ 1. cache repeated       │                  │ (nothing — no LLM calls)      │
  │    prefixes             │                  │                                │
  ├────────────────────────┤                  ├──────────────────────────────┤
  │ 2. route to cheapest    │                  │ (nothing — no model to route) │
  │    model tier           │                  │                                │
  ├────────────────────────┤                  ├──────────────────────────────┤
  │ 3. cap input/output      │                  │ variantLimit — caps variants   │
  │    token budget          │                  │ pulled per readCatalog() call  │
  │                          │                  │ (catalog-reader.server.ts       │
  │                          │                  │  :24-25, :320-325, :400-452)    │
  ├────────────────────────┤                  ├──────────────────────────────┤
  │ 4. batch non-urgent      │                  │ (nothing — every scan is a      │
  │    workloads             │                  │  single synchronous read today) │
  └────────────────────────┘                  └──────────────────────────────┘
```

## Elaborate

Model tiering exists because providers price reasoning capability on a curve, not a flat rate — a model an order of magnitude cheaper is often good enough for classification, extraction, or routing tasks that don't need deep multi-step reasoning, and paying top-tier prices for those tasks is pure waste. Token budgeting is the most direct lever because both input and output are billed per token in almost every provider's pricing model — trimming a bloated prompt or capping a runaway generation has an immediate, visible line-item effect on cost. Batch APIs exist because providers can schedule non-urgent inference work into spare capacity, and pass some of that efficiency back as a discount — the tradeoff (latency for cost) only makes sense once you've actually identified which of your workloads don't need a real-time answer. This connects directly to `01-llm-caching.md` (caching is lever #1 on this same stack) and to `04-rate-limiting-backpressure.md`, where `variantLimit` is this file's one grounded, real example — read there through a failure axis, read here through a cost axis, same lines of code.

## Project exercises

### Exercise: add a per-shop LLM-call budget mirroring variantLimit's shape

- **Exercise ID:** EX-1
- **What to build:** Assuming the LLM finding-summary feature from `01-llm-caching.md`'s EX-1 exists (or as a standalone stub), add a per-shop monthly LLM-call/token budget counter — a new Prisma model or a field on `ShopSettings` — checked before issuing a summary request, in the same spirit as `variantLimit`'s check-before-you-spend-more pattern.
- **Why it earns its place:** proves the cost-bounding principle transfers cleanly from "variants pulled from Shopify" to "tokens spent on an LLM call" — same shape of guard, different meter, which is exactly the point this file argues.
- **Files to touch:** `app/prisma/schema.prisma` (new budget-tracking field/model), the LLM service module from `01-llm-caching.md`'s EX-1 (or a new stub if that exercise wasn't done), `app/app/services/scan/runner.server.ts` or wherever the summary call would be triggered from.
- **Done when:** a shop that has exceeded its budget gets a clear, safe "budget exceeded" response instead of the LLM call silently going through, provable with a test that pre-seeds a shop's counter at the limit.
- **Estimated effort:** M (1-2 hrs).

### Exercise: build a model-tier router as a standalone, testable function

- **Exercise ID:** EX-2
- **What to build:** The `chooseModelTier` pseudocode above, made real and unit-tested against a handful of concrete task descriptions (a short classification-shaped task, a long multi-step task, a mid-complexity default), independent of any actual LLM call being wired up.
- **Why it earns its place:** the routing *decision* is the reusable, interview-relevant artifact — you can build and test the decision logic correctly even before (or without ever) wiring up the real provider calls it would route between.
- **Files to touch:** a new file, e.g. `app/app/services/llm/model-router.ts` (new, no dependency on a real provider SDK).
- **Done when:** the router's test suite proves it picks the cheap tier for short/simple tasks and the expensive tier for long/high-stakes tasks, with the boundary conditions (task right at the token-count threshold) explicitly tested.
- **Estimated effort:** S (30-45 min).

## Interview defense

**Q: What are the main levers for controlling LLM cost in production, and which do you reach for first?**
In order of what I'd check first: caching for any repeated prefix (biggest win for near-zero engineering cost if the traffic pattern supports it — see `01-llm-caching.md`), then model tiering (route simple tasks to a cheap model instead of defaulting everything to the top tier), then explicit token budgets on both input (trim context) and output (`max_tokens` cap), then batching for anything that isn't latency-sensitive.
```
  cache (free win if applicable) → tier (route by task) → budget (hard caps) → batch (defer non-urgent)
```
One-line anchor: *cheapest fix first — check for free wins before reaching for a harder architectural change.*

**Q: This repo has no LLM calls to optimize — so what would you actually say if an interviewer pushed on this?**
Name the gap honestly, then point at the real analog: MerchGrid is deliberately rule-based, zero LLM inference (product spec §2.1, §27), so there's no token cost to optimize. But the discipline of cost optimization — bound the costly unit of work per call, and be honest when you've truncated it — is already real code here: `variantLimit` in `catalog-reader.server.ts` (`:24-25`, checked at `:320-325` and `:400-452`) caps how many variants one Shopify read will pull and marks the result `partial: true` when it stops early. It's the same shape of guard an LLM token budget would be, applied to a different meter.

## See also

- `01-llm-caching.md` — caching is the first lever on this file's stack, covered in full there.
- `04-rate-limiting-backpressure.md` — the real `variantLimit` mechanism this file's grounding points to, read there through a failure axis instead of a cost axis.
- `app/app/services/shopify/catalog-reader.server.ts` — `ReadCatalogOptions` (:23-37), the budget check sites (:320-325, :400-452).
