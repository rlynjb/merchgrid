# LLM prompt caching

Subtitle: **Prompt caching / KV-cache reuse** — Industry standard (not yet exercised in this repo).

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
  │  ☐ NO LLM CALL EXISTS ANYWHERE IN THIS PIPELINE — not present   │
  │    (10 checks in @merchgrid/catalog-checks are hand-written     │
  │     rules — mg-001 through mg-010 — zero model inference)       │
  └───────────────────────────┬───────────────────────────────────┘
                              │  GraphQL query
  ┌─ Provider: Shopify Admin API ──────────────────────────────────┐
  │  the only external API this repo calls — not an LLM provider    │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Engine packages ──────────▼──────────────────────────────────┐
  │  @merchgrid/catalog-core → @merchgrid/catalog-checks            │
  │  (deterministic, rule-based — see product spec §2.1, §27)        │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ Storage layer ────────────▼──────────────────────────────────┐
  │  Prisma → SQLite                                                │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: prompt caching is a cost-and-latency trick for LLM APIs specifically — it has nothing to reuse here, because there's nothing in this repo that sends a prompt. MerchGrid is a deliberately deterministic, rule-based Shopify app: ten hand-written checks (`mg-001` through `mg-010`), zero LLM calls, by design (product spec §2.1, §17.6, §27 — "use deterministic checks rather than AI"). This file teaches prompt caching in full as general knowledge, because it's the kind of thing you're expected to know cold in a production-LLM-systems conversation, and names honestly, up front, that there's no code in this repo to point at for it.

## Structure pass

**Axis: cost**, traced across the real layers of this repo, to locate the seam where an LLM call — and therefore prompt caching — would have to sit if one were ever added: the UI layer costs nothing per request beyond normal hosting. The Shopify API hop costs query-cost points, not dollars-per-token, and Shopify doesn't charge MerchGrid per call the way an LLM provider bills per token. The engine packages (`catalog-core`, `catalog-checks`) run pure, cheap, deterministic TypeScript — CPU-bound, no external call, no per-invocation dollar cost worth measuring. Storage is a local SQLite file. **Nowhere in this trace does a per-token, per-request dollar cost exist.** The seam where that cost axis would first appear is exactly the seam where an LLM call would first appear: the one point in the pipeline where a check currently returns a rule-based finding (`@merchgrid/catalog-checks`'s `run()` functions, e.g. `packages/catalog-checks/src/checks/mg-005.ts`) is the closest analog to where a model-generated explanation could someday be inserted — and that's exactly the seam this file's Elaborate section and Project Exercises anchor a hypothetical addition to.

## How it works

### Move 1 — the mental model

You already memoize expensive pure function calls — same input, skip the recompute, return the cached result. Prompt caching is the same idea applied one layer lower, inside the model call itself: instead of caching the *whole response* to an *identical* request (that's response caching, a different and much blunter tool), prompt caching lets the provider skip re-processing a *repeated prefix* of tokens — the part of the prompt that doesn't change between calls, like a long system prompt or a big tool-schema block — even when the *rest* of the prompt (the user's actual question) is different every time.

```
  Pattern — prompt caching reuses a shared prefix, not the whole request

  Request 1: [ system prompt ][ tool schemas ][ user turn A ]
              └────── cached ──────┘            not cached

  Request 2: [ system prompt ][ tool schemas ][ user turn B ]
              └── CACHE HIT, skip reprocessing ──┘  (only turn B is new work)

  Request 3: [ system prompt ][ DIFFERENT tool schemas ][ user turn C ]
              └── CACHE MISS ──┘  even one byte of prefix change invalidates it
```

### Move 2 — the step-by-step walkthrough

**What actually gets cached.** An LLM's attention mechanism computes a "key-value" (KV) representation for every token in the prompt before it can generate anything — this is the expensive part, and it scales with prompt length. Prompt caching (Anthropic and OpenAI both expose a version of this) lets the provider store the KV state for a prefix of tokens after the first call, then on a later call with the *identical* prefix, skip recomputing that portion entirely and start from the cached state. This only works for an exact, byte-for-byte matching prefix — reorder two sentences in your system prompt, or change one word in a "current date: ..." line inside it, and the cache misses from that point forward.

```
  Layers-and-hops — where a cache lookup would sit in an LLM request

  ┌─ Caller ───────────────┐   hop 1: send prompt with a cache             ┌─ LLM provider ──┐
  │  builds prompt:         │   breakpoint marker after the shared prefix  │  hashes the      │
  │  [system+tools][user]   │ ─────────────────────────────────────────►   │  prefix, checks   │
  └─────────────────────────┘                                              │  cache store      │
                              hop 2: response + usage showing               │  HIT → skip        │
                              cache_read_input_tokens vs                    │  reprocessing      │
                              cache_creation_input_tokens          ◄─────── │  MISS → process    │
  ┌─ Caller ───────────────┐                                                │  full prefix,      │
  │  reads usage, tracks    │                                                │  write to cache    │
  │  cost accordingly        │                                               └───────────────────┘
  └─────────────────────────┘
```

**Cache breakpoints.** You don't cache "the whole conversation" implicitly — you mark an explicit breakpoint in the request (Anthropic's API uses a `cache_control` block on a message) saying "everything up to here is the reusable prefix." Everything after the breakpoint is processed fresh every time. This is a manual decision, not automatic: put the breakpoint too early and you cache almost nothing useful; put it after content that actually changes between calls and you get cache misses that cost *more* than not caching at all (see below).

**Write cost vs. read cost — the tradeoff that makes this a design decision, not a free win.** The first call that populates the cache (a "cache write") typically costs *more* per token than an uncached call — you're paying to have the provider store the KV state. Every subsequent call that hits that cache (a "cache read") costs dramatically less — often a small fraction of the normal input-token price. This means prompt caching only pays off when the same prefix gets reused enough times before it expires to make the extra write cost worth it. A prefix used exactly once is pure loss; a system prompt reused across hundreds of requests per session is a clear win.

```
  Pseudocode — deciding whether a prefix is worth caching

  function shouldCachePrefix(prefix, expectedReuseCount, ttlSeconds):
    writeCostMultiplier = 1.25          // illustrative: writes cost more than normal input
    readCostMultiplier = 0.1            // illustrative: reads cost far less than normal input
    breakEvenReuses = 1 / (1 - readCostMultiplier)   // roughly: 2 reuses recoups the write premium
    if expectedReuseCount < breakEvenReuses:
      return false                       // not enough reuse before TTL expiry to pay off the write
    return true
```

**TTL and expiry.** A cache entry doesn't live forever — providers typically default to a short window (on the order of minutes) with an option to extend it (on the order of an hour) at extra cost. Any request that arrives after the TTL expires, even with an identical prefix, is a cache miss and re-pays the write cost. This is the part that turns caching from "set it and forget it" into an operational concern: a bursty workload where requests are seconds apart benefits hugely; a workload where requests trickle in minutes apart may never see a hit.

**In this codebase.** There's nothing to point at — no prompt, no token, no cache, because there's no LLM call anywhere in `merchgrid`. If MerchGrid ever added an LLM-backed feature — a plain-English summary of a scan's findings, or a chat-style "explain this finding" assistant — the system prompt and any shared tool-schema block for that feature is exactly the kind of fixed, repeated prefix prompt caching exists for, and it's the first cost lever you'd reach for once that feature existed. Until then, this is knowledge to hold, not code to review.

### Move 3 — the principle

Caching a repeated prefix is the same principle as every other cache in your stack — HTTP caching, a memoized function, a CDN edge cache — applied at the finest possible grain a model provider will let you address: don't recompute what hasn't changed, and be honest about the break-even math before you assume it's free.

## Primary diagram

```
  Full recap — prompt caching lifecycle (general pattern, not present in this repo)

  ┌─ Call 1 (cache write) ─────────────────────────────────────────┐
  │  [ system prompt | tool schemas ]★breakpoint★[ user turn ]       │
  │  provider processes full prefix, stores KV state, higher cost    │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  same prefix, within TTL
  ┌─ Call 2..N (cache read) ──▼─────────────────────────────────────┐
  │  [ system prompt | tool schemas ]★breakpoint★[ different turn ]   │
  │  provider skips reprocessing prefix, far lower cost per call      │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  TTL expires OR any byte of prefix changes
  ┌─ Call N+1 (cache miss) ───▼─────────────────────────────────────┐
  │  full prefix reprocessed again, cache re-written                 │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The underlying mechanism (KV-cache reuse) comes straight from how transformer attention works — attention over a prefix is expensive and deterministic given identical input, so it's a natural target for memoization once providers exposed it as a billable, controllable feature rather than an internal implementation detail. Anthropic shipped this as "prompt caching" with explicit `cache_control` breakpoints; OpenAI's version is largely automatic for long, reused prefixes above a minimum token count. Either way, the mental model is identical: reuse a prefix's computed state, pay a write premium once, collect a read discount many times, respect the TTL. This connects directly to `02-llm-cost-optimization.md` — caching is one lever in a broader cost toolkit, not a separate discipline — and to `04-rate-limiting-backpressure.md`, where the same "reuse work instead of redoing it" instinct shows up in this repo's actual code, just applied to a paginated Shopify read instead of a model prompt.

## Project exercises

### Exercise: add an optional LLM finding-summary feature with prompt caching from day one

- **Exercise ID:** EX-1
- **What to build:** A feature-flagged addition (explicitly opt-in, not touching the deterministic check pipeline) that sends a scan's findings to an LLM to produce a one-paragraph, plain-English summary for the merchant. Structure the prompt with a fixed system prompt plus a fixed tool/output-schema block as the cacheable prefix, and the scan's specific findings as the variable suffix after the cache breakpoint.
- **Why it earns its place:** this repo has zero LLM surface area today, so the honest way to teach prompt caching against real code is to build the smallest possible LLM feature correctly — cache boundary included from the start — rather than retrofitting caching onto something that doesn't exist.
- **Files to touch:** a new `app/app/services/llm/` module (new), a new opt-in route or a section of `app/app/routes/app.scans.$id.tsx`, `app/app/config.ts` (feature flag), `app/prisma/schema.prisma` (if summaries are persisted).
- **Done when:** two calls for the same scan's summary within the cache TTL show a measurably lower cost/latency on the second call than the first (verified via the provider's usage response fields, not just "it feels faster").
- **Estimated effort:** L (half a day) — most of the effort is the new LLM integration itself, not the caching mechanics layered onto it.

### Exercise: write a break-even calculator for a hypothetical cached prefix

- **Exercise ID:** EX-2
- **What to build:** A small, standalone utility (pure function, easily unit-tested) that takes a prefix's token count, write/read cost multipliers, and expected call volume within a TTL window, and returns whether caching that prefix is worth it — the `shouldCachePrefix` pseudocode above, made real and tested against a few concrete scenarios (bursty vs. sparse traffic).
- **Why it earns its place:** understanding that caching isn't automatically free — it has a break-even point — is the part of this pattern people skip past in interviews; building the calculator forces you to reason about the actual numbers instead of reciting "caching saves money."
- **Files to touch:** a new file, e.g. `app/app/services/llm/cache-economics.ts` (new, no dependency on any real LLM call — this is a pure-math exercise that can live standalone even with no LLM feature built yet).
- **Done when:** the calculator correctly flips its recommendation between a "cache it" scenario (high reuse, short gaps between calls) and a "don't bother" scenario (single-use prefix, or gaps longer than the TTL), proven with unit tests for both.
- **Estimated effort:** S (30-45 min).

## Interview defense

**Q: How does prompt caching actually reduce cost, mechanically?**
It skips recomputing the transformer's attention state for a prefix of tokens that's identical to a previous call, within a TTL window. The first call pays a write premium to store that state; every subsequent call with the exact same prefix pays a much lower read cost instead of the full input-token price for that portion of the prompt.
```
  call 1: [shared prefix — WRITE, costly] [unique suffix]
  call 2: [shared prefix — READ, cheap]   [different unique suffix]
```
One-line anchor: *you're not caching answers, you're caching the model's work on a repeated prefix.*

**Q: Why doesn't caching help if you change one word at the start of your system prompt?**
Because the cache key is the prefix's exact byte sequence up to the breakpoint — there's no fuzzy or semantic matching. Changing anything before the breakpoint, even a single character (a timestamp embedded in the system prompt is a classic accidental cause), produces a different prefix, which is a cache miss, which pays the full write cost again.
```
  prefix v1: "...as of March 2024..." → cached
  prefix v2: "...as of April 2024..." → completely different cache key, MISS
```
One-line anchor: *exact-match only — put anything that changes per-call after the breakpoint, never before it.*

**Q: This repo has no LLM calls — what would you actually say about prompt caching if asked in an interview about this codebase?**
Name it honestly: MerchGrid is deliberately deterministic and rule-based (product spec §2.1, §27) — ten hand-written checks, zero model inference, so there's no prompt to cache. What I'd point to instead is that the repo already practices the underlying instinct prompt caching serves — don't redo expensive work you've already done — just applied somewhere else: `catalog-reader.server.ts`'s retry logic and its `variantLimit` backpressure (see `04-rate-limiting-backpressure.md`) are both about bounding and not wasting costly work against an external API, even though that API is Shopify's, not an LLM provider's.

## See also

- `02-llm-cost-optimization.md` — caching is one lever in the broader cost-optimization toolkit covered there.
- `03-prompt-injection.md` — a different LLM-production concern, also not yet exercised in this repo.
- `04-rate-limiting-backpressure.md` — the real, working "don't redo costly work" mechanism that exists in this repo today, applied to Shopify's API rather than an LLM provider.
- `app/app/services/shopify/catalog-reader.server.ts` — the closest real analog for "protect against a costly external call" in this codebase.
