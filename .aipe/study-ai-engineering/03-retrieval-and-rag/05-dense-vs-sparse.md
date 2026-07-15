# Dense vs sparse retrieval

Industry standard — two families of retrieval scoring: dense (embedding-vector similarity) vs sparse (term-based, exact/lexical matching like BM25 or SQL `LIKE`).

## Zoom out, then zoom in

This is the one file in this sub-section with a real, if partial, anchor in this codebase — mark it clearly:

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*  → search box passes `search` param     │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  scan-api.server.ts: getScanFindings() builds a Prisma      │
  │  `where.searchText = { contains: search }` filter            │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks — writes `searchText` at scan time  │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Finding.searchText (String, @default(""))│
  │                                                              │
  │  ┌ SPARSE SIDE — REAL, PRESENT ─────────┐  ┌ DENSE SIDE ──┐│
  │  │ ★ Finding.searchText — lowercased,    │  │ ★ NOT        ││
  │  │   space-joined exact-substring field, │  │   PRESENT —  ││
  │  │   matched via SQL `contains` ★         │  │   no vector, ││
  │  │                                        │  │   no embed ★ ││
  │  └────────────────────────────────────────┘  └──────────────┘│
  └──────────────────────────────────────────────────────────────┘
```

Every retrieval system scores candidates one of two fundamentally different ways: sparse retrieval counts and matches exact terms (or their stems) — the term is either present or it isn't; dense retrieval compares learned vector embeddings — closeness is a continuous geometric measure, not a boolean match. This app has exactly one half of that pair, fully implemented: `Finding.searchText` (`app/prisma/schema.prisma:118-122`) is a real, working sparse-retrieval field. There is no dense counterpart anywhere — no embedding of any `Finding` field exists.

## Structure pass

**Layers.** Both dense and sparse retrieval live at the same altitude — "how do I score a candidate against a query" — but the axis worth tracing is **what "match" means at each side of the query.**

**Axis: match semantics.** Sparse: match means *this exact token (or stem) appears in this exact token (or stem) of the document*. It's binary and interpretable — you can point at the exact substring that matched. Dense: match means *these two things sit near each other in a learned geometric space* — it's continuous and, critically, uninterpretable in isolation. You can't point at "the word that caused the match" because there isn't one; the score is a property of the whole vector.

**Seam.** The seam is the query-time transformation. Sparse retrieval transforms the query the same way it transformed the document at index time (lowercase, tokenize, maybe stem) — a cheap, deterministic, reversible transform. Dense retrieval transforms the query through the *same embedding model* that produced the corpus vectors — an expensive, model-dependent, one-way transform (`01-embeddings.md`). This app's `searchText` field sits entirely on the sparse side of that seam: `getScanFindings` lowercases the incoming `search` string the same way `searchText` was lowercased at write time (`app/app/services/scan/scan-api.server.ts:254`), and that symmetry is the whole trick — no model, no vector, no geometry involved.

## How it works

**Move 1 — the mental model.** You already know the difference between `Array.prototype.includes()` and a fuzzy string-similarity library. `includes()` (sparse) tells you the exact substring is there or it isn't — fast, exact, boring, and it misses "sizing runs small" when you search "undersized." A fuzzy match (dense, conceptually) would catch that — at the cost of being slower, probabilistic, and much harder to reason about when it's wrong.

```
  Pattern — same query, two scoring mechanisms

  query: "undersized"

  sparse (term match):
    doc: "the sizing is undersized"  → contains "undersized" → MATCH
    doc: "runs small, order a size up" → no "undersized" token → NO MATCH
                                          (even though it means the same thing)

  dense (vector similarity):
    doc: "the sizing is undersized"    → embed → close to query vector → MATCH
    doc: "runs small, order a size up" → embed → also close → MATCH
                                          (caught the meaning, no shared token)
```

**Move 2 — the mechanism, step by step, sparse side first (this app's real code).**

**Step 1: sparse indexing — denormalize a searchable field at write time.** Rather than searching across `productTitle`, `variantTitle`, `sku`, and `barcode` separately (four columns, four `OR` conditions, no shared case-folding), the write path concatenates and lowercases them into one field. From `app/prisma/schema.prisma:118-122`:

```
  // Lowercased, space-joined concatenation of productTitle/variantTitle/sku/
  // barcode, populated at persist time so free-text search can run as a SQL
  // case-insensitive `contains` (SQLite's `contains` is case-sensitive)
  // instead of an in-memory filter. See app/services/scan/severity.ts.
  searchText     String   @default("")
```

This is sparse retrieval's cheapest possible form: no tokenization, no stemming, no term frequency, no ranking — just "does this substring appear." It's denormalization for exact-match performance, the same category of tradeoff as any other precomputed column.

**Step 2: sparse querying — symmetric lowercase, SQL `contains`.** At read time, `getScanFindings` (`app/app/services/scan/scan-api.server.ts:254-262`) lowercases the incoming search term the same way and hands it to Prisma as a `contains` filter:

```typescript
  const search = opts.search?.trim().toLowerCase();
  if (search) {
    // `searchText` is a lowercased, space-joined concatenation of
    // productTitle/variantTitle/sku/barcode, populated at persist time...
    where.searchText = { contains: search };
  }
```
Annotated: `.trim().toLowerCase()` mirrors the write-time normalization exactly — that symmetry (query transformed the identical way the corpus was) is what makes sparse matching work without any model in the loop. `{ contains: search }` compiles to SQLite's `LIKE '%search%'` semantics under Prisma — a substring predicate, evaluated by the query planner against the indexed column, not scored or ranked at all beyond "matches or doesn't." There's no BM25-style term-frequency/inverse-document-frequency weighting here either — real sparse search engines (Elasticsearch, Postgres full-text search) add that scoring layer on top of tokenized term matching; this is the simpler substring-only end of the sparse spectrum, sufficient because catalog search doesn't need relevance ranking across a large free-text corpus, just "does this SKU/title contain what I typed."

**Step 3: dense side — not present, but here's what it would look like if it existed.** A dense equivalent would embed `Finding.explanation` (or a richer text blob) into a vector at write time, embed the incoming search query with the same model at read time, and rank by cosine similarity instead of filtering by substring:

```
  Pseudocode — the dense counterpart (hypothetical, not in this codebase)

  // write time
  finding.explanationVector = embed(finding.explanation)   // model call

  // read time
  queryVector = embed(searchQuery)                          // same model
  candidates = findingsForScan(scanId)
  ranked = sortByDescending(candidates, c => cosineSim(c.explanationVector, queryVector))
  return ranked.slice(0, k)                                 // top-k, not filtered
```

Notice the structural difference from the real code: sparse *filters* (a `WHERE` clause, any number of rows can match or none can); dense *ranks* (every candidate gets a score, you take the top k regardless of whether any of them are a "good" match). That's the deepest difference between the two families — sparse answers "which rows satisfy this," dense answers "which rows are most like this."

**In this codebase: only the sparse side is implemented, and it's implemented well for what it's asked to do** — exact SKU/title/barcode lookup, which is genuinely what merchants type into a catalog search box. There is no dense/embedding counterpart anywhere in `app/app` or `app/packages`.

**Move 3 — the principle.** Sparse and dense aren't "old way vs new way" — they answer different questions. Sparse wins when the query and the match share exact vocabulary (SKUs, part numbers, exact phrases) and when you need the match to be explainable ("it matched because the SKU string is right there"). Dense wins when the query and the match share *meaning* but not vocabulary (paraphrases, synonyms, typos). A production search feature over free-text customer queries usually needs both — which is exactly `06-hybrid-retrieval-rrf.md`'s subject — but reaching for dense before you've confirmed sparse can't do the job is reaching for the more expensive tool first.

## Primary diagram

```
  Full picture — dense vs sparse, this app's real state

  ┌─ SPARSE (real, in this codebase) ─────────────────────────┐
  │  write: productTitle+variantTitle+sku+barcode              │
  │         → lowercase, concat → Finding.searchText            │
  │  read:  search.trim().toLowerCase() → SQL `contains`        │
  │  → app/app/services/scan/scan-api.server.ts:254-262         │
  └───────────────────────────────────────────────────────────┘

  ┌─ DENSE (not present anywhere) ─────────────────────────────┐
  │  write: would need embed(explanation) → vector column        │
  │  read:  would need embed(query) → cosine similarity rank     │
  │  → no such column, no such call, anywhere in this repo       │
  └───────────────────────────────────────────────────────────┘

  ┌─ HYBRID (06-hybrid-retrieval-rrf.md) ──────────────────────┐
  │  combine both scores — not attempted here, no dense half    │
  │  to combine with                                             │
  └───────────────────────────────────────────────────────────┘
```

## Elaborate

The industry's sparse baseline is BM25 (Okapi BM25) — term-frequency/inverse-document-frequency scoring with saturation and length normalization, the default ranking function in Elasticsearch and Postgres full-text search. This app's `searchText.contains()` is a step *below* BM25 on the sparse spectrum: pure substring matching, no term frequency, no ranking, no relevance score — appropriate because the corpus per query (one scan's findings) is small and the matching need is exact (SKUs and titles), not "rank by relevance across a huge free-text corpus." Dense retrieval's rise tracks directly with the maturity of embedding models (`01-embeddings.md`) — it only became practical once embeddings got cheap and fast enough to compute at query time. The two aren't in competition long-term; modern retrieval systems run both and fuse the results (`06-hybrid-retrieval-rrf.md`), because sparse catches what dense misses (exact codes, rare terms dense models undertrain on) and dense catches what sparse misses (paraphrase, synonymy).

## Project exercises

### EX-1 — add a dense-search prototype next to the real sparse search, and compare results side by side

- **Exercise ID:** EX-1
- **What to build:** A standalone script (not wired into the app) that, for one scan, embeds every `Finding.explanation` (reusing the embedding work from `01-embeddings.md`), then runs the same search query through both paths: the real sparse path (replicate `getScanFindings`'s `searchText.toLowerCase().includes()` logic in-memory) and a dense path (cosine similarity against the embedded explanations). Print both result sets side by side for 3-4 sample queries, including at least one paraphrase query that shares no vocabulary with the target finding's text (e.g. searching "too cheap" against a finding whose explanation says "margin below threshold").
- **Why it earns its place:** This is the one file in the sub-section where the app already has half the picture built and working. Building the missing dense half — even as a disconnected script — turns "sparse vs dense" from a definition into something you watched disagree on real data, using this app's real production field (`searchText`) as the sparse baseline instead of a toy example.
- **Files to touch:** new file, e.g. `app/scripts/compare-dense-sparse-search.ts` (standalone; reads `Finding` rows via Prisma, never imported by app code).
- **Done when:** you have at least one query where sparse returns zero results but dense returns a relevant one (or vice versa), and you can explain in one sentence why each method behaved the way it did.
- **Estimated effort:** 1-2 hours, reusing the embedding scaffolding from `01-embeddings.md`'s exercise.

## Interview defense

**Q: Walk me through why `Finding.searchText` is sparse retrieval, not dense.**
It's a plain lowercased string, matched with SQL `contains` — a substring predicate. There's no vector, no embedding model, no similarity score; a row either contains the substring or it doesn't. That's the textbook definition of sparse/lexical matching, done at the cheapest possible tier (no tokenization or term weighting, just substring containment).
```
  "margin below" contains "margin" → true, exact substring
  "margin below" ~ "profit too low" → sparse says NO MATCH (no dense model in the loop)
```

**Q: If you had to add semantic search to this app's finding search box, what's the smallest change that would add dense retrieval?**
Add an embedding column (or a side table) storing a vector for each `Finding.explanation`, populate it at scan-persist time in `runner.server.ts` alongside where `searchText` is already populated, and at query time embed the incoming search string with the same model and rank by cosine similarity instead of (or in addition to) the existing `contains` filter. The existing sparse filter wouldn't need to be removed — see `06-hybrid-retrieval-rrf.md` for combining the two rather than replacing one with the other. This is speculative — not planned, not in the product spec.

**Q: Does this app need dense retrieval anywhere?**
Not for its current use case. Merchants searching findings are looking for a specific SKU, barcode, or product title they already know — exact substring matching is the right tool, and it's cheaper, faster, and fully explainable compared to a vector search that would add latency and an embedding cost for no accuracy gain on exact-string queries. Dense would only earn its place if the search box needed to answer fuzzy, paraphrased queries — which it currently doesn't.

## See also

- `01-embeddings.md` — what the dense side would require
- `04-vector-databases.md` — where dense vectors would need to live
- `06-hybrid-retrieval-rrf.md` — combining sparse and dense scores, the natural next step if dense were ever added
