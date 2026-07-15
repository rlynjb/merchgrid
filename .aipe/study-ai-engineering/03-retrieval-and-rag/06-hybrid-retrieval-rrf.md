# Hybrid retrieval and reciprocal rank fusion

Industry standard — combining sparse and dense retrieval result sets into one ranking, most commonly via Reciprocal Rank Fusion (RRF).

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*  — one search path (sparse only)   │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Finding.searchText — sparse only          │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no fusion step — there's only ever one ranked list ★│ │
  │   │  ★ (sparse), so there's nothing to fuse it with ★       │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

Once a system has both a sparse retrieval path and a dense retrieval path (`05-dense-vs-sparse.md`), it has two independently-ranked candidate lists for the same query — and neither list alone is reliably better than the other across every query type. Hybrid retrieval fuses both lists into a single ranking, and Reciprocal Rank Fusion is the standard, almost embarrassingly simple algorithm for doing it. This app has exactly one retrieval path — sparse, via `Finding.searchText` — so there's nothing to fuse.

## Structure pass

**Layers.** Fusion sits one layer above retrieval — it doesn't retrieve anything itself, it combines the *outputs* of two retrieval systems that already ran independently. The axis worth tracing is **information used at fusion time**: does the fusion algorithm need the raw similarity scores, or just each result's rank position?

**Seam.** The seam RRF is specifically designed to sidestep is score-scale incompatibility. A sparse score (BM25, or a raw `contains` boolean) and a dense score (cosine similarity, 0 to 1) live on completely different scales and distributions — you cannot average a BM25 score of 14.2 with a cosine similarity of 0.83 and get anything meaningful. RRF's whole trick is refusing to touch the raw scores at all and working with *rank position* instead, which is comparable across any two systems by construction.

## How it works

**Move 1 — the mental model.** Think of two friends each independently ranking their top 10 favorite restaurants in a city, using totally different criteria (one ranks by price, one by cuisine). You want one combined list. Averaging their price-scale and cuisine-scale numbers is meaningless — but you *can* combine "restaurant X was #2 on list A and #5 on list B" into one fused score, because rank position means the same thing on both lists: how close to the top.

```
  Pattern — two ranked lists, fused by rank position

  sparse results:        dense results:
  1. Finding A            1. Finding C
  2. Finding B            2. Finding A
  3. Finding D            3. Finding B

              both rankings feed into one fusion formula
                            ▼
  fused:  Finding A (top in sparse, #2 in dense) → highest fused score
          Finding B, Finding C, Finding D — ranked by combined rank position
```

**Move 2 — the mechanism, step by step.**

**Step 1: run both retrieval paths independently.** Sparse retrieval returns its top-N candidates ranked by BM25 (or whatever lexical score); dense retrieval returns its top-N candidates ranked by cosine similarity. These run in parallel — neither needs to know the other exists.

**Step 2: compute the RRF score for every candidate that appears in either list.** For each document `d`, RRF sums `1 / (k + rank)` across every list it appears in, where `rank` is its position in that list (1-indexed) and `k` is a small constant (commonly 60) that dampens the impact of very high ranks so the formula doesn't over-reward being #1 versus #2.

```
  Pseudocode — Reciprocal Rank Fusion

  function reciprocalRankFusion(sparseRanked, denseRanked, k = 60):
    scores = emptyMap()   // document id -> fused score

    for rank, doc in enumerate(sparseRanked, startAt = 1):
      scores[doc.id] += 1 / (k + rank)

    for rank, doc in enumerate(denseRanked, startAt = 1):
      scores[doc.id] += 1 / (k + rank)
      // a doc appearing in BOTH lists accumulates score from both terms —
      // that's the whole fusion mechanism, no weighting needed

    return sortByDescending(scores)   // final fused ranking
```

**Execution trace — a concrete example, k = 60:**

```
  sparse rank of Finding A = 1  →  1/(60+1) = 0.0164
  dense  rank of Finding A = 2  →  1/(60+2) = 0.0161
  Finding A fused score = 0.0164 + 0.0161 = 0.0325   ← appears in both, wins

  sparse rank of Finding B = 2  →  1/(60+2) = 0.0161
  dense rank: Finding B absent →  0
  Finding B fused score = 0.0161                       ← only in one list

  Finding A ranks above Finding B in the fused output — it showed up near
  the top of both lists, which RRF rewards more than being #1 in only one.
```

**Step 3: return the top-k of the fused ranking.** The fused list is what actually gets shown to the user or handed to a reranker (`07-reranking.md`) — neither the raw sparse list nor the raw dense list is served directly once fusion is in the pipeline.

```
  Layers-and-hops — hybrid retrieval pipeline (general pattern)

  ┌─ query ──────┐
  │ user's search │
  └──────┬────────┘
         │ fan-out, parallel
    ┌────┴─────┐
    ▼          ▼
  ┌─ Sparse ──┐ ┌─ Dense ───┐
  │ BM25 /    │ │ embed +    │
  │ contains  │ │ ANN search │
  └────┬──────┘ └─────┬──────┘
       │ ranked list    │ ranked list
       └───────┬────────┘
                ▼
       ┌─ RRF fusion ────┐
       │ 1/(k+rank) sum   │
       └────────┬─────────┘
                 │ one fused ranking
                 ▼
       ┌─ top-k results ──┐
       └───────────────────┘
```

**In this codebase: not yet implemented.** There's exactly one retrieval path in this app — `getScanFindings`'s sparse `searchText.contains()` filter (`app/app/services/scan/scan-api.server.ts:254-262`) — and no second ranked list to fuse it with. Fusion has nothing to combine when there's only one candidate source.

**Move 3 — the principle.** Fusion algorithms like RRF exist because no single retrieval signal dominates across every query — lexical matching wins on exact terms and rare vocabulary, semantic matching wins on paraphrase and synonym, and the safest bet in production is to run both and let a rank-based (not score-based) combination pick the winner per query, rather than betting the whole system on one signal being universally better.

## Primary diagram

```
  Full picture — hybrid retrieval end to end (general pattern, absent here)

  ┌─ query ──┐   ┌─ sparse path ──┐        ┌─ dense path ───┐
  │           │──►│ BM25 / lexical  │        │ embed + ANN     │◄──┐
  └───────────┘   └────────┬────────┘        └────────┬────────┘   │ same query
                            │ ranked list               │ ranked list
                            └──────────┬─────────────────┘
                                       ▼
                              ┌─ RRF fusion ────┐
                              │ rank-based, no    │
                              │ score-scale issues │
                              └────────┬───────────┘
                                       ▼
                              ┌─ fused top-k ─────┐
                              │ → 07-reranking.md   │
                              │   (optional next     │
                              │    stage)             │
                              └───────────────────────┘
```

## Elaborate

RRF's appeal is that it's parameter-light (one constant, `k`, rarely tuned much past the default of 60) and doesn't need score calibration between systems — the alternative, weighted linear combination of raw scores, requires normalizing two different score distributions onto a comparable scale, which is fiddly and dataset-dependent. Production hybrid systems (Elasticsearch's hybrid queries, Weaviate's built-in hybrid mode, Azure AI Search) default to RRF for exactly this reason. Fusion is a coarse combination step, though — it doesn't understand the *query*, just rank positions, which is why the highest-quality pipelines add a reranking stage after fusion (`07-reranking.md`) that actually reads the query and each candidate together before finalizing the order.

## Project exercises

### EX-1 — implement RRF by hand over the app's sparse results and a prototype dense path

- **Exercise ID:** EX-1
- **What to build:** A standalone script (not wired into the app) that runs the same query through two paths for one scan's findings — the real sparse path (replicating `getScanFindings`'s `searchText.contains()` logic) and the dense prototype from `05-dense-vs-sparse.md`'s exercise — then fuses the two ranked lists with a hand-written RRF function (don't import a library implementation; the formula is five lines).
- **Why it earns its place:** RRF is one of those algorithms that sounds abstract until you've watched it correctly promote a document that was mediocre on both individual lists but consistently present on both, ahead of a document that was #1 on only one list. Implementing it by hand against real fused data (rather than reading the formula) is what makes that behavior click.
- **Files to touch:** new file, e.g. `app/scripts/rrf-fusion.ts` (standalone; reuses the sparse/dense prototypes from earlier exercises).
- **Done when:** you can point at one document in the fused output whose rank differs from its rank in either individual list, and explain why RRF moved it.
- **Estimated effort:** 1 hour, assuming the sparse and dense prototypes from `05-dense-vs-sparse.md`'s exercise already exist.

## Interview defense

**Q: Why does RRF use rank position instead of the raw similarity/relevance scores?**
Because sparse and dense scores live on incompatible scales — a BM25 score and a cosine similarity aren't the same unit of measurement, so averaging them directly is meaningless. Rank position (1st, 2nd, 3rd...) means the same thing regardless of which scoring system produced it, so it's the only safe currency to combine across two different retrieval systems.

**Q: What's the load-bearing part of the RRF formula that people get wrong?**
The constant `k` in `1/(k+rank)`. Without it (i.e., plain `1/rank`), the #1 result would dominate the fused score so heavily that being #2 in both lists could never beat being #1 in just one — `k=60` dampens that so consistent-but-not-top placement across multiple lists competes fairly against a single top placement.

**Q: Does this app need hybrid retrieval / RRF?**
No — RRF fuses two or more independently-ranked result sets, and this app only ever produces one: the sparse `searchText` filter. There's no second (dense) ranking to fuse it with, so there's nothing for RRF to do here.

## See also

- `05-dense-vs-sparse.md` — the two result sets RRF would combine
- `07-reranking.md` — the stage that typically follows fusion
- `04-vector-databases.md` — where the dense half of a hybrid pipeline would live
