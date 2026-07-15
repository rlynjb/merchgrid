# Reranking

Industry standard — a second-pass scoring model (typically a cross-encoder) that re-orders an initial retrieval candidate set using the full query-document pair, trading throughput for precision.

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*  — returns a single-pass SQL       │
  │  result set, no second scoring stage                         │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: ORDER BY severityRank, checkId — a fixed,  │
  │  deterministic sort, not a learned relevance re-score        │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no reranking model — there's no first-pass          │ │
  │   │  ★ retrieval-and-rank pipeline to re-score              │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

Retrieval (dense, sparse, or fused) is built for speed at scale — it has to score against potentially millions of candidates fast, which means it can't afford to deeply compare the query against every candidate. Reranking is the second pass: take the retrieval stage's top N (often 20-100) candidates and re-score them with a much more expensive, much more accurate model that actually reads the query and each candidate *together*, then keep only the true top k (often 3-10). This app has one deterministic SQL sort (`ORDER BY severityRank, checkId`) — not a relevance re-score, because there's no relevance judgment being made at all.

## Structure pass

**Layers.** Reranking sits strictly downstream of retrieval — it never runs on the whole corpus, only on retrieval's already-narrowed candidate set. The axis worth tracing is **what the scoring model gets to see.**

**Axis: what does the scorer see?** A bi-encoder (used for dense retrieval, `01-embeddings.md`) encodes the query and each document *separately* into vectors, then compares the vectors — it never sees the query and document together. A cross-encoder (used for reranking) takes the query and *one* document concatenated as a single input and outputs a single relevance score directly — it sees full cross-attention between every query token and every document token, which is why it's more accurate but also why it can't run at retrieval scale (it needs one full forward pass per document, no precomputation possible).

**Seam.** The seam is the precompute boundary. Bi-encoder vectors can be computed for the whole corpus ahead of time and just compared at query time — cheap. Cross-encoder scores cannot be precomputed at all, because the score depends on the specific query, which isn't known until request time — expensive, and only affordable on a small candidate set.

## How it works

**Move 1 — the mental model.** Think of retrieval as a resume-screening bot that scans thousands of resumes against a job description using keyword and skills matching — fast, coarse, gets you from 10,000 down to 50. Reranking is the hiring manager who actually reads each of those 50 resumes carefully against the job description — slower per-resume, but far more accurate, and only affordable because there are 50, not 10,000.

```
  Pattern — funnel: cheap-and-wide, then expensive-and-narrow

  corpus (millions)
      │
      ▼ retrieval (bi-encoder / BM25 / hybrid) — fast, precomputed
  candidates (20-100)
      │
      ▼ reranking (cross-encoder) — slow, computed fresh per query
  final results (3-10)
```

**Move 2 — the mechanism, step by step.**

**Step 1: retrieval narrows the field.** Whatever produced the candidate set — sparse, dense, or RRF-fused (`06-hybrid-retrieval-rrf.md`) — hands off its top N to the reranker. This step is unavoidable; a cross-encoder is too slow to run against the whole corpus (no ANN-style shortcut exists for it, because there's no precomputed vector to index — each score requires a live model call).

**Step 2: the cross-encoder scores each (query, candidate) pair independently.** For every candidate in the narrowed set, concatenate the query and the candidate's text into one input, run it through a model trained specifically to output a single relevance score (usually 0-1) for that pair.

```
  Pseudocode — cross-encoder reranking

  function rerank(query, candidates, crossEncoderModel):
    scored = []
    for candidate in candidates:               // one model call per candidate
      input = concatenate(query, candidate.text, separator = "[SEP]")
      relevanceScore = crossEncoderModel.forward(input)   // full cross-attention
      scored.append({ candidate, relevanceScore })

    return sortByDescending(scored, key = relevanceScore).slice(0, finalK)
```

**Execution trace — why order can flip from retrieval to reranking:**

```
  retrieval order (by embedding similarity):
    1. "return policy for damaged items"
    2. "how to check order status"
    3. "warranty claims for defective products"

  query: "my item arrived broken, what do I do"

  cross-encoder re-scores each pair fresh:
    "return policy for damaged items"     → 0.91  (directly relevant)
    "warranty claims for defective products" → 0.88  (also directly relevant)
    "how to check order status"           → 0.12  (embedding similarity was
                                              misleadingly high; cross-encoder
                                              catches that it's off-topic)

  final order: damaged-items policy, warranty claims, order status
  → the reranker demoted #2 to #3 because it actually read both texts
    against the query, instead of comparing precomputed vectors
```

**Step 3: latency and cost budget dictate N and k.** Reranking's cost scales linearly with the candidate count (one full model forward pass per candidate, no batching shortcut that avoids the per-pair compute), so production systems cap N tightly — rerank the top 20-50, never the top 1000 — and this cap is a direct latency/quality tradeoff decision, not a detail to skip.

```
  Layers-and-hops — reranking's position in the pipeline (general pattern)

  ┌─ Retrieval stage ──┐  hop: top-N candidates  ┌─ Reranking stage ──┐
  │ bi-encoder / BM25 / │ ───────────────────────►│ cross-encoder, one   │
  │ RRF fusion           │                          │ forward pass per     │
  │ (fast, precomputed)  │                          │ candidate (slow)     │
  └──────────────────────┘                          └──────────┬───────────┘
                                                                 │ top-k, final
                                                       ┌─────────▼─────────┐
                                                       │ served to user /   │
                                                       │ passed to RAG       │
                                                       │ (11-rag.md)         │
                                                       └────────────────────┘
```

**In this codebase: not yet implemented.** The closest thing to an ordering step is `getScanFindings`'s SQL `orderBy: [{ severityRank: "asc" }, { checkId: "asc" }]` (`app/app/services/scan/scan-api.server.ts:266-267`) — a fixed, deterministic sort by severity then check ID, computed entirely at persist time via a denormalized `severityRank` column (`app/prisma/schema.prisma:94-97`, populated in `app/app/services/scan/severity.ts` so the database can `ORDER BY` instead of sorting in memory). That's a sort, not a rerank: there's no query-dependent relevance judgment happening — every finding of the same severity and checkId sorts the same way regardless of what a user searched for.

**Move 3 — the principle.** Reranking exists because the model that's fast enough to search a whole corpus (bi-encoder) is never the model that's most accurate at judging one specific pair (cross-encoder) — and you can't afford the accurate model at corpus scale or the fast model's precision loss at final-answer time. The two-stage funnel (cheap-wide, then expensive-narrow) is the general pattern any time you have an expensive-but-accurate judgment and a corpus too large to apply it to directly.

## Primary diagram

```
  Full picture — retrieval + reranking funnel (general pattern, absent here)

  ┌─ corpus ──────┐
  │ millions of     │
  │ documents        │
  └───────┬─────────┘
          │ bi-encoder / BM25 / hybrid (precomputed, fast)
          ▼
  ┌─ candidates ──┐
  │ top 20-100      │
  └───────┬─────────┘
          │ cross-encoder, one live forward pass per candidate
          ▼
  ┌─ final top-k ──┐
  │ highest-precision│
  │ ranking           │
  └────────┬──────────┘
           │
           ▼
  ┌─ served to user or fed to RAG generation (11-rag.md) ────┐
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Cohere's Rerank API and open cross-encoder models (`ms-marco-MiniLM`, `bge-reranker`) are the common off-the-shelf choices — nobody trains a cross-encoder from scratch for a typical application. Reranking is the single highest-leverage addition to a mediocre retrieval pipeline because it fixes the specific failure mode bi-encoders are prone to: high embedding similarity that doesn't actually reflect relevance (two texts can be topically similar while answering different questions). The cost is real and non-negotiable, though — it's a live model call per candidate, so it adds both latency and per-query compute cost that scales with N, which is why production systems keep N small and treat the rerank stage as a precision polish on an already-decent candidate set, never a substitute for good retrieval.

## Project exercises

### EX-1 — compare a fixed SQL sort against a hypothetical relevance rerank, on real findings

- **Exercise ID:** EX-1
- **What to build:** A standalone script that pulls one scan's findings via the same query shape as `getScanFindings`, then for a sample "user intent" (e.g. "show me pricing problems first, then everything else") writes a tiny hand-scored reranking function that reads each finding's `checkId` and `explanation` and assigns a relevance score against that stated intent — then compares the result order against the app's real `severityRank`/`checkId` SQL sort.
- **Why it earns its place:** This makes concrete the exact distinction the concept teaches: a fixed sort (what this app does) versus a query-dependent relevance judgment (what reranking does). You don't need a real cross-encoder model to see the difference — hand-scoring against a stated intent is enough to show that the app's current sort order is intent-blind by design.
- **Files to touch:** new file, e.g. `app/scripts/hypothetical-rerank.ts` (standalone; reads via Prisma, doesn't touch app code).
- **Done when:** you can show one scan where the app's real severity sort and your intent-based rerank disagree on the top result, and explain why.
- **Estimated effort:** 45-60 minutes.

## Interview defense

**Q: Why can't you just use a cross-encoder for the whole retrieval step instead of a two-stage pipeline?**
A cross-encoder needs a full forward pass per (query, document) pair — there's no way to precompute anything ahead of time because the score depends on the specific query. Run that against a corpus of a million documents and you're doing a million model calls per search. Bi-encoder retrieval precomputes document vectors once and only embeds the query at search time, which is why it can scale to the whole corpus while the cross-encoder can only afford to look at the narrowed-down top N.

**Q: What's the load-bearing tradeoff a reranker buys you, and what does it cost?**
It buys precision on the final result set by letting the model see the query and document together (full cross-attention) instead of comparing separately-computed vectors. It costs latency and compute that scale linearly with how many candidates you rerank — which is why N (candidates going in) and k (results coming out) are both deliberately kept small in production.

**Q: Does this app need reranking?**
No — reranking re-scores a retrieval candidate set by relevance to a specific query, and this app's ordering (`severityRank`, `checkId`) is a fixed, query-independent sort computed once at persist time. There's no relevance judgment being made, so there's nothing for a reranker to improve.

## See also

- `06-hybrid-retrieval-rrf.md` — the stage that typically feeds into reranking
- `01-embeddings.md` — the bi-encoder side of the bi-encoder/cross-encoder contrast
- `11-rag.md` — where reranked results typically get consumed next
