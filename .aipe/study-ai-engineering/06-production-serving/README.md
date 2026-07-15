# 06 — Production serving

MerchGrid: Catalog Audit is a deliberately deterministic, rule-based Shopify app — ten hand-written checks (`mg-001` through `mg-010` in `@merchgrid/catalog-checks`), zero LLM or model inference anywhere, by explicit product-spec decision (§2.1, §17.6, §27: "use deterministic checks rather than AI"). That fact shapes every file in this section.

Two of the five concepts below are real, working code — not invented, not a stretch: `catalog-reader.server.ts`, the module that reads a shop's catalog from the Shopify Admin GraphQL API, implements genuine rate-limiting-and-backpressure and retry-with-backoff. The exact code shape you'd write for a rate-limited LLM provider call is already sitting in this repo — it's just pointed at Shopify's GraphQL API, not an LLM's. The other three concepts have no code to point at in this repo at all, and are taught fully as general knowledge with that gap named plainly, not glossed over.

## Reading order

| File | Concept | Grounding |
|---|---|---|
| [`01-llm-caching.md`](./01-llm-caching.md) | Prompt caching / KV-cache reuse | **Not yet exercised.** No LLM call exists in this repo, so nothing reuses a cached prompt prefix. Taught in full as general knowledge, with a precise (not invented) bridge to `variantLimit`'s "don't redo costly work" instinct. |
| [`02-llm-cost-optimization.md`](./02-llm-cost-optimization.md) | Token budgeting / model tiering / cost governance | **Not yet exercised.** No token cost exists to optimize. Taught in full, with a precise parallel drawn to `variantLimit` (`catalog-reader.server.ts:24-25`) as the same cost-bounding principle applied to a non-LLM budget (variants pulled, not tokens spent). |
| [`03-prompt-injection.md`](./03-prompt-injection.md) | Prompt injection / instruction hijacking | **Not yet exercised.** No LLM interprets any text in this repo, so there's no injection surface. Taught in full, with an honest, precise note that this repo already routes fully untrusted, merchant-controlled text (product titles/SKUs/barcodes) through ten checks today — safely, because those checks only ever compare that text as data, never interpret it as instructions. |
| [`04-rate-limiting-backpressure.md`](./04-rate-limiting-backpressure.md) | Rate limiting & backpressure | **Real, grounded in working code.** `catalog-reader.server.ts`'s `runQuery` (`:200-241`) detects Shopify's `THROTTLED` cost-throttling (`isThrottledErrorBody`, `:186-198`) and retries with exponential backoff + full jitter (`computeRetryDelayMs`, `:175-184`). `variantLimit` (`:24-25`, checked at `:320-325` and `:400-452`) is separate, real backpressure — a self-imposed budget on total work pulled per read, not a request queue. |
| [`05-retry-circuit-breaker.md`](./05-retry-circuit-breaker.md) | Retry with backoff **+** circuit breaker | **Half real, half not, named separately in one file.** Case A (retry with backoff) is the same real mechanism as file 04, walked here through a failure-escalation lens down to `runner.server.ts`'s failure catch block (`:208-224`). Case B (circuit breaker) is **not yet exercised** — no consecutive-failure counter, no OPEN state, no fail-fast exists anywhere in this repo; every `readCatalog` call starts its failure count at zero regardless of how many recent calls just failed. |

## The honest split, in one line

Rate limiting and the retry half of resilience are real, working, well-built code in this repo, aimed at Shopify's API. Caching, cost optimization, prompt injection defense, and circuit breaking are all patterns this repo has no surface for yet — either because there's no LLM to need them (caching, cost optimization, prompt injection) or because the scale/failure profile hasn't demanded them yet (circuit breaking). Both halves of that split are worth knowing cold: the real half proves you can read and extend working resilience code; the absent half proves you know what "production-grade" would require next, and can name the gap precisely instead of overclaiming what's there.

## See also

- `app/app/services/shopify/catalog-reader.server.ts` — the file grounding files 04 and 05's Case A.
- `app/app/services/scan/runner.server.ts` — the pipeline orchestrator; its failure-catch block (`:208-224`) is where file 05's failure-escalation trace ends.
- `app/packages/catalog-checks/src/checks/` — the ten deterministic checks (`mg-001`–`mg-010`) that are the reason files 01–03 have nothing to point at.
- `/Users/rein/Public/merchgrid/merchgrid-catalog-audit-product-spec.md` — §2.1, §17.6, §27, the product decision to use deterministic checks instead of AI.
