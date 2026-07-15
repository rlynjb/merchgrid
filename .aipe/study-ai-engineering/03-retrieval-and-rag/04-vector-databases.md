# Vector databases

Industry standard — specialized (or extended) storage engines for approximate nearest-neighbor search over embeddings (pgvector, Pinecone, Qdrant, Weaviate, etc.).

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
  │  Prisma / SQLite — one relational engine, one job:          │
  │  exact-match rows via B-tree indexes                         │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no vector index — SQLite here has no vector         │ │
  │   │  ★ extension, no ANN index, nothing to query by         │ │
  │   │  ★ similarity ★                                          │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

A vector database answers one question a relational database's B-tree index physically cannot: "give me the k rows whose vector is closest to this query vector," across millions of vectors, in milliseconds. Regular indexes are built for equality and range queries (`WHERE checkId = 'MG-003'`, `WHERE createdAt > X`) — they have no concept of "close in 1536-dimensional space." This app's storage layer is SQLite via Prisma, doing exactly the job a relational store is built for: exact-match, range, and sort queries over typed columns. There's no similarity query anywhere in it, so there's no vector database.

## Structure pass

**Layers.** A vector database sits at the same altitude as a relational database — both are storage-and-query engines — but they answer a structurally different question. Trace the axis **query shape**: a relational engine answers "which rows satisfy this predicate, exactly" (`WHERE checkId = 'MG-003'`); a vector engine answers "which rows are nearest to this point, approximately" (top-k by distance, no exact predicate at all).

**Seam.** The seam is the query API itself. A relational client sends SQL with `WHERE`/`ORDER BY`/`LIMIT`; a vector client sends a query vector plus a `k` and gets back the k nearest neighbors and their distances — no `WHERE` clause in the traditional sense (though most vector databases now support *hybrid* filtering — a metadata predicate combined with the similarity search, which is where `06-hybrid-retrieval-rrf.md` picks up). Cross this seam and the entire mental model of "query" changes from "matches a condition" to "how far is this."

## How it works

**Move 1 — the mental model.** You know how a relational index turns "scan every row" into "binary search a sorted structure" for equality/range lookups. A vector database does the analogous trick for *similarity* lookups — instead of computing the distance from your query to every single stored vector (which would be correct but too slow at scale — O(n) per query), it builds an approximate index (most commonly HNSW — Hierarchical Navigable Small World graphs) that lets it find the *approximate* nearest neighbors in roughly logarithmic time, trading a small amount of recall for a massive speedup.

```
  Pattern — exact scan vs approximate index

  exact (brute force):        compare query to every vector, O(n)
    query ──► [v1][v2][v3][v4][v5][v6]...[vn]  ──► sort by distance ──► top k

  approximate (HNSW-style):    query ──► navigate a graph of "similar" links
    query ──► [entry point] ──► [closer node] ──► [closer node] ──► top k
              (each hop only looks at nearby graph neighbors, not the whole set)
```

**Move 2 — the mechanism, step by step.**

**Step 1: build the index.** As vectors are inserted, the vector database builds an index structure (HNSW is the current default across most engines — Pinecone, Qdrant, Weaviate, pgvector all support it) — a multi-layer graph where each vector is a node connected to its approximate nearest neighbors, with sparser "highway" layers on top for fast long-distance jumps and denser layers at the bottom for fine-grained search.

**Step 2: query time — approximate nearest neighbor (ANN) search.** The query vector enters at the top (sparse) layer, greedily walks to the locally-closest node, then drops down a layer and repeats, refining at each level until it reaches the bottom layer and returns the k closest nodes it found.

```
  Pseudocode — HNSW-style query (simplified)

  function searchANN(queryVector, k, index):
    currentNode = index.entryPoint            // top layer, sparse
    for layer from index.topLayer down to 0:
      currentNode = greedySearch(queryVector, currentNode, layer)
      // greedySearch: hop to whichever neighbor at this layer
      // is closer to queryVector, until no neighbor is closer
    candidates = expandSearch(queryVector, currentNode, layer=0, ef=largerBeamWidth)
    return topK(candidates, k)                 // approximate — may miss the true nearest
```

**Step 3: distance metric and dimension are fixed at index-build time.** The index is built assuming a specific distance function (cosine, dot product, Euclidean) and a specific vector dimension — both inherited from whatever embedding model produced the vectors (`02-embedding-model-choice.md`). Change either and the existing index is invalid; you rebuild from scratch.

**Step 4: hybrid filtering (the practical reality).** Pure ANN search rarely ships alone — real systems filter by metadata first or alongside (e.g. "only vectors where `tenant_id = X`"), because a multi-tenant system that let ANN search roam across every tenant's vectors would leak data across the tenant boundary. This is why "vector database" today usually means "ANN index plus a metadata filter," not ANN in isolation.

```
  Layers-and-hops — a typical vector-database round trip (general pattern)

  ┌─ App server ──┐  hop 1: embed the query      ┌─ Embedding model ─┐
  │ receives query │ ────────────────────────────►│ text → vector      │
  └───────┬────────┘  hop 2: query vector + k  ◄──┴─────────────────────┘
          │           ─────────────────────────────►
          │                                       ┌─ Vector database ──┐
          │           hop 3: top-k ids + distances │ ANN index search    │
          └───────────────────────────────────────◄│ (+ metadata filter) │
                                                    └─────────────────────┘
```

**In this codebase: not yet implemented.** SQLite (via `app/prisma/schema.prisma`) has no vector extension configured, no vector column on any model, and no ANN query anywhere in `app/app/services`. Every query against `Finding` uses B-tree-backed indexes for exact filtering and sort — `@@index([scanId, severity])` and `@@index([scanId, severityRank, checkId])` — the relational-database equivalent of the ANN index, but answering "equals" and "sorts before/after," never "is near."

**Move 3 — the principle.** A vector database isn't a better database — it's a specialized index for one query shape (approximate similarity) that relational engines don't do well. Reaching for one is a decision driven entirely by whether your queries are actually "find things like this," not a default upgrade to make because it's the modern-sounding choice. When every query in a system is exact-match or range-based, adding a vector store adds an entire deployable service (or extension) with nothing to search.

## Primary diagram

```
  Full picture — vector database in a retrieval pipeline (general pattern)

  ┌─ query text ──┐   ┌─ embed ──────┐   ┌─ ANN index (HNSW) ─────┐
  │ "shoes that     │──►│ same model as │──►│ graph-walk search,      │
  │  run small"     │   │ corpus         │   │ + optional metadata      │
  └─────────────────┘   └───────────────┘   │ filter (multi-tenant     │
                                              │ safety)                  │
                                              └────────────┬─────────────┘
                                                            │ top-k
                                                  ┌─────────▼─────────┐
                                                  │ ranked candidates  │
                                                  │ → 06-hybrid /       │
                                                  │   07-reranking      │
                                                  └────────────────────┘
```

## Elaborate

The vector database landscape splits into three shapes: purpose-built standalone services (Pinecone, Qdrant, Weaviate, Milvus — run as their own deployable, optimized purely for ANN at scale), extensions bolted onto existing relational engines (`pgvector` inside Postgres — you get ANN search *and* SQL joins/transactions in the same database, at some cost to raw ANN throughput versus a dedicated engine), and in-process/embedded libraries (FAISS, sqlite-vec — no server at all, linked directly into your application process, good for smaller corpora or edge deployment). The practical decision usually comes down to whether you already have transactional data that needs to join against the vectors (favors an extension like pgvector) or whether you need dedicated ANN throughput at large scale with no other database in the room (favors a standalone service). Either way, the index itself needs maintenance as the corpus changes — see `10-incremental-indexing.md` for what happens when vectors are added, updated, or deleted after the initial build.

## Project exercises

### EX-1 — build a brute-force ANN search over embedded `Finding` rows, no vector database

- **Exercise ID:** EX-1
- **What to build:** Reusing the embeddings produced in `01-embeddings.md`'s exercise, write a standalone script that does brute-force k-nearest-neighbor search (compute cosine similarity against every stored vector, sort, take top k) for a sample query string — no vector database, no ANN index, just a loop and a sort.
- **Why it earns its place:** Before reaching for pgvector or Pinecone, seeing the O(n) brute-force version working correctly on real (if small) data makes the *purpose* of an ANN index concrete — you'll feel exactly where brute force stops scaling, because you'll have to compute the similarity for every single row yourself.
- **Files to touch:** new file, e.g. `app/scripts/brute-force-knn.ts` (standalone, extends the EX-1 script from `01-embeddings.md`).
- **Done when:** the script returns the top-3 nearest findings to a hand-written query string, and you can state in one sentence why this approach wouldn't work at 10 million rows.
- **Estimated effort:** 1 hour, assuming the embeddings from `01-embeddings.md`'s exercise already exist.

## Interview defense

**Q: Why not just brute-force cosine similarity against every row instead of using an ANN index?**
Brute force is O(n) per query — exact, but linear in corpus size. At a few thousand vectors that's fine; at tens of millions it's seconds per query instead of milliseconds. ANN indexes trade a small amount of recall (you might miss the true single-best match occasionally) for logarithmic-ish query time. The load-bearing part people forget: ANN is *approximate* — it's a correctness tradeoff, not just a performance one, and some use cases (legal, medical) need to explicitly account for that.

**Q: What happens to an HNSW index's distance metric if you switch embedding models?**
The whole index becomes invalid. The index was built assuming vectors from a specific model with a specific dimension count and geometry — a new model produces vectors that don't fit the existing graph structure at all, dimension mismatch aside. You rebuild the index from scratch, which is the same lock-in described in `02-embedding-model-choice.md`.

**Q: Does this app need a vector database?**
No. Its storage layer (SQLite via Prisma) only ever needs to answer exact-match and range queries over typed relational columns — `checkId`, `severity`, `scanId` — which is exactly what a B-tree index is built for. There's no "find similar to this" query anywhere in the product, so there's no similarity index to build.

## See also

- `01-embeddings.md` — what gets stored in the index
- `05-dense-vs-sparse.md` — the query-shape contrast, with this app's real (partial) anchor
- `10-incremental-indexing.md` — keeping an ANN index current as the corpus changes
