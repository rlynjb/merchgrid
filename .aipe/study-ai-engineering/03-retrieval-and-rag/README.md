# Retrieval and RAG — study guide for MerchGrid: Catalog Audit

This entire sub-section is **not yet exercised**. MerchGrid: Catalog Audit is a deterministic, rule-based Shopify app — ten hand-written validation checks (MG-001 through MG-010) that produce structured `Finding` rows from live Shopify catalog data. Per the product spec (§2.1): "Findings come from explicit validation rules rather than an LLM." §17.6 bans AI-powered messaging outright for this MVP. There is no LLM anywhere in the request path, no embedding call, no vector store, and no retrieval pipeline anywhere in `app/app` or `app/packages`. The data store is Prisma/SQLite holding structured relational rows (`Shop`, `ShopSettings`, `Scan`, `Finding`, `ScanArtifact`) — a transactional data model, not a retrieval corpus.

Every file below teaches its concept fully and correctly as transferable knowledge, then says plainly where this codebase stands relative to it: absent. Where a concept has zero natural connection to this repo, the file says so briefly and moves on rather than straining for relevance.

**Start here if you only read one file:** `05-dense-vs-sparse.md`. It's the one file in this sub-section with a real, if partial, anchor in the codebase — `Finding.searchText` (`app/prisma/schema.prisma:118-122`), a working sparse/lexical retrieval field, matched via SQL `contains` in `getScanFindings` (`app/app/services/scan/scan-api.server.ts:254-262`). There is no dense counterpart anywhere, which makes it a clean, honest half-example rather than an invented one.

## Reading order

| # | File | Codebase anchor |
|---|------|------------------|
| 01 | `01-embeddings.md` | None — foundational concept, taught in full |
| 02 | `02-embedding-model-choice.md` | None |
| 03 | `03-chunking-strategies.md` | None — this app has no long-form documents to chunk |
| 04 | `04-vector-databases.md` | None |
| 05 | `05-dense-vs-sparse.md` | **Real, partial** — `Finding.searchText` is the sparse half; no dense half exists |
| 06 | `06-hybrid-retrieval-rrf.md` | None — nothing to fuse without a second ranked list |
| 07 | `07-reranking.md` | None — `getScanFindings`'s SQL sort is deterministic, not query-dependent relevance scoring |
| 08 | `08-query-rewriting-hyde.md` | None — search input is normalized (`.trim().toLowerCase()`), never LLM-rewritten |
| 09 | `09-stale-embeddings.md` | None — no embeddings exist to go stale; `Finding` rows are write-once by design |
| 10 | `10-incremental-indexing.md` | Relational analog only — SQLite's B-tree indexes update incrementally by construction, no vector index exists |
| 11 | `11-rag.md` | None — no retrieval + no LLM generation, the two things RAG combines |
| 12 | `12-graphrag.md` | None — the app's `Shop`→`Scan`→`Finding` foreign keys are a real relational graph, but hand-declared, not LLM-extracted, and never traversed to feed an LLM |

## Why this sub-section is empty, in one paragraph

Retrieval and RAG solve a specific problem: an LLM needs to answer using content it can't reliably know from training alone — private data, current data, or data too large to fit in a prompt without narrowing it down first. MerchGrid has no LLM generating anything, so there's no "what the model doesn't know" gap to bridge with retrieval. Its findings come from explicit, auditable rule functions (`packages/catalog-checks`) evaluated against typed Shopify catalog data — a categorically different (and, for this product's trust requirements around merchants understanding *why* a finding fired, deliberately better) mechanism than having a model synthesize an answer.

## A speculative, unplanned angle worth naming honestly

A future merchant-facing feature — "explain this finding in plain language, citing similar past findings" — could someday retrieve over past `Finding` rows and hand them to an LLM for synthesis. This would be a legitimate RAG use case if it ever existed. It does not exist today, is not in the current product spec, and is explicitly out of scope for this MVP (§17.6). It's mentioned in `11-rag.md`'s interview-defense block as the honest answer to "would this ever need RAG" — not as a roadmap item.

## See also

- `../01-llm-foundations/` — the foundational LLM concepts this sub-section builds on
- `../02-context-and-prompts/` — prompt construction, relevant if RAG's augmentation step were ever built
- `../04-agents-and-tool-use/` — where "the model decides when to retrieve" would live, one layer up from this sub-section's always-retrieve pattern
