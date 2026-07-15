# Embedding model choice

Industry standard — model selection tradeoffs for the encoder that produces your vectors (dimension count, distance metric, cost, latency, domain fit).

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*                                    │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Shop, ShopSettings, Scan, Finding,        │
  │  ScanArtifact                                                │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no embedding model is chosen or configured — there ★│ │
  │   │  ★ is no embedding call for a model choice to apply to★│ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

Once you've accepted you need embeddings (`01-embeddings.md`), the next decision is *which model produces them* — and that choice ripples through cost, latency, storage size, and retrieval quality for the life of the system. This app never reaches this decision because it never reaches the first one.

## Structure pass

**Layers.** Model choice sits one level below "do I need embeddings at all" and one level above "where do I store them." It's a leaf decision, but a sticky one — the axis worth tracing here is **lifecycle**: when does this decision get locked in, and what does changing it cost later?

**Axis: lifecycle.** Pick the model once, embed your whole corpus with it, and every vector you've stored is now tied to that model's geometry. Query time uses the *same* model to embed the incoming query — a different model produces vectors that aren't comparable at all (different dimension count, different geometry, no shared coordinate system). Switching models later means re-embedding everything, not a config flag.

**Seam.** The seam is between "the corpus" and "the index" — once vectors are written with model A, that seam is now typed to model A. Swapping to model B isn't a hot-swap; it's a full backfill (this is exactly `10-incremental-indexing.md`'s territory when a corpus is live and growing).

## How it works

**Move 1 — the mental model.** Picking an embedding model is like picking a database's collation/sort order — you can change it, but every derived index has to be rebuilt from scratch once you do, because "close" meant something different under the old rule.

```
  Pattern — the decision surface

  ┌─ dimension ──┐  ┌─ cost/latency ─┐  ┌─ domain fit ───┐  ┌─ hosting ──────┐
  │ 384 / 768 /   │  │ $/1M tokens,   │  │ general text vs│  │ API call vs    │
  │ 1536 / 3072   │  │ ms per batch   │  │ code / legal /  │  │ self-hosted    │
  │ smaller =      │  │                │  │ multilingual    │  │ model          │
  │ cheaper index  │  │                │  │                 │  │                │
  └───────────────┘  └────────────────┘  └────────────────┘  └────────────────┘
           all four tradeoffs get locked in the moment you embed the first row
```

**Move 2 — the decision factors, step by step.**

**Factor 1: dimension count.** Higher dimension usually means better semantic resolution, but every dimension is a float stored per vector, multiplied across your whole corpus. 1536 dimensions × 4 bytes × 1M rows = ~6GB just for vectors, before any index overhead. Smaller models (384-dim) trade a few points of retrieval accuracy for an order of magnitude less storage and faster ANN search.

**Factor 2: distance metric compatibility.** Not every model is trained for cosine similarity — some are optimized for dot product on un-normalized vectors, some for Euclidean. Using the wrong metric against a model's native training objective silently degrades results without throwing an error, which makes this a classic "looks fine in a demo, wrong in production" bug.

**Factor 3: domain fit.** A general-purpose model (trained on broad web text) is a reasonable default, but a domain-specific model (code embeddings for source search, legal-tuned embeddings for contract search) systematically outperforms general models inside their domain — because the contrastive training pairs it saw during fine-tuning looked like the queries you'll actually run.

**Factor 4: cost and latency, hosted vs self-hosted.** A hosted API (OpenAI, Cohere, Voyage) means no infra to run but per-token cost and a network hop on every embed call. A self-hosted open model (BGE, E5, GTE) means you own the GPU/CPU cost and the ops burden, but no per-call billing and no data leaving your infrastructure — often the deciding factor for anything with customer PII.

```
  Pseudocode — the choice, as a decision function

  function chooseEmbeddingModel(corpus, constraints):
    if constraints.dataMustStayOnPrem:
      candidates = selfHostedModels()   // BGE, E5, GTE, etc.
    else:
      candidates = hostedApiModels()    // OpenAI, Cohere, Voyage, etc.

    candidates = filter(candidates, domainMatches(corpus.domain))
    candidates = rank(candidates, by = [retrievalBenchmarkScore, costPerMillionTokens])

    return candidates[0]
    // this choice is now locked: query-time embedding MUST use the same model
```

**In this codebase: not yet implemented.** There's no embedding call, so there's no model to choose. If a future feature ever needed one — say, retrieving similar past `Finding` rows for a merchant-facing explanation feature — the choice would hinge on the same four factors above, with domain fit mattering most: catalog/merchandising language (SKUs, margin, variant titles) is narrow enough that a general-purpose model would likely work fine without fine-tuning, given the corpus size implied by per-shop scan history is small. This is speculative — not planned, not in the product spec.

**Move 3 — the principle.** Model choice is a load-bearing, hard-to-reverse decision precisely because it defines the coordinate system every stored vector lives in. Treat it like a schema migration, not a config value: changing it later means re-embedding the whole corpus, not swapping an environment variable.

## Primary diagram

```
  Full picture — the decision and its lock-in

  ┌─ decision (once) ────────────┐
  │ dimension · metric · domain  │
  │ fit · hosting                │
  └──────────────┬────────────────┘
                 │ locks in
  ┌──────────────▼────────────────┐        ┌─ query time ──────────┐
  │ every vector in the index      │◄──────►│ MUST use same model    │
  │ (same coordinate system)       │  same  │ to embed the query     │
  └────────────────────────────────┘  model └────────────────────────┘
                 │
                 │ change model later =
                 ▼
  ┌────────────────────────────────┐
  │ full re-embed of entire corpus │
  │ (not a config flag)            │
  └────────────────────────────────┘
```

## Elaborate

The MTEB (Massive Text Embedding Benchmark) leaderboard is the standard reference for comparing models across retrieval, classification, and clustering tasks — worth checking before defaulting to whatever's most hyped, since benchmark rank shifts monthly as new models release. The practical lesson that survives any specific leaderboard snapshot: benchmark your own corpus and your own queries, because a model that wins MTEB's average score can still underperform a smaller domain-tuned model on your specific retrieval task. This decision feeds directly into `04-vector-databases.md` (dimension count affects index size and ANN parameters) and `09-stale-embeddings.md` (a model upgrade is one of the two triggers for needing a re-embed, alongside content changes).

## Project exercises

### EX-1 — benchmark two embedding models on the same `Finding` corpus

- **Exercise ID:** EX-1
- **What to build:** Extend the standalone script from `01-embeddings.md`'s exercise to embed the same set of `Finding.explanation` strings with two different models (e.g. a small open model like `all-MiniLM-L6-v2` and a larger one like `bge-base`), then compare: vector dimension, wall-clock time to embed the batch, and whether the top-3 nearest-neighbor results for a sample query differ between the two.
- **Why it earns its place:** "Model choice matters" is an abstract claim until you've seen two models disagree on what's "similar" for the exact same real text. This makes the dimension/cost/domain-fit tradeoff concrete against data this app already owns.
- **Files to touch:** new file, e.g. `app/scripts/compare-embedding-models.ts` (standalone, not wired into the app).
- **Done when:** you can state, for one concrete `Finding` explanation, which of the two models ranked its nearest neighbor differently and why that might matter for a real retrieval use case.
- **Estimated effort:** 1-2 hours, assuming EX-1 from `01-embeddings.md` is already done (this reuses its embedding-and-compare scaffolding).

## Interview defense

**Q: If two teams pick different embedding models for the same corpus, can they share one vector index?**
No. Vectors from different models are not comparable — different dimension counts can't even sit in the same index, and even same-dimension models from different training runs produce geometrically unrelated spaces. Each model needs its own index, or the corpus needs to be re-embedded into a shared model.

**Q: What's the single biggest mistake in choosing an embedding model?**
Picking based on benchmark leaderboard rank alone instead of testing against your own queries and your own corpus. A model can top MTEB's average across dozens of tasks and still lose to a smaller, cheaper model on your specific domain — the averages hide task-specific variance.

**Q: Does this app currently need to make this decision?**
No — there's no embedding call to attach a model choice to (see `01-embeddings.md`). The decision only becomes real the day this app has an unstructured corpus and a fuzzy-similarity question to ask of it, which today it doesn't.

## See also

- `01-embeddings.md` — what an embedding is and how it's produced
- `04-vector-databases.md` — where dimension count and metric choice affect index design
- `09-stale-embeddings.md` — model upgrades as one trigger for re-embedding
