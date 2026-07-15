# Query rewriting and HyDE

Industry standard — using an LLM to transform a raw user query before retrieval (rewriting, expansion, or HyDE — Hypothetical Document Embeddings) to close the vocabulary gap between how people ask and how documents are written.

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*  → raw `search` string, unmodified       │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  scan-api.server.ts: `search.trim().toLowerCase()` — the    │
  │  only transform applied, and it's normalization, not         │
  │  rewriting                                                    │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Finding.searchText                         │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no LLM call rewrites, expands, or hypothesizes      │ │
  │   │  ★ anything about the query before it hits the DB ★     │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

A raw user query is often a bad retrieval query — too short, ambiguous, phrased as a question when the corpus is written as statements, or missing terms the corpus actually uses. Query rewriting inserts an LLM call *before* retrieval to transform the query into something more likely to match — expanding it with synonyms, rephrasing a question as a statement, or (HyDE's specific trick) generating a fake, plausible-looking answer document and embedding *that* instead of the original query. This app's search box passes the raw string straight through a `.trim().toLowerCase()` normalization and into a SQL `contains` filter — no LLM sits between the user's keystrokes and the database query.

## Structure pass

**Layers.** Query rewriting is a preprocessing stage inserted *before* retrieval, at the same altitude as "parse and validate input" in a normal web request — except instead of a deterministic validator, the transform is an LLM call. The axis worth tracing is **who decides what the query becomes: the user, or the model?**

**Axis: control over the query.** Without rewriting, the user's literal input is the query — control stays entirely with the human. With rewriting, an LLM sits in between and decides what actually gets searched — control shifts to the model, which means the model's mistakes (hallucinated expansion terms, a misread of intent) now directly shape what gets retrieved, silently, before the user ever sees a result.

**Seam.** The seam is the point where a deterministic, auditable string ("what the user typed") becomes a model-generated string ("what the model decided to search for instead"). Everything before that seam is inspectable and reproducible; everything after it depends on a non-deterministic model call, which is exactly the kind of seam that needs logging/observability wrapped around it in a production system — if a search behaves strangely, "what did the rewrite step actually produce" becomes the first debugging question.

## How it works

**Move 1 — the mental model.** You've built a form with a "did you mean" suggestion or a search box that expands "TV" to also match "television." That's the shape of query rewriting, generalized: instead of a hardcoded synonym table, an LLM generates the expansion (or rewrite, or hypothetical answer) fresh, per query, using its general language understanding instead of a fixed list you maintain.

```
  Pattern — a transform stage inserted before retrieval

  user query ──► [LLM rewrite / expand / HyDE] ──► transformed query ──► retrieval
       │                                                    │
       └── deterministic, auditable ──────────┐   ┌── model-generated,
                                                 ▼   ▼   non-deterministic
                                          the seam that changes control
```

**Move 2 — the mechanism, step by step, across the three variants.**

**Variant 1: query rewriting/reformulation.** The LLM rephrases the raw query into a cleaner retrieval query — expanding abbreviations, resolving ambiguous pronouns using conversation history, or converting a question into a declarative statement closer to how the corpus is written.

```
  Pseudocode — basic query rewriting

  function rewriteQuery(rawQuery, conversationHistory, llm):
    prompt = buildPrompt(
      instruction: "Rewrite this into a standalone search query,
                    resolving any pronouns using the conversation history.",
      rawQuery,
      conversationHistory
    )
    rewritten = llm.complete(prompt)
    return rewritten
```

**Variant 2: query expansion.** Rather than replacing the query, the LLM generates several related phrasings, and retrieval runs *all* of them (typically fused with RRF, `06-hybrid-retrieval-rrf.md`) to widen the net — catching documents that use different vocabulary for the same underlying question.

**Variant 3: HyDE (Hypothetical Document Embeddings).** The clever, counterintuitive one. Instead of embedding the user's query directly, ask the LLM to write a *fake, plausible-sounding answer* to the query — then embed that fake answer and use it to search, instead of embedding the query itself.

```
  Pseudocode — HyDE

  function hydeRetrieve(userQuery, llm, embeddingModel, vectorIndex):
    hypotheticalDoc = llm.complete(
      prompt = "Write a short passage that would answer: " + userQuery
    )
    // note: we never check if this hypothetical answer is TRUE —
    // it doesn't need to be factually correct, only stylistically
    // similar to what a real answer document would look like
    queryVector = embeddingModel.embed(hypotheticalDoc)
    return vectorIndex.search(queryVector, k = 10)
```

**Why HyDE works — the load-bearing insight.** A question ("what's your return policy for damaged items?") and its answer ("items damaged in transit may be returned within 30 days...") are often embedded *far apart* by a bi-encoder, because questions and answers are written in structurally different registers even when they're about the same topic. A fake-but-plausible *answer*, generated by the LLM, sits much closer in embedding space to the *real* answer document than the original question ever would — because both are written in "answer" register. HyDE trades "is this hypothetical document true" (irrelevant) for "does this hypothetical document look like the real thing" (exactly what retrieval needs).

```
  Execution trace — why HyDE's embedding lands closer

  query:              "what's your return policy for damaged items?"
  real answer doc:     "items damaged in transit may be returned within 30 days,
                         no restocking fee, refund issued in 5-7 business days"
  HyDE hypothetical:    "our policy allows returns for damaged goods within a
                         reasonable window, typically with a full refund"

  embed(query)          vs embed(real answer)   → distant (question vs answer register)
  embed(HyDE hypothetical) vs embed(real answer) → close (both "answer" register)
```

**In this codebase: not yet implemented.** The only transform applied to a search string is `.trim().toLowerCase()` (`app/app/services/scan/scan-api.server.ts:254`) — deterministic string normalization, not an LLM-driven rewrite. There's no LLM anywhere in this app's request path (this whole product is deliberately rule-based, per the product spec's §2.1 "Deterministic" principle), so there's nowhere for a rewriting step to plug in even if the search need called for it.

**Move 3 — the principle.** Query rewriting (including HyDE) trades a deterministic, cheap, instant transform for a model-generated one that can close real vocabulary and register gaps between how people ask questions and how documents are written — at the cost of adding latency, an LLM call's non-determinism, and a new failure surface (a bad rewrite silently produces bad retrieval, with no error thrown). It only earns its place when that vocabulary/register gap is actually the retrieval bottleneck — for exact-match lookups (SKUs, order numbers) it adds cost with nothing to fix.

## Primary diagram

```
  Full picture — query rewriting / HyDE in a retrieval pipeline (general pattern, absent here)

  ┌─ user query ───┐
  │ "return policy   │
  │  for broken stuff"│
  └────────┬──────────┘
           │
           ▼
  ┌─ LLM rewrite/HyDE stage ──────────────────┐
  │ rewrite → cleaner query, OR                │
  │ HyDE → fake plausible answer document       │
  └────────────────────┬───────────────────────┘
                        │ transformed query/document
                        ▼
  ┌─ embed + retrieve (01-embeddings.md,          ┐
  │  04-vector-databases.md)                       │
  └────────────────────┬───────────────────────────┘
                        ▼
  ┌─ candidates → reranking (07) → RAG (11) ──────┐
  └──────────────────────────────────────────────────┘
```

## Elaborate

HyDE comes from a 2022 paper ("Precise Zero-Shot Dense Retrieval without Relevance Labels") and is specifically a *zero-shot* trick — it needs no labeled query-document pairs to work, which is why it's attractive for cold-start retrieval systems with no relevance-judgment training data. The cost side is real: every query now costs an extra LLM generation call before retrieval even starts, which is meaningful added latency (typically hundreds of milliseconds to a few seconds) and cost per search — acceptable for a conversational assistant answering a handful of queries per session, much harder to justify for a high-QPS search box. Query rewriting more broadly is also how multi-turn conversational retrieval handles context — "what about the second one?" is meaningless to a retrieval system without a rewrite step that resolves "the second one" using conversation history first.

## Project exercises

### EX-1 — write a query-expansion prototype and see it change the sparse search's hit rate

- **Exercise ID:** EX-1
- **What to build:** A standalone script that takes a hand-picked set of realistic merchant search phrases (e.g. "cheap markup," "too pricey," "out of stock issue") and, for each, calls an LLM to generate 2-3 alternate phrasings, then runs every phrasing (original + alternates) through the real sparse `searchText.contains()` logic against one scan's findings, comparing the union of hits against what the original phrase alone would have returned.
- **Why it earns its place:** This app's real sparse search is exact-substring, so it's a clean, honest testbed for showing exactly what query expansion buys (and doesn't) — you'll likely see cases where the expanded phrasing surfaces a finding the literal search missed, and cases where the expansion adds noise. Both outcomes are the lesson.
- **Files to touch:** new file, e.g. `app/scripts/query-expansion-prototype.ts` (standalone; calls an LLM API, reads `Finding` rows via Prisma, never wired into the app).
- **Done when:** you have at least one concrete phrase where expansion surfaced a result the literal search missed, and you can state the tradeoff (extra LLM call latency/cost vs the hit-rate improvement) in one sentence.
- **Estimated effort:** 1-2 hours (needs an LLM API call, unlike most other exercises in this sub-section).

## Interview defense

**Q: Why would you embed a fake, made-up answer (HyDE) instead of just embedding the user's actual question?**
Because questions and answers are written in different linguistic registers, and bi-encoder embeddings are sensitive to that register gap — a question can land far from its own correct answer in vector space. A hypothetical answer, even if factually wrong, is written in "answer" register and lands much closer to the real answer document than the literal question would. HyDE deliberately doesn't care whether the hypothetical is true — only whether it's stylistically representative of what a real answer looks like.

**Q: What's the biggest risk of adding an LLM rewrite step in front of retrieval?**
It's a new, silent failure surface. A bad rewrite doesn't throw an error — it just quietly retrieves the wrong things, and because the transform happens before the user sees anything, the failure is invisible unless you specifically log and monitor what the rewrite step produced versus what the user typed.

**Q: Does this app need query rewriting or HyDE?**
No. Both exist to close a vocabulary/register gap between how a query is phrased and how a corpus is written — a gap that matters for semantic/dense retrieval over free text. This app's search is exact-substring matching against structured fields (SKU, title, barcode) where the user already knows roughly what string they're looking for; there's no register gap to close, and it has no LLM in its request path to begin with (deliberately, per the product's rule-based design).

## See also

- `01-embeddings.md` — what HyDE ultimately embeds
- `05-dense-vs-sparse.md` — the register gap this concept is specifically fixing on the dense side
- `11-rag.md` — where query rewriting most commonly shows up as a pre-retrieval stage
