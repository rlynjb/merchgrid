# 05 — Production serving for agents (skipped)

No concept files are generated in this sub-section.

## Why this sub-section is empty

Cross-turn caching, fan-out backpressure, and per-tool circuit breaking are all serving concerns that only show up once a system's unit of execution is an autonomous loop or a topology issuing many LLM calls, often concurrently, often repeatedly against the same tool. MerchGrid: Catalog Audit issues **zero LLM calls** in production — there is nothing to cache across turns, no concurrent agent fan-out to rate-limit, and no tool a loop could hammer repeatedly, because there is no loop.

This codebase does have a real, adjacent reliability pattern worth knowing about, just not this one: `app/app/services/shopify/catalog-reader.server.ts:200-241`'s `runQuery` retries Shopify's cost-throttled GraphQL API with exponential backoff and jitter, and `catalog-reader.server.ts`'s pagination loop enforces a hard `variantLimit` budget. That's single-call-scoped reliability engineering against an external API — the kind of pattern `study-performance-engineering` or `study-networking` guides would cover — not the agent-specific serving concerns (a loop's *repeated* calls to the *same* flaky tool, or a supervisor's fan-out overwhelming a rate limit) this sub-section is about. See `01-reasoning-patterns/02-agent-loop-skeleton.md` for where that retry logic is read as loop-hardening rather than a serving concern.

## If this changes

If "MerchGrid: Bulk AI" is ever built as an agent that calls tools repeatedly across many turns, or fans work out across multiple concurrent workers, these three concepts become directly relevant — a per-tool circuit breaker in particular would matter the moment an agent can call the same flaky tool on every turn of a long-running loop. Until an agent loop exists at all, there's no serving surface for these concerns to describe.
