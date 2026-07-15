# Token budgeting and context window management

Subtitle: **context window management / token budgeting** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where token budgeting would live

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  no context window — checks read a normalized array in       │
│  memory, no size limit tied to a model's token budget         │
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — a changeset prompt has to fit a model's   │
│  context window; a merchant's catalog can be thousands of     │
│  variants, the prompt cannot                                  │
└─────────────────────────────────────────────────────────────┘
```

Token budgeting is the discipline of knowing exactly how many tokens your system prompt, your retrieved/injected context, your conversation history, and your expected response consume — and keeping the sum comfortably under the model's context window, because a chain that works fine on small inputs starts truncating or timing out at scale the moment nobody counted. I've watched a RAG pipeline pass every eval for months on hand-picked test documents and then silently drop the last third of a real customer's document at 2am, because nobody had checked what happens when the retrieved context plus the conversation history plus the system prompt crosses 80% of the window. The 80% rule exists because you're never exactly one token from the limit in practice — you're one model change, one longer user message, or one slightly bigger retrieval away from it, and "comfortably under" is the only safe margin.

## Structure pass

**Axis: is there a hard size limit anywhere in this pipeline, and who enforces it?** Trace it across a token-budgeted LLM system and this codebase.

```
axis: what enforces the size limit on the "prompt" (or its cousin)

Bulk AI (planned):      model's context window (~100K-1M tokens
                         depending on model) — hard, enforced by
                         the provider; you must engineer to it

Catalog Audit (today):  ShopSettings.catalogVariantLimit (default
                         5000) — a DIFFERENT kind of limit: a
                         guardrail on how much catalog data the
                         reader will pull per scan, not a token
                         budget, because nothing here is tokenized
```

**Seam:** this codebase's actual size guardrail — `catalogVariantLimit` in `ShopSettings` (`.aipe/project/context.md`'s data-model section; enforced in `app/app/services/scan/catalog-reader.server.ts`) — caps how many variants a single scan reads, for pagination and runtime cost reasons. It is a real, load-bearing limit, but it isn't a token budget: nothing downstream of it is fed to a model, so there's no context window to overflow, and no lost-in-the-middle effect to worry about, because `runChecks` reads the full in-memory array uniformly rather than attending unevenly to different positions in a long prompt.

## How it works

### Move 1 — the mental model

Not yet implemented in this codebase — there is no LLM call and therefore no context window to budget against. The closest mental model, when Bulk AI needs this: think of a context window the way you'd think of a fixed-size buffer in any other system — the moment total size exceeds capacity, something gets silently dropped or the call fails, and the failure mode is worse the further you are from noticing it, because "worked in the demo" and "worked at 80% of the window" look identical until the input grows.

```
Token budget — the allocation, once Bulk AI needs one

┌─ system prompt ──────┐  fixed, small, cacheable prefix
├─ retrieved context ───┤  variable — THIS is what has to be
│                        │  bounded (don't stuff the whole catalog;
│                        │  retrieve the relevant finding + variant)
├─ conversation history ┤  variable — sliding window or summarized
├─ response reserve ─────┤  fixed, reserved before the call, not after
└────────────────────────┘  sum must stay well under the window
```

### Move 2 — not yet implemented in this codebase

There is nothing to walk here honestly — no prompt, no tokenizer, no context window. What *does* exist, and is worth naming precisely so it isn't confused with token budgeting: `ShopSettings.catalogVariantLimit` bounds how much catalog data a scan reads at all (a runtime/memory/pagination guardrail), and `app/app/services/scan/catalog-reader.server.ts`'s paginated GraphQL reads are about Shopify API rate limits, not context windows. Neither is the concept this file names. When Bulk AI adds a real prompt, the discipline that will matter is: don't hand the model the merchant's entire catalog snapshot as context — retrieve just the specific finding and the specific variant the merchant is asking about, which is retrieval as context compression, not a bigger context window.

### Move 3 — the principle

A context window is a budget, not a target — the failure isn't spending too few tokens, it's assuming the budget is bigger than it actually is once real inputs replace test inputs. The same discipline (know your hard limits, build in margin, don't assume today's input size is tomorrow's) applies to any fixed-capacity resource, token budgets included.

## Primary diagram

```
Where a size limit exists in each system

  Bulk AI (planned, has a real token budget)
  ┌─────────────────────────────────────────┐
  │ system + context + history + response     │
  │ must sum to < window, with margin          │
  └─────────────────────────────────────────┘

  Catalog Audit (today, different kind of limit)
  ┌─────────────────────────────────────────┐
  │ catalogVariantLimit bounds READ SIZE,      │
  │ not a prompt — no tokenizer involved        │
  └─────────────────────────────────────────┘
```

## Elaborate

Prefix caching (providers caching the static prefix of a prompt across calls to cut latency and cost) is the specific reason prompt structure matters even before you're near the context limit: put what's stable — the system prompt, fixed instructions — at the front, and what varies per call at the end, so the cacheable portion is maximized. This has no analog in MerchGrid today because nothing here is a "call" to anything external in the LLM sense — the closest cousin, Shopify's GraphQL rate limiting, is a different resource entirely (request cost budget, not token budget), governed by `catalog-reader.server.ts`'s retry logic rather than anything prompt-shaped.

## Project exercises

### Exercise: token budget for the changeset-proposer prompt

- **What to build:** before Bulk AI's first prompt ships, write down the budget: system prompt tokens (fixed), the finding + variant context tokens (bounded — one finding, not the catalog), response reserve, and confirm the sum stays under 80% of the target model's window even for the longest realistic product title/explanation combination.
- **Why it earns its place:** this is the cheapest possible bug to prevent and the most expensive to debug in production once real merchant data (long product titles, many variants) replaces test fixtures.
- **Files to touch:** new — a budget check co-located with wherever the prompt is assembled.
- **Done when:** there's a test asserting token count stays under budget for a worst-case fixture (longest title, most evidence fields), not just the happy-path fixture.
- **Estimated effort:** a few hours — the discipline is cheap; only enforcing it is easy to skip.

## Interview defense

**Q: Why the 80% rule instead of just staying under the hard limit?**
A: Because you're never testing the actual worst case in development — real user input, a slightly longer document, or a model swap can all push you past a limit you thought you had margin on. 80% is the buffer that survives those surprises; 99% is a buffer that survives nothing.

```
the answer, sketched
┌─ 0% ──────────────── 80% ──── 100% (hard limit) ─┐
│         safe zone     │  danger zone — one model  │
│                        │  swap or longer input away │
└────────────────────────┴────────────────────────┘
```

**Q: What's the honest answer about this codebase?**
A: There's no context window here — no LLM call exists. `catalogVariantLimit` looks like a budget but bounds something else entirely (how much catalog data a scan reads), and naming that distinction correctly is more useful in an interview than pretending a read-size guardrail is a token budget.

## See also

- `04-token-budgeting.md` pairs with `05-eval-driven-iteration.md` once Bulk AI exists — a worst-case-length fixture belongs in both the token budget and the golden eval
