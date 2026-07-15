# Rate limiting & backpressure

Subtitle: **Rate limiting** (provider-imposed request throttling) and **backpressure** (self-imposed bounded work) — Industry standard, both halves.

## Zoom out, then zoom in

Here's the whole system, one hop at a time, from a Remix loader down to the SQLite row a finding eventually lands in:

```
  Zoom out — where this concept lives in MerchGrid

  ┌─ UI layer (Remix) ───────────────────────────────────────────┐
  │  app.scans.$id.tsx  →  loader polls scan status               │
  └───────────────────────────┬───────────────────────────────────┘
                              │  enqueue / poll
  ┌─ Service layer ───────────▼───────────────────────────────────┐
  │  queue.server.ts  →  runner.server.ts (pipeline orchestrator)  │
  │        │                                                       │
  │        │  calls readCatalog(admin, opts)                       │
  │        ▼                                                       │
  │  catalog-reader.server.ts   ★ THIS CONCEPT LIVES HERE ★        │ ← we are here
  └───────────────────────────┬───────────────────────────────────┘
                              │  GraphQL query over HTTPS
  ┌─ Provider: Shopify Admin API ──────────────────────────────────┐
  │  cost-throttled GraphQL endpoint (query-cost budget per shop)  │
  └───────────────────────────┬───────────────────────────────────┘
                              │  RawCatalog (products + variants)
  ┌─ Engine packages ──────────▼──────────────────────────────────┐
  │  @merchgrid/catalog-core (normalize)                            │
  │  @merchgrid/catalog-checks (mg-001..mg-010, deterministic)      │
  └───────────────────────────┬───────────────────────────────────┘
                              │  findings
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  Prisma → SQLite (Scan, Finding rows)                           │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: `catalog-reader.server.ts` is the one place in this repo that talks to an external API it doesn't control the pace of. Shopify's Admin GraphQL API prices every query in "cost points" and throttles you when you spend too many too fast — the exact same shape of problem as any rate-limited HTTP API, LLM provider included. This file answers two different questions that get bundled together in casual conversation but are not the same mechanism: **rate limiting** ("the other side told me to slow down — what do I do?") and **backpressure** ("how much work do I let myself pull before I stop on my own?"). Both live in this one module. Neither is hypothetical here — both are real, running code.

## Structure pass

**Axis: failure.** Trace "what happens when this call doesn't succeed" across the layers:

- **Provider (Shopify):** a throttled call doesn't come back as a dropped connection — it comes back as an HTTP 200 with a GraphQL `errors` array carrying `extensions.code: "THROTTLED"`. A network blip comes back as a rejected promise. Two different failure *shapes*, same underlying cause (too much load, right now).
- **Service layer (`catalog-reader.server.ts`):** absorbs both shapes. This is the layer that owns "is this failure worth retrying?"
- **Above it (`runner.server.ts`):** never sees a throttle at all if the retry succeeds. If retries exhaust, it sees one more thrown `Error` — indistinguishable from any other pipeline failure.
- **UI layer:** sees a scan that's `FAILED` with a generic message. No trace of throttling ever reaches the merchant.

**Seam:** the boundary between `catalog-reader.server.ts` and the Shopify API is where the failure-axis answer flips — from "provider-visible throttle response" to "internal retry decision." That's the seam this file studies. There's a second, unrelated seam inside the same file: the boundary between "keep pulling more pages" and "stop, we've hit budget" — that's `variantLimit`, and it's a **cost/scope** axis, not a failure axis. Rate limiting and backpressure are two seams sitting in the same file, not one concept wearing two names.

## How it works

### Move 1 — the mental model

You've called a rate-limited API before — every LLM provider's SDK has a `429` response and a `retry-after` header. Shopify does the same job with a different shape: instead of a flat request-per-second cap, it prices each GraphQL query in points and throttles you once you overspend your bucket. The strategy either way is the same: **detect the "slow down" signal, wait an increasing amount of time, try again, give up after a budget of attempts.** Backpressure is the second, separate strategy: **don't wait for the provider to tell you to slow down — decide for yourself how much work you're willing to pull in one go, and stop early once you've hit it.**

```
  Pattern — two independent control loops, one file

  RATE LIMITING (reactive — provider tells you)     BACKPRESSURE (proactive — you decide)
  ┌────────────────────────────┐                    ┌────────────────────────────┐
  │ send request                │                    │ check: have I pulled       │
  │   │                         │                    │ enough work already?       │
  │   ▼                         │                    │   │                        │
  │ throttled? ──yes──► wait,   │                    │  yes ──► STOP, mark partial│
  │   │ no          retry       │                    │   │ no                     │
  │   ▼                         │                    │   ▼                        │
  │ done                        │                    │ pull one more page         │
  └────────────────────────────┘                    └────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**Detecting the throttle.** You already know the shape from any REST API: a `429` status code means "you're over your limit." Shopify's GraphQL API can't use a status code the same way because a single request can return partial errors alongside partial data, so it flags the throttle inside the response body instead — a `THROTTLED` code buried in `errors[].extensions.code`. `isThrottledErrorBody` (`catalog-reader.server.ts:186-198`) is the function that recognizes this:

```
function isThrottledErrorBody(body):
  if body has no `errors` array → return false      // not an error response at all
  return true if ANY error in body.errors has
    extensions.code (case-insensitive) === "THROTTLED"
```

This matters because a well-formed GraphQL error is not automatically retryable — a query with a typo'd field name also comes back with an `errors` array, and retrying *that* five times just wastes five retries on a bug that will never fix itself. `isThrottledErrorBody` is the gate that separates "the provider is asking me to slow down" (retry) from "my query is wrong" (fail immediately). Miss this check and you either retry bugs forever or bail on legitimate throttles — both are wrong.

**Backing off.** You've seen exponential backoff before — double the wait each time, cap it so it doesn't grow forever. `computeRetryDelayMs` (`catalog-reader.server.ts:175-184`) does exactly that, with one extra piece:

```
function computeRetryDelayMs(attempt):
  capped = min(500ms * 2^attempt, 8000ms)      // doubling, capped at 8s
  return capped/2 + random() * (capped/2)       // full jitter: land anywhere
                                                  // in the top half of the range
```

The doubling (`RETRY_BASE_DELAY_MS = 500`, doubling per attempt, `RETRY_MAX_DELAY_MS = 8_000` as the ceiling) is the part everyone remembers. The jitter is the part that's easy to skip and shouldn't be: without it, every client throttled at the same moment (a burst of scans kicked off around the same time) would all sleep for the *exact same* duration and all retry in the same instant — recreating the exact spike that got them throttled in the first place. Full jitter (picking anywhere in `[capped/2, capped]`, rather than a fixed `capped`) spreads those retries out in time so they don't re-collide.

```
  Execution trace — computeRetryDelayMs across four attempts

  attempt   base*2^attempt   capped at 8000ms   jittered range        example draw
  0         500              500                 [250, 500]            341ms
  1         1000             1000                [500, 1000]            812ms
  2         2000             2000                [1000, 2000]          1450ms
  3         4000             4000                [2000, 4000]          3120ms
  4         8000             8000  (capped)      [4000, 8000]          6003ms
```

**The retry loop itself.** `runQuery` (`catalog-reader.server.ts:200-241`) is the kernel — the loop that everything above feeds into:

```
function runQuery(admin, query, variables, policy):
  attempt = 0
  loop forever:
    try:
      body = admin.graphql(query, variables).json()
    catch (network rejection):                  // line 213-224
      if attempt < policy.maxRetries:
        sleep(computeRetryDelayMs(attempt)); attempt += 1; continue
      throw safe wrapped error                  // never the raw network error

    if body has non-empty errors:                // line 226-237
      if isThrottledErrorBody(body) and attempt < policy.maxRetries:
        sleep(computeRetryDelayMs(attempt)); attempt += 1; continue
      throw safe wrapped error                  // never the raw GraphQL error text

    return body                                  // success
```

Two things are load-bearing here and both would break silently if removed:

- **The two separate catch points (network rejection vs. well-formed throttled body) both feed the same retry counter.** Drop either one and half of Shopify's failure modes stop retrying — a transient 5xx that rejects the promise would be treated as fatal even though it's exactly as recoverable as a `THROTTLED` body.
- **The safe error message at both throw sites** (`catalog-reader.server.ts:221-223`, `234-236`) never includes the underlying GraphQL error text, query, or stack. The file's own comment names why: internal schema/query details shouldn't leak to logs or callers beyond this module. This is worth naming out loud because it's easy to "fix" by accident — a well-meaning refactor that includes `err.message` in the thrown error for "better debugging" reintroduces an information leak the original author deliberately closed.

**Configurable, test-friendly policy.** `ReadCatalogOptions` (`catalog-reader.server.ts:23-37`) exposes `maxRetries` (default 4, `DEFAULT_MAX_RETRIES`) and an injectable `sleep` function. This is a small detail worth naming because of what it buys: `app/test/catalog-reader.test.ts` can simulate five straight `THROTTLED` responses and assert the retry count and final safe error — without a single real `setTimeout` firing. If `sleep` weren't injectable, testing "what happens after 4 failed retries" would mean a real test either takes several real seconds (bad) or the retry logic goes untested (worse).

**Backpressure — a different mechanism, same file.** `variantLimit` (part of `ReadCatalogOptions`, `catalog-reader.server.ts:24-25`) is not a rate limiter — nothing external is telling MerchGrid to slow down here. It's a budget MerchGrid imposes on itself: stop pulling more product/variant pages once you've collected enough. Two places enforce it:

```
  Layers-and-hops — where the budget check happens inside one readCatalog() call

  ┌─ readCatalog() main loop ─────────────────┐   hop: for each product page
  │  (catalog-reader.server.ts:400-452)        │ ─────────────────────────────►
  │  after each product: check                 │
  │  variantsProcessed >= opts.variantLimit    │ ◄───── hop: pageInfo.hasNextPage
  └───────────────────┬────────────────────────┘
                       │  per product, if it has >100 variants
                       ▼
  ┌─ fetchAllVariants() sub-pagination ───────┐   hop: PRODUCT_VARIANTS_PAGE_QUERY
  │  (catalog-reader.server.ts:320-325)        │ ─────────────────────────────►
  │  BEFORE issuing another sub-query:         │
  │  if nodes.length >= remaining → stop,      │
  │  mark truncated                            │
  └────────────────────────────────────────────┘
```

Be precise about what this is and isn't. It is **budget-based backpressure on the total work pulled from one paginated read** — a soft cap checked after every product and before every variant sub-page, so one pathologically large product (>100 variants) can't blow past the guardrail by itself (`catalog-reader.server.ts:309-325`, docstring at `378-389`). It is **not a request queue** — nothing here rejects an *incoming* scan request or holds it waiting for capacity. There's no queue data structure, no "reject if full." It's one read deciding, mid-flight, that it has done enough work and setting `partial: true` on the way out. If you conflate the two, you'll go looking for a queue in this file and not find one — because the pattern here answers "how much do I pull," not "how many callers do I admit."

### Move 3 — the principle

Rate limiting and backpressure are the same instinct — protect a system from being asked to do more than it safely can — applied from two different directions: rate limiting is what you do when *someone else* imposes the limit on you (respond, back off, retry with jitter); backpressure is what you impose on *yourself* before anyone has to tell you to stop (bound the unit of work, stop early, report what got skipped). Production systems need both, and they're not interchangeable: a perfect retry policy still lets one giant catalog run forever if nothing bounds the total pull; a perfect budget still gets you banned if you ignore the provider's throttle signal on the way there.

## Primary diagram

```
  Full recap — retry (reactive) and backpressure (proactive) in one readCatalog() call

  ┌─ runner.server.ts ───────────────────────────────────────────────┐
  │  calls readCatalog(admin, { variantLimit, maxRetries, sleep })    │
  └───────────────────────────┬───────────────────────────────────────┘
                              ▼
  ┌─ readCatalog() loop (:400-452) ───────────────────────────────────┐
  │  for each products page:                                           │
  │    runQuery(PRODUCTS_PAGE_QUERY) ──┐                                │
  │    for each product:               │  RATE LIMITING kernel         │
  │      buildProduct → fetchAllVariants│  (runQuery, :200-241)         │
  │        runQuery(VARIANTS_QUERY) ───┤  ┌─────────────────────────┐ │
  │        budget check (:320-325) ────┼─►│ THROTTLED? → backoff+jitter│
  │      variantsProcessed >= limit?    │  │ (isThrottledErrorBody,   │ │
  │        → STOP, partial: true        │  │  computeRetryDelayMs)    │ │
  │                                      │  │ maxRetries exceeded?     │ │
  │                                      │  │ → throw safe error       │ │
  │                                      │  └─────────────────────────┘ │
  │                                      │           BACKPRESSURE:      │
  │                                      └── variantLimit soft cap ─────┤
  └───────────────────────────┬───────────────────────────────────────┘
                              │  RawCatalog { products, partial }
                              ▼
                    onward to normalizeCatalog / runChecks
```

## Elaborate

Cost-based (rather than request-per-second) throttling is Shopify's own design choice — it prices query *shape*, not just query *count*, because a `products(first: 250) { variants(first: 250) { ... } }` query costs far more backend work than a shallow one, even as "one request." Exponential backoff with jitter is the same algorithm AWS popularized in its SDKs and that's now table stakes in every serious HTTP client library; the "full jitter" variant specifically (as opposed to "equal jitter" or no jitter) comes from AWS's own 2015 architecture blog post on backoff strategies, and it's the version implemented here. Backpressure as a term comes from fluid dynamics and queueing theory before it came to mean "stop pulling data faster than downstream can consume it" in streams and pull-based pipelines — the version in this file (a self-imposed budget on total pull) is the simplest form of it: no queue, no consumer signaling, just "I've done enough, stop." See `05-retry-circuit-breaker.md` for what this retry mechanism is missing to be resilient against *sustained* (not just transient) provider failure.

## Project exercises

### Exercise: prove the retry budget under sustained throttling

- **Exercise ID:** EX-1
- **What to build:** A test in `app/test/catalog-reader.test.ts` that feeds `createFakeAdmin` a run of `maxRetries + 1` consecutive `THROTTLED` responses and asserts `readCatalog` throws the exact safe error message (never the raw GraphQL error text), and that exactly `maxRetries + 1` total calls were made (initial attempt + `maxRetries` retries, no more, no fewer).
- **Why it earns its place:** the existing test suite almost certainly proves retries happen at all; this exercise proves the *boundary* — that the loop stops at the configured count instead of retrying forever, which is the difference between "resilient" and "a hung request."
- **Files to touch:** `app/test/catalog-reader.test.ts`, reading `app/app/services/shopify/catalog-reader.server.ts` for the exact thrown message strings.
- **Done when:** the test fails if `policy.maxRetries` is bumped by one in the implementation without a matching test update (i.e. the assertion pins the exact call count, not just "it throws").
- **Estimated effort:** S (30-45 min).

### Exercise: make the jitter algorithm swappable and prove it spreads load

- **Exercise ID:** EX-2
- **What to build:** Extract `computeRetryDelayMs` from a hardcoded function into an injectable strategy on `RetryPolicy` (default: today's full-jitter formula), then write a test that runs the delay function 1,000 times at `attempt = 2` and asserts the outputs are spread across the `[1000, 2000]` range rather than clustering near one value — a statistical proof that jitter is actually doing its job, not just present in the code.
- **Why it earns its place:** "there's jitter" and "the jitter actually decorrelates concurrent retries" are different claims; only the second one is what jitter is for. Making the strategy swappable also sets up comparing full jitter against equal jitter, which is a real production tuning knob.
- **Files to touch:** `app/app/services/shopify/catalog-reader.server.ts` (extract the strategy), `app/test/catalog-reader.test.ts` (the distribution test).
- **Done when:** the distribution test passes with today's full-jitter formula and would fail against a naive fixed-delay backoff (write the fixed-delay case first and watch it fail, to prove the test has teeth).
- **Estimated effort:** M (1-2 hrs).

### Exercise: turn variantLimit into a per-shop-plan-tier budget

- **Exercise ID:** EX-3
- **What to build:** Instead of one hardcoded `variantLimit` passed into every `readCatalog` call, derive it from the shop's plan tier (a new column or a simple lookup keyed off `ShopSettings`), so a higher-tier shop gets a larger backpressure budget than a free-tier shop.
- **Why it earns its place:** demonstrates that backpressure budgets are a product decision, not just an engineering constant — the same mechanism (`variantsProcessed >= opts.variantLimit`) becomes a monetizable capability once it's configurable per caller instead of fixed.
- **Files to touch:** `app/prisma/schema.prisma` (if a tier column is needed), `app/app/services/scan/runner.server.ts` (where `readCatalog`'s options get built), `app/app/services/shopify/catalog-reader.server.ts` (no change needed — it already takes `variantLimit` as an option).
- **Done when:** two shops with different tiers produce different `variantLimit` values passed into the same `readCatalog` call, provable with a runner-level test that stubs two different `ShopSettings` rows.
- **Estimated effort:** M (1-2 hrs).

## Interview defense

**Q: Walk me through this codebase's retry logic and name what's missing for production-grade resilience.**
The real mechanism: `catalog-reader.server.ts`'s `runQuery` catches both a rejected `admin.graphql()` call and a well-formed `THROTTLED` GraphQL error body, and retries either with exponential backoff (`500ms * 2^attempt`, capped at `8000ms`) plus full jitter, up to `maxRetries` (default 4) before throwing a safe, non-leaking error. What's missing: a **circuit breaker**. Every single `readCatalog` invocation starts its failure counter at zero — if Shopify is down for ten minutes, the very next scan (and the one after that, and the one after that) will each patiently retry four times and burn through the full backoff schedule before failing, instead of noticing "the last N calls all failed, stop trying and fail fast." See `05-retry-circuit-breaker.md` for the full gap.
```
  retry (present)                    circuit breaker (absent)
  ┌──────────────────┐               ┌──────────────────┐
  │ attempt → backoff │               │ track consecutive │
  │ → retry → give up │               │ failures → OPEN → │
  │  (resets each call)│               │ fail fast → probe │
  └──────────────────┘               └──────────────────┘
```
One-line anchor: *backoff handles "try again in a moment," a circuit breaker handles "stop trying, something's actually down."*

**Q: Why does `isThrottledErrorBody` check need to exist at all — why not just retry every GraphQL error?**
Because not every `errors` array means "try again later." A malformed query (unknown field, bad argument) also returns a well-formed `errors` array, and it will return the exact same error on every retry — burning the full retry budget (and its backoff delays) on a bug that a human needs to fix, not a transient condition that clears with time. `isThrottledErrorBody` is the gate that keeps retryable and non-retryable failures from being treated identically.
```
  errors array present
       │
       ├─ extensions.code === "THROTTLED" → retryable, back off
       └─ anything else (bad field, bad arg) → fail immediately
```
One-line anchor: *retrying blindly turns a five-second bug report into a forty-second timeout.*

**Q: What's the difference between the rate limiting and the backpressure in this file — aren't they the same thing?**
No — they answer different questions and one is reactive while the other is proactive. Rate limiting (`runQuery`'s retry loop) reacts to a signal Shopify sends: "you're over budget, wait." Backpressure (`variantLimit`, checked in the main loop and in `fetchAllVariants`) is a budget MerchGrid imposes on itself regardless of what Shopify says, to bound how much of one paginated read it will pull before stopping and reporting `partial: true`. Removing the retry logic would make MerchGrid fragile to Shopify's throttling; removing `variantLimit` would make MerchGrid vulnerable to one enormous catalog running an unbounded number of calls, even with zero throttling.

## See also

- `05-retry-circuit-breaker.md` — the retry half of this file's mechanism, and the circuit-breaker half that doesn't exist yet.
- `02-llm-cost-optimization.md` — reads the same `variantLimit` lines through a cost axis instead of a failure axis.
- `app/app/services/shopify/catalog-reader.server.ts` — the file this concept is grounded in, in full.
- `app/test/catalog-reader.test.ts` — the existing test coverage for the retry/backoff behavior.
