# Stale embeddings

Industry standard — the drift problem where stored vectors no longer reflect either the current source content or the current embedding model, silently degrading retrieval quality.

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/*  — each scan writes fresh Finding   │
  │  rows; nothing is ever updated in place after write           │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: Finding rows are write-once per scan,      │
  │  never mutated afterward                                      │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no embeddings exist, so there is nothing that can  ★│ │
  │   │  ★ go stale relative to source content or model ★       │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

An embedding is a snapshot — a vector computed from source content *at a moment in time*, using *one specific model*. Two things can happen after that moment: the source content changes (the document gets edited) or the embedding model changes (you upgrade to a better one). Either way, the stored vector no longer reflects what it's supposed to represent, and unlike a stale cache that returns visibly wrong data, a stale embedding returns *plausible-looking but subtly wrong* similarity results — nothing errors, nothing looks broken, the retrieval quality just quietly degrades. This app has no embeddings, so there's nothing that can go stale in this specific sense — but it's worth naming the general shape of the problem clearly, because it's the kind of silent failure mode that's easy to miss until retrieval quality complaints start arriving.

## Structure pass

**Layers.** Staleness lives at the boundary between the source-of-truth layer (the actual document/row) and the derived-index layer (the embedding). The axis worth tracing is **which side changed and who's responsible for noticing.**

**Axis: source of truth vs derived state.** The source document is the truth; the embedding is a derived, cached representation of it. Any system with a derived cache has this problem in some form (this is the same shape as `10-incremental-indexing.md`'s concern, and structurally identical to any materialized view or read-model that can drift from its source table) — the embedding-specific twist is that there's no way to *tell* an embedding is stale just by looking at it. A stale cache entry with a wrong value is still comparably wrong (a stale integer looks like a wrong integer); a stale embedding is a syntactically valid vector that just quietly means the wrong thing now.

**Seam.** The seam is "did anything invalidate this vector," and there's no automatic signal across it — no database trigger, no built-in TTL, nothing fires when the source document changes unless the system is explicitly wired to notice. This is the single most common production RAG bug: someone edits a source document, forgets (or the pipeline doesn't know) to re-embed it, and the vector index keeps serving the old content's vector under the new content's identity.

## How it works

**Move 1 — the mental model.** You've dealt with cache invalidation — a value gets computed once and cached, and if the underlying data changes without the cache being invalidated, the cache silently serves wrong data until something notices or the TTL expires. Stale embeddings are that same bug, except the "cache" is your entire retrieval index and there's usually no TTL at all — a vector, once written, stays valid forever unless something explicitly re-embeds it.

```
  Pattern — two independent triggers for staleness

  ┌─ trigger 1: content changed ─────┐   ┌─ trigger 2: model changed ─────┐
  │ document edited, but its vector   │   │ upgraded to a new embedding      │
  │ was never recomputed              │   │ model, but old vectors weren't   │
  │                                    │   │ re-embedded into the new space   │
  └────────────────┬───────────────────┘   └────────────────┬─────────────────┘
                   │                                          │
                   └──────────────┬───────────────────────────┘
                                  ▼
                     stored vector no longer represents
                     "what this document currently means"
```

**Move 2 — the two failure modes, step by step.**

**Failure mode 1: content drift.** A document gets updated — a policy changes, a product description is rewritten — and the embedding pipeline either isn't triggered on updates at all, or is triggered but fails silently (a background job errors and nobody notices). The vector index keeps returning the *old* content's vector, tagged with the *new* content's identity — so a query that should now match (because the new content covers it) doesn't, and a query that shouldn't match anymore (because the old content that made it relevant is gone) still does.

```
  Pseudocode — the naive pipeline that's silently vulnerable to content drift

  function onDocumentSave(doc):
    database.save(doc)
    // if this next line is missing, forgotten, or fails silently,
    // the vector index and the document are now out of sync forever
    vector = embed(doc.content)
    vectorIndex.upsert(doc.id, vector)

  // the bug: nothing enforces that embed() runs every time onDocumentSave runs.
  // a direct SQL update, a bulk import, or a failed background job all bypass it.
```

**Failure mode 2: model drift.** You upgrade from embedding model A to model B because B benchmarks better (`02-embedding-model-choice.md`). If you only embed *new* documents with model B while old documents keep their model-A vectors, you now have two incompatible coordinate systems living in the same index — a query embedded with model B will be compared against some vectors from model A's geometry and some from model B's, and the "distances" between them are meaningless (different models don't share a coordinate system at all, regardless of dimension match).

```
  Execution trace — silent corruption from mixed-model vectors

  index state:
    doc 1 (embedded 2023, model A)  → vector in model-A space
    doc 2 (embedded 2024, model B)  → vector in model-B space
    query (embedded now, model B)   → vector in model-B space

  query.distanceTo(doc1) → computed, returns SOME number — but it's comparing
                            across two different geometries, so the number
                            is meaningless, not just "less accurate"
  query.distanceTo(doc2) → computed correctly, same geometry

  the index doesn't know or warn you that doc1's comparison is invalid —
  it just returns a ranked list that silently mixes valid and garbage scores
```

**Step 3: detection is the hard part, not the fix.** Once you know a vector is stale, re-embedding it is trivial (one model call). The actual engineering problem is *noticing* — tracking a content hash or `updatedAt` timestamp per source document, comparing it against what the stored vector was computed from, and re-embedding on mismatch. Systems that skip this bookkeeping don't have "no staleness" — they have "undetected staleness," which is worse because nobody's watching for it.

**In this codebase: not yet implemented, and structurally can't occur.** `Finding` rows are write-once per scan (a new scan run writes new `Finding` rows; nothing updates a finding's `explanation` or `evidenceJson` in place after the scan completes — see `app/app/services/scan/runner.server.ts`), and there are no embeddings to begin with. There's no derived vector state that could drift from a source, because there's no derived vector state, full stop.

**Move 3 — the principle.** Any derived representation computed once from a source — an embedding, a materialized view, a denormalized cache column — carries an implicit obligation to be recomputed whenever its source changes, and that obligation is invisible until you build explicit tracking for it. The failure mode isn't "the system throws an error" — it's "the system keeps working, just wrong," which is exactly why staleness bugs survive in production far longer than crash bugs.

## Primary diagram

```
  Full picture — the two staleness triggers and their fix (general pattern, absent here)

  ┌─ content drift ──────────┐        ┌─ model drift ────────────┐
  │ source doc edited,        │        │ embedding model upgraded, │
  │ vector never recomputed   │        │ old vectors never migrated│
  └─────────────┬──────────────┘        └─────────────┬─────────────┘
                │                                       │
                └───────────────┬───────────────────────┘
                                ▼
                  ┌─ detection ────────────────────┐
                  │ track content hash / updatedAt   │
                  │ per source, compare vs vector's   │
                  │ recorded version                   │
                  └─────────────┬───────────────────────┘
                                ▼
                  ┌─ fix: re-embed on mismatch ─────┐
                  │ → 10-incremental-indexing.md      │
                  └────────────────────────────────────┘
```

## Elaborate

Content drift and model drift are the same underlying problem (a derived representation outliving its source's validity) but they call for different operational responses: content drift needs an event-driven or polling re-embed pipeline wired to every write path (including bulk imports and admin edits, which are the paths people forget); model drift needs a deliberate, planned full-corpus re-embed migration, usually run as a batch job with a cutover strategy (dual-write both vector spaces during migration, or accept a quality dip during the transition window). Neither is optional in a long-lived RAG system — a system that embeds once at launch and never revisits it will degrade in ways that are nearly impossible to diagnose from symptoms alone, because "retrieval quality feels a little off" doesn't point at a stack trace.

## Project exercises

### EX-1 — simulate content drift on `Finding.explanation` and show the staleness bug

- **Exercise ID:** EX-1
- **What to build:** A standalone script that (1) embeds a `Finding.explanation` string and stores the vector plus a content hash, (2) simulates an edit to that explanation text (change a word), (3) computes the cosine similarity between the *old* stored vector and the *new* edited text's fresh embedding, and (4) shows how close/far they land — then repeats the exercise but properly re-embeds on hash mismatch, contrasting "stale vector silently used" against "detected and refreshed."
- **Why it earns its place:** This is the one concept in the sub-section that's easiest to understand in the abstract and easiest to miss in practice — actually watching a similarity score stay deceptively plausible even after the underlying text changed is what makes "silent, not crashing" concrete instead of a talking point.
- **Files to touch:** new file, e.g. `app/scripts/simulate-content-drift.ts` (standalone, reuses embedding scaffolding from `01-embeddings.md`'s exercise).
- **Done when:** you can show a concrete before/after similarity score for the same finding's edited text, and state whether the drift would have been silently invisible without the hash check.
- **Estimated effort:** 45-60 minutes, assuming `01-embeddings.md`'s exercise scaffolding already exists.

## Interview defense

**Q: How would you detect that an embedding has gone stale due to content drift, without re-embedding everything on every request?**
Store a content hash (or a source `updatedAt` timestamp) alongside each vector at embed time. On read or on a periodic sweep, compare the source's current hash against the stored one; only re-embed on mismatch. This turns an O(corpus) re-embed cost into an O(changed documents) cost.

**Q: Why is model drift worse than content drift, structurally?**
Content drift affects individual documents one at a time — you can detect and fix them incrementally. Model drift invalidates the entire index's coordinate system at once — every vector from the old model is now incomparable with vectors from the new model, so there's no incremental fix; it's a full re-embed or a carefully managed dual-index migration.

**Q: Does this app have a stale-embeddings problem?**
No — it has no embeddings at all, so there's nothing to go stale in this sense. It does have an analogous-but-different concern worth naming honestly: `Finding` rows are immutable snapshots written once per scan, which sidesteps embedding staleness entirely by never updating derived state in place — each new scan just writes fresh rows instead of mutating old ones.

## See also

- `02-embedding-model-choice.md` — model drift's root cause
- `10-incremental-indexing.md` — the mechanism that fixes detected staleness
- `01-embeddings.md` — what's being invalidated in the first place
