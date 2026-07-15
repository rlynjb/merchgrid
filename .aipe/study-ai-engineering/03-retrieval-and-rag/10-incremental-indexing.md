# Incremental indexing

Industry standard — updating a retrieval index (vector or otherwise) as the underlying corpus changes, without a full rebuild from scratch.

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer (Remix) ───────────────────────────────────────┐
  │  app/app/routes/*                                          │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  app/app/services/scan/runner.server.ts — writes Finding     │
  │  rows once per scan; SQL indexes update automatically         │
  │  and incrementally on every insert (a relational-database     │
  │  primitive, not a bespoke pipeline)                            │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Engine packages ────────▼─────────────────────────────────┐
  │  packages/catalog-checks (MG-001..MG-010), packages/         │
  │  catalog-core                                                │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Storage layer ──────────▼─────────────────────────────────┐
  │  Prisma / SQLite: @@index([scanId, severity]) etc. — B-tree  │
  │  indexes maintained incrementally by SQLite itself             │
  │   ┌ NOT PRESENT IN THIS CODEBASE ─────────────────────────┐ │
  │   │  ★ no vector index exists, so there's no ANN-specific  ★│ │
  │   │  ★ incremental-update problem to solve ★                 │ │
  │   └─────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────┘
```

A retrieval corpus is rarely static — documents get added, edited, deleted continuously. Incremental indexing is the discipline of updating the index to reflect those changes without re-embedding and rebuilding the entire index from scratch every time, which becomes prohibitively expensive as the corpus grows. This app's relational indexes (`@@index([scanId, severity])`, `@@index([scanId, severityRank, checkId])`) already update incrementally, automatically, as a built-in property of how B-tree indexes work in any relational database — you get this for free from SQLite, no custom pipeline required. There's no vector index anywhere to have this problem in the ANN-specific sense.

## Structure pass

**Layers.** Incremental indexing sits at the maintenance layer of any index — the concern is entirely about *keeping the index synchronized with the source over time*, as distinct from *building the index once*. The axis worth tracing is **cost per change vs cost of a full rebuild.**

**Axis: cost of an update.** A relational B-tree index update on insert is O(log n) — cheap, structural, and the database does it transparently as part of every write transaction. A naive full-rebuild strategy for a vector index (re-embed and re-index the entire corpus on every change) is O(n) *per single change* — catastrophic at scale, since one edited document shouldn't require re-processing every other document.

**Seam.** The seam is between "one document changed" and "the whole index is affected." A well-designed incremental system keeps that blast radius contained to just the changed document; a poorly-designed one (or one that never considered incrementality) leaks the blast radius outward, forcing a full rebuild for any single change. HNSW-style ANN indexes (`04-vector-databases.md`) are naturally seam-friendly for *insertion* (new nodes attach to the existing graph without a rebuild) but seam-unfriendly for *deletion* (removing a node from a navigable-small-world graph without breaking its neighbors' connectivity is genuinely hard, which is why most vector databases implement delete as "tombstone and filter at query time," not "remove and re-link").

## How it works

**Move 1 — the mental model.** You already know the difference between `git commit` (record just the diff since last commit) and re-tarring your entire repository from scratch on every change. Incremental indexing is the `git commit` version of index maintenance — process only what changed, not everything.

```
  Pattern — diff-based update vs full rebuild

  full rebuild (naive):        incremental (correct):
    on ANY change:                on a change:
      re-embed ALL documents        identify WHICH document(s) changed
      rebuild ENTIRE index           re-embed ONLY those
      → O(corpus size)                update index for JUST those entries
                                       → O(changed documents), not O(corpus)
```

**Move 2 — the mechanism, step by step.**

**Step 1: change detection.** Before anything can be updated incrementally, the system needs to know *what* changed since the last index run — new documents (need embedding + insertion), edited documents (need re-embedding + replacement, same problem as `09-stale-embeddings.md`'s content-drift detection), and deleted documents (need removal or tombstoning). This is usually driven by a content hash/timestamp comparison, a change-data-capture stream off the source database, or an event emitted by the write path itself.

```
  Pseudocode — the incremental sync loop

  function incrementalSync(corpus, index, lastSyncState):
    changes = diffAgainstLastSync(corpus, lastSyncState)
    // changes = { added: [...], updated: [...], deleted: [...] }

    for doc in changes.added:
      vector = embed(doc.content)
      index.insert(doc.id, vector)

    for doc in changes.updated:
      vector = embed(doc.content)          // re-embed only the changed doc
      index.upsert(doc.id, vector)          // replace, don't touch anything else

    for docId in changes.deleted:
      index.markDeleted(docId)              // tombstone — see step 3

    saveSyncState(corpus.currentVersion)    // so next run diffs from here
```

**Step 2: insertion is usually cheap in ANN indexes.** HNSW-style graphs support adding a new node by connecting it to its approximate nearest existing neighbors — no rebuild of the rest of the graph required. This is why "add new documents" is the easy half of incremental indexing.

**Step 3: deletion is the hard half — tombstoning, not true removal.** Physically removing a node from an HNSW graph risks breaking the navigability of its neighbors (the graph's "small world" property depends on the specific link structure). Most production vector databases sidestep this by marking a vector as deleted (a tombstone flag) and filtering it out of query results, without touching the graph structure — then periodically running a full compaction/rebuild in the background to actually reclaim the space and purge tombstones, batched rather than per-delete.

```
  Layers-and-hops — incremental sync pipeline (general pattern)

  ┌─ Source DB ────┐  hop 1: change feed / CDC   ┌─ Sync worker ───┐
  │ documents get   │ ───────────────────────────►│ diff against     │
  │ added/edited/    │                              │ last sync state  │
  │ deleted          │                              └────────┬─────────┘
  └─────────────────┘                                        │ hop 2: embed only
                                                                │  changed docs
                                                     ┌──────────▼─────────┐
                                                     │ Embedding model      │
                                                     └──────────┬─────────┘
                                                                │ hop 3: insert/
                                                                │  upsert/tombstone
                                                     ┌──────────▼─────────┐
                                                     │ Vector index         │
                                                     └────────────────────┘
```

**In this codebase: not applicable in the vector sense, but the relational analog runs constantly and correctly.** Every `prisma.finding.create` inside `runner.server.ts`'s scan-persist path incrementally updates SQLite's B-tree indexes (`@@index([scanId, severity])`, `@@index([scanId, severityRank, checkId])`) as part of the same transaction — no rebuild, no batch reindex job, because relational indexes are incrementally maintained by construction. This is the same *shape* of problem (keep the index in sync with the source, cheaply, per-change) solved by a completely different, much simpler mechanism (B-tree insert) because the query shape (exact match/range) doesn't have HNSW's deletion problem — a B-tree entry can be physically removed without breaking any other entry's structure.

**Move 3 — the principle.** Any index — relational or vector — has an implicit maintenance contract: stay synchronized with the source as it changes, at a cost proportional to what changed, not to the size of the whole corpus. Relational databases solved this decades ago and hide the complexity from you entirely; vector indexes are newer and the deletion side of the problem is still handled with a workaround (tombstone + periodic compaction) rather than a clean structural solution, which is worth knowing going in rather than discovering the first time a "deleted" document keeps showing up in search results.

## Primary diagram

```
  Full picture — incremental indexing, insertion vs deletion (general pattern, absent here)

  ┌─ new document ────┐              ┌─ deleted document ──────┐
  │ embed → insert into │              │ mark tombstone           │
  │ HNSW graph, cheap    │              │ (don't unlink graph      │
  │ (attach to nearby     │              │ nodes — too risky)        │
  │  neighbors)            │              └────────────┬─────────────┘
  └──────────┬─────────────┘                            │
             │                                            │ filtered out
             ▼                                            ▼ at query time
  ┌─ index stays current, per-change cost ──────────────────────────┐
  │ periodic background compaction purges tombstones, reclaims space │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The deletion-is-hard asymmetry is specific to graph-based ANN structures (HNSW); other index types (IVF — inverted file index, which buckets vectors into clusters) handle deletion more cleanly since removing a vector from its cluster doesn't threaten a navigability property the way unlinking an HNSW graph node does — one more reason index-type choice (`04-vector-databases.md`) isn't just about query speed, it's also about how gracefully the index handles a live, changing corpus. This concept connects directly to `09-stale-embeddings.md` — content-drift detection is the "what changed" half of incremental indexing, and incremental indexing is the "now go update the index efficiently" half that follows detection.

## Project exercises

### EX-1 — build a diff-based re-embed script against `Finding` rows across two scans

- **Exercise ID:** EX-1
- **What to build:** A standalone script that, given two scans for the same shop, computes which findings are "new" (present in scan 2, not scan 1, matched by `checkId` + `productId` + `variantId`), embeds only those new findings (reusing `01-embeddings.md`'s scaffolding), and reports how many embed calls this saved compared to naively re-embedding every finding in scan 2 from scratch.
- **Why it earns its place:** This app already has a perfect real-world "corpus that changes over time" shape — successive scans for the same shop, where most findings repeat and some are genuinely new. Using that real diff to demonstrate incremental vs full-rebuild cost makes the O(changed) vs O(corpus) distinction concrete against actual repeat-scan data instead of a synthetic example.
- **Files to touch:** new file, e.g. `app/scripts/incremental-reembed-diff.ts` (standalone; reads two scans' `Finding` rows via Prisma).
- **Done when:** the script prints a concrete count — e.g. "120 findings in scan 2, 8 new, incremental approach embeds 8 instead of 120" — for a real pair of scans in the local database.
- **Estimated effort:** 1 hour, assuming at least two scans exist in the local dev database (or seed two manually) and `01-embeddings.md`'s scaffolding is reused.

## Interview defense

**Q: Why is deleting a vector from an HNSW index harder than inserting one?**
Insertion just attaches the new node to its nearest existing neighbors — the rest of the graph is untouched. Deletion risks breaking the navigability of the deleted node's neighbors, since HNSW's search efficiency depends on the specific link structure between nodes. Most production systems avoid solving this structurally and instead tombstone the vector (filter it at query time) and reclaim it later via periodic full-index compaction.

**Q: How does a relational B-tree index avoid the deletion problem that HNSW has?**
A B-tree's structure doesn't depend on approximate "closeness" links between arbitrary neighbors — removing a key just rebalances a small local part of the tree using well-understood, exact rebalancing rules. There's no risk of breaking some unrelated entry's ability to be found, because B-tree navigation is exact (compare-and-branch), not approximate-graph-walk.

**Q: Does this app need an incremental indexing strategy?**
Not in the vector-index sense — it has no vector index. It does rely on relational incremental indexing constantly (every `Finding` insert updates SQLite's B-tree indexes as part of the write transaction), which it gets for free from the database engine rather than needing to build a custom sync pipeline.

## See also

- `09-stale-embeddings.md` — the change-detection half this concept builds on
- `04-vector-databases.md` — the index structures (HNSW, IVF) with different incremental-update properties
- `01-embeddings.md` — what gets recomputed on each incremental update
