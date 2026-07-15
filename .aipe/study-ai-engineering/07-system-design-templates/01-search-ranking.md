## Search ranking

- **The prompt:** Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus.

- **Standard architecture:** the four-stage pipeline every senior candidate should be able to sketch in under a minute.

```
QUERY → CANDIDATES → RANK → SERVE
────────────────────────────────────────────────────────────

  user query
      │
      ▼
┌──────────────┐
│    query     │  spell-fix, intent tag,
│ understanding│  query rewrite/expansion
└──────┬───────┘
       │
       ▼
┌──────────────────────────────┐
│      candidate retrieval     │
│  ┌───────────┐ ┌───────────┐ │
│  │  sparse   │ │   dense   │ │  BM25/inverted index
│  │ (BM25/    │ │ (ANN over │ │  + embedding ANN,
│  │  inverted │ │ embeddings│ │  fused into one set
│  │  index)   │ │  index)   │ │
│  └─────┬─────┘ └─────┬─────┘ │
│        └──────┬──────┘       │
└───────────────┼───────────────┘
                ▼
        ~1k-10k candidates
                │
                ▼
       ┌─────────────────┐
       │     ranking      │  learned model (GBDT
       │ (cross-encoder / │  or cross-encoder),
       │  learned model)  │  scores each candidate
       └────────┬─────────┘
                ▼
          top-k, ordered
                │
                ▼
       ┌─────────────────┐
       │  serving + log   │  render results,
       │                  │  log impressions/clicks
       └─────────────────┘
```

  Query understanding narrows what "relevant" means before retrieval ever runs; ranking is a second, more expensive pass applied only to the small candidate set retrieval hands it.

- **Data model:**
  - **Inverted index** (term → posting list of doc IDs) — backs sparse/BM25 retrieval, cheap and exact-match strong.
  - **Dense embedding index** (ANN structure — HNSW/IVF) — backs semantic retrieval for queries with no literal term overlap.
  - **Document/item store** — the source-of-truth fields (title, description, price, attributes) rendered at serve time; retrieval indexes only point back to IDs here.
  - **Query-doc relevance judgments** — offline labeled set (human-rated or inferred from clicks) used to train and evaluate the ranker.
  - **Feature store** — precomputed per-doc and per-query-doc features (click-through history, freshness, popularity) the ranking model reads at inference time.
  - **Impression/click logs** — every query, the candidates shown, position, and whether the user clicked — the raw material for both online eval and next-generation training data.

- **Key components:**
  - **Query understanding** — normalizes and classifies the query (typo correction, synonym expansion, intent/vertical classification) so retrieval doesn't have to compensate for raw user input; rationale: fixing "reccomend" once here is cheaper than making every downstream stage typo-tolerant.
  - **Sparse retrieval (BM25/inverted index)** — exact and near-exact term matching; rationale: cheap, interpretable, and strong on head queries with literal keyword overlap.
  - **Dense retrieval (embedding ANN)** — semantic matching for queries with no shared vocabulary with the target doc; rationale: covers the long tail sparse retrieval misses, at the cost of needing an embedding model and an ANN index to maintain.
  - **Ranking (cross-encoder or learned model)** — a more expensive model scores each retrieved candidate against the query directly; rationale: retrieval optimizes for recall over the whole corpus cheaply, ranking optimizes for precision over a tiny candidate set expensively — splitting the two is what makes low latency possible at all.
  - **Serving + logging** — renders the final ordered list and logs every impression and click; rationale: without this the system can never be evaluated online or retrained, so it's not optional infrastructure, it's the feedback loop.

- **Scale concerns:**
  - At **~1M+ documents**, brute-force cross-encoder scoring of the full corpus per query is too slow — this is why retrieval exists at all, to cut the candidate set down before the expensive model runs.
  - At **10M+ documents**, a single-node inverted index or ANN structure stops fitting in memory — sharding the index across nodes becomes necessary, and query fan-out/merge latency becomes the new bottleneck.
  - At **~10k+ QPS**, ranking model inference becomes the latency-critical path — this drives the move from a full cross-encoder to a distilled model or a two-stage rank (cheap linear/GBDT prefilter, expensive cross-encoder only on the top ~100).
  - At **daily-refresh-or-slower index builds**, freshness lag shows up as stale results for time-sensitive queries (new inventory, price changes) — this drives incremental/near-real-time index updates instead of full rebuilds.

- **Eval framing:**
  - **Offline**: hit@k, MRR, NDCG against a labeled query-doc relevance set — cheap, repeatable, and what gets checked before any model ships.
  - **Online**: CTR, dwell time, and downstream conversion measured via A/B test against the current production ranker — the only way to know if an offline win translates to real user behavior.
  - **Per-deployment**: every model push is guarded by an online experiment with a pre-registered success metric, because offline NDCG gains routinely fail to move CTR (metric mismatch is the norm, not the exception).

- **Common failure modes:**
  - **Stale index** — the index lags the live corpus (deleted/updated items still rank) — mitigated with incremental indexing or a freshness-boost signal that decays stale entries.
  - **Cold queries** — head/tail query with no historical click data to train on — mitigated by falling back to content-based (BM25/embedding similarity) scoring when engagement features are missing, rather than defaulting to zero relevance.
  - **Position bias** — clicks concentrate on top positions regardless of true relevance, corrupting naive click-through training labels — mitigated with counterfactual/inverse-propensity weighting or randomized position experiments to de-bias the training signal.
  - **Lost-in-the-middle / recall cutoff** — a relevant document exists in the corpus but never makes it into the top-k candidate set retrieval hands to ranking — mitigated by widening the candidate set size or blending retrieval signals (sparse ∪ dense) instead of trusting either alone.

- **Applies to this codebase:** no. MerchGrid has no query surface at all — there is no text box a merchant types into and no code path that takes a user string and returns "relevant" items in response to it. What looks adjacent is `Finding.severityRank` in `app/prisma/schema.prisma` (`@@index([scanId, severityRank, checkId])`) and the `orderBy: [{ severityRank: "asc" }, { checkId: "asc" }]` in `getAllFindingsForExport` (`app/app/services/scan/scan-api.server.ts`) — but that's a fixed rule-based ordinal (Critical > Warning > Info, defined once per check), not a learned relevance score produced from query-doc interaction data. Findings aren't retrieved against a query either — every one of the 10 checks (MG-001..MG-010) runs against the entire catalog on every scan and writes every result, full stop. There's no recall/precision tradeoff, no candidate generation step, no ranking model, and no click logs to train one, because there's no query to click a result in response to.

- **How to make it apply:** the sparse half already exists almost by accident — `getScanFindings` in `app/app/services/scan/scan-api.server.ts` takes an `opts.search` string and runs `where.searchText = { contains: search }` against the denormalized `Finding.searchText` column (lowercased product title + variant title + SKU + barcode, populated at persist time in `runner.server.ts`). That's real SQL substring search, which is functionally BM25's crude ancestor — a merchant can already type "hoodie" and get matching findings back. To actually defend this as a search-ranking system you'd need two things this app has neither of: (1) a UI surface that frames this as search rather than a filter control, and (2) usage data — no click, dwell, or "opened this finding" event is logged anywhere today, so there's nothing to train a learned reranker on even if you wanted one. The honest next step isn't a reranker; it's instrumenting which findings merchants actually open from a search result set, which is the prerequisite for any ranking model, not the model itself.
