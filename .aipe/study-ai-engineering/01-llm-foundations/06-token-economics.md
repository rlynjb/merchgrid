# Token Economics

**Token economics (per-token pricing, context-window budgeting) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where token-cost accounting would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app.settings.tsx: minimumMarginPercent — a merchant-facing    │
│  number, but a business threshold, never a cost/budget control  │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  catalog-reader.server.ts DOES meter a budget today — but it's   │
│  Shopify's GraphQL QUERY-COST throttle, not an LLM token budget    │
│                                                                       │
│         ★ token-cost accounting would live in a future LLM call ★    │
│         — does not exist; nothing here counts or bills tokens         │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ─────────────────────────────────┐
│  runChecks is a synchronous, in-process function call — $0 marginal cost, │
│  no external API metered per invocation                                    │
└───────────────────────────────────────────────────────────────────────┘
```

Every LLM call has a bill attached to it, and the bill isn't priced per request or per character — it's priced per **token**, counted separately for input (what you send) and output (what the model generates), and it's capped by a hard context-window ceiling that isn't a soft guideline, it's a wall the request fails against. This file teaches that economics, then shows you the one place in MerchGrid that already reasons about a metered, budget-capped external API — a real, close structural cousin of token economics, even though it isn't one.

## Structure pass

**Layers:** the concept lives at the boundary between "code that constructs a request to an external API" and "the provider that bills and rate-limits you for it" — a horizontal seam between your service layer and a provider's metering.

**Axis: cost — what's the unit of cost, and who tracks the budget?** Trace an LLM call: input tokens and output tokens are billed separately (output is typically several times more expensive per token than input, since generating is more compute-intensive than reading), a running conversation resends its *entire* history as input tokens on every turn (`01-what-an-llm-is.md`'s stateless-per-call fact), and the context window is a hard ceiling — exceed it and the request errors, it doesn't degrade gracefully. Now trace MerchGrid's real external dependency: the Shopify Admin GraphQL API. `readCatalog` in `app/app/services/shopify/catalog-reader.server.ts` is metered too — Shopify's cost-throttling returns an `extensions.code: "THROTTLED"` GraphQL error (line 192-198's `isThrottledErrorBody`) when a shop's query-cost budget is exhausted, and MerchGrid explicitly retries with exponential backoff (`computeRetryDelayMs`, lines 176-184) rather than treating it as a hard failure. The *shape* of "a metered external API with a budget you can exhaust and must respect" is identical to token economics; the *unit* being metered (Shopify's GraphQL query-cost points vs. an LLM's tokens) is different. Naming that precisely — same shape, different meter — is the honest way to draw this analogy without overclaiming.

**Seam:** the seam is wherever code decides how much of a metered external resource to request before making the call, and how to react when the provider says "not right now." `catalog-reader.server.ts` has that seam today, real and load-bearing (`variantLimit`, `maxRetries`, backoff). An LLM-token-budgeting seam does not exist anywhere in this repo, but would need the identical shape: estimate cost before the call, cap the request if it would exceed a budget, back off and retry on a rate-limit response.

## How it works

### Move 1 — the mental model

You've built a paginated list that stops loading more items once it hits a fixed page-size cap, and you've handled a `429 Too Many Requests` from a rate-limited API by backing off and retrying. Token economics is both of those ideas applied to a single LLM call: pagination becomes "don't exceed the context window," and rate-limit backoff becomes "the provider bills and throttles you per token, so budget before you send."

```
Pattern — the token budget as a hard ceiling, not a soft guideline

  context window: 128,000 tokens (example — varies by model)

  ┌─────────────────────────────────────────────────────────┐
  │  system prompt   │  conversation history  │  new message │  ← input tokens
  └─────────────────────────────────────────────────────────┘
  │◄──────────────────── must fit ─────────────────────────►│
                                                              │
                                          space left ─────────┤◄─ output tokens
                                                              │   generated here
                                                              ▼
                                              exceed the window → request FAILS,
                                              it does not silently truncate
```

### Move 2 — the step-by-step walkthrough

**Part 1 — input tokens and output tokens are billed at different rates, and both count against the window.** Providers typically price output tokens several times higher than input tokens, because generating a token (a forward pass plus sampling) costs more compute than reading one (which can be processed in parallel across the whole prompt at once). Both draw from the *same* context-window ceiling — a huge prompt leaves less room for the response, and a request that would need more output tokens than remain in the window fails or gets cut off, it doesn't automatically get a bigger window.

**Part 2 — a multi-turn conversation re-bills its entire history, every turn.** Because the model is stateless per call (`01-what-an-llm-is.md`), a 10-turn chat doesn't cost "10 turns worth of new tokens" — turn 10 resends turns 1 through 9 as input tokens, plus the new message. Cost and context-window pressure both grow roughly linearly (or worse, if you're also appending retrieved context or tool results each turn) with conversation length, which is precisely why production systems truncate or summarize old history rather than letting a conversation grow unbounded — an unmanaged history eventually either blows the budget or blows the window.

```
function estimateRequestCost(promptTokens, expectedOutputTokens, pricing):
  inputCost = promptTokens * pricing.perInputToken
  outputCost = expectedOutputTokens * pricing.perOutputToken
  return inputCost + outputCost

// called BEFORE sending, so an over-budget request can be trimmed,
// rejected, or routed to a cheaper model — not discovered after the bill arrives
```

**Part 3 — token cost is why prompt design and retrieval scope are cost decisions, not just quality decisions.** Every extra paragraph of system prompt, every extra retrieved document, every turn of un-truncated history is billed, every single call. This is the direct financial consequence of `02-tokenization.md`'s fact that dense identifiers (SKUs, UUIDs) tokenize worse than prose — feeding a model a raw catalog export full of SKUs costs measurably more per row than the equivalent amount of natural-language description would.

**Part 4 — a metered API you don't own needs the same three guardrails, LLM or not: a cap, a retry policy, and a way to react to "budget exhausted."** This is exactly what makes MerchGrid's real code the right teaching anchor here. `readCatalog` (`app/app/services/shopify/catalog-reader.server.ts` lines 400-452) enforces `opts.variantLimit` as a hard cap (checked *before* issuing another sub-query, line 320-325 — "budget check BEFORE issuing another sub-query" per the comment), retries a `THROTTLED` response with exponential backoff and jitter (`computeRetryDelayMs`, lines 176-184: `RETRY_BASE_DELAY_MS * 2 ** attempt`, capped at `RETRY_MAX_DELAY_MS`, jittered so concurrent retries don't thunder-herd), and marks the result `partial: true` (line 442) when the cap was hit before the catalog was fully read — an explicit, honest signal to the caller that the budget, not an error, is why the result is incomplete. Every one of those three moves — cap before you spend, back off and retry on "you've hit the meter," and surface truncation honestly instead of silently under-delivering — is exactly what a token-budgeting layer for an LLM call would need to do, just against a different meter (query-cost points, not tokens).

**In this codebase:** not yet implemented for LLM tokens — there is no token counter, no per-1K-token pricing table, and no context-window check anywhere in this repo, because there is no LLM call to budget for. The metered, budget-capped, retry-with-backoff pattern that *does* exist in this repo — `catalog-reader.server.ts`'s Shopify query-cost handling described above — is a real, verifiable instance of the exact same *shape* of problem (bounded external API, must cap and retry), not an instance of token economics itself; don't let the structural resemblance become an overclaim in an interview.

If MerchGrid ever built the AI-assisted bulk editor, a token-budgeting layer would attach at the same point a schema validator would (`04-structured-outputs.md`) — inside a new `app/app/services/ai/` module, before any call to a provider: estimate the prompt's token count (informed by `02-tokenization.md`'s tokenizer mechanics), check it against the target model's context window, and apply the same cap-before-you-spend and backoff-on-throttle discipline `catalog-reader.server.ts` already applies to Shopify's API — the pattern transfers even though the meter doesn't.

### Move 3 — the principle

Every metered external API — an LLM provider billing per token, or Shopify's GraphQL query-cost throttle — needs the same three guardrails: know your cost *before* you spend it, retry with backoff when the provider says "not right now," and surface truncation or partial results honestly instead of pretending the budget wasn't hit. Token economics is that general pattern applied to the specific unit an LLM provider bills you in; the pattern is older and broader than LLMs, and MerchGrid already has a working, tested instance of it for a different provider.

## Primary diagram

```
Primary diagram — token economics, and its real structural cousin in MerchGrid

  LLM TOKEN ECONOMICS (not built)         SHOPIFY QUERY-COST BUDGET (real, built)
  ──────────────────────────────         ────────────────────────────────────────
  meter: input + output tokens           meter: GraphQL query-cost points
  cap: context window (hard ceiling)     cap: opts.variantLimit (soft, checked
                                           before each sub-query, catalog-reader.
                                           server.ts lines 320-325)
  throttle signal: 429 / rate-limit err  throttle signal: extensions.code:
                                           "THROTTLED" (line 192-198)
  guardrail: estimate cost pre-call      guardrail: budget check pre-call
  guardrail: backoff + retry on throttle guardrail: computeRetryDelayMs, real
                                           exponential backoff + jitter (176-184)
  guardrail: surface truncation honestly guardrail: partial: true on the
                                           returned CatalogSnapshot (line 442)

  same SHAPE of problem, different METER — the pattern transfers, the numbers don't
```

## Elaborate

Per-unit metering for a scarce, provider-controlled resource is an old pattern — API rate limiting, cloud compute billed per CPU-second, even Shopify's own GraphQL cost-point system predates any LLM feature MerchGrid might build. What's specific to token economics is the *unit itself* (a token, not a request or a second) and the fact that the same meter also defines a hard architectural ceiling (the context window) that request design has to work around, not just a rate you can smooth out with backoff. That combination — "the meter is also the wall" — is the thing worth remembering distinctly from plain API rate limiting.

## Project exercises

### Build a pre-call budget estimator modeled on the real Shopify guardrail

- **Exercise ID:** EX-1
- **What to build:** A new `app/app/services/ai/budget.server.ts` exporting `estimateAndCapPrompt(promptTokens: number, historyTokens: number, contextWindow: number, maxOutputTokens: number): { fits: boolean; truncatedHistoryTokens?: number }` that mirrors `catalog-reader.server.ts`'s "check the budget before issuing another sub-query" discipline (lines 320-325) — checking whether `promptTokens + historyTokens + maxOutputTokens` fits inside `contextWindow` before any hypothetical call, and truncating oldest history first if not.
- **Why it earns its place:** It's a direct, testable translation of a guardrail this repo already has working code for (`catalog-reader.server.ts`'s pre-call budget check), applied to the token-economics problem instead of the Shopify query-cost problem — proving you understand the pattern transfers, not just that you can describe it.
- **Files to touch:** New file `app/app/services/ai/budget.server.ts`; new test `app/app/services/ai/budget.test.ts`.
- **Done when:** A test shows a request that would exceed the context window gets its history truncated (oldest-first) until it fits, and a request already inside budget passes through unchanged.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: Why is the context window a hard ceiling rather than something you can just retry past?**
A: Because it's not a rate limit you wait out — it's a fixed size the model's architecture was built and trained around. Input tokens and output tokens both draw from the same window; if your prompt plus expected output would exceed it, the request fails outright, or the provider truncates in a way you don't control. The only fix is trimming what you send (shorter history, less retrieved context) before the call, not backing off and retrying the same request.

```
  rate limit:      retry later, same request, same size        → works
  context window:  retry later, SAME size request               → still fails
                   must SHRINK the request itself                → this works
```

**Q: Does MerchGrid have any real experience with a metered, budget-capped external API?**
A: Yes — just not tokens. `catalog-reader.server.ts`'s `readCatalog` treats Shopify's GraphQL API as cost-metered: it checks the remaining variant budget (`opts.variantLimit`) before issuing another sub-query (lines 320-325), retries a `THROTTLED` response with exponential backoff and jitter (`computeRetryDelayMs`, lines 176-184), and marks the result `partial: true` when the cap was hit rather than silently returning an incomplete catalog as if it were complete. Same three guardrails a token-budgeting layer needs — cap before you spend, back off on throttle, surface truncation honestly — just against Shopify's meter instead of an LLM provider's.

**Q: If MerchGrid built the bulk-AI feature, what token-economics guardrail would you build first, and why?**
A: A pre-call budget estimator, modeled directly on `catalog-reader.server.ts`'s existing pattern — check the prompt's estimated token count against the target model's context window *before* making the call, not after it fails. The reasoning: MerchGrid already has a working, tested version of "check the budget before you spend it" for a different meter; reusing that discipline is cheaper and more consistent than inventing token handling from scratch.

## See also

- `01-what-an-llm-is.md` — the stateless-per-call fact that makes conversation history re-billing (Move 2 Part 2) unavoidable.
- `02-tokenization.md` — why identifiers like SKUs cost more per character than prose, a direct driver of token cost.
- `app/app/services/shopify/catalog-reader.server.ts` — the real, tested metered-API guardrail this file uses throughout as the honest structural analog.
- `08-provider-abstraction.md` — where a provider swap would also mean a pricing-table swap, since token economics is provider-specific.
