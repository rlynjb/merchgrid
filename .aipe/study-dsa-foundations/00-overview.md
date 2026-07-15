# 00 — Overview: DSA foundations in MerchGrid: Catalog Audit

MerchGrid is ten deterministic checks over a flat list of variants — no LLM, no
ranking model, no live user queries hammering an index under load. That sounds
like "not much DSA happening here." It isn't true. The engine leans on exactly
the vocabulary you'd expect from a batch-processing pipeline: hash grouping,
selection statistics, a state machine modeled as a graph, decimal arithmetic
as a correctness boundary, and bounded iteration as a cost-control device. What
it does NOT lean on — trees, tries, heaps, graph traversal, recursion, DP — is
just as instructive, because the reasons it doesn't are architectural
decisions, not gaps in the code.

This guide teaches the reusable vocabulary both ways: grounded where the repo
exercises it, honestly flagged `not yet exercised` where it doesn't, with a
concrete anchor for where it would attach if the product grew in the direction
its own spec (the planned "MerchGrid: Bulk AI" changeset-preflight product)
already points.

```
Whole system — where DSA vocabulary lives

┌─ UI layer ────────────────────────────────────────────────────────┐
│  Polaris findings table — reads a pre-sorted, pre-paginated page   │
└──────────────────────────┬──────────────────────────────────────┬─┘
                            │ HTTP                                 │
┌─ Service layer — worker process ──────────────────────────────┐  │
│                                                                 │  │
│  catalog-reader.server.ts   → PAGINATION AS BOUNDED ITERATION  │  │
│    (readCatalog, fetchAllVariants)            (§ concept 1, 5) │  │
│                                                                 │  │
│  runner.server.ts → runScan → engine call                      │  │
└──────────────────────────┬──────────────────────────────────────┘  │
                            │ in-process call, zero I/O               │
┌─ Engine — @merchgrid/catalog-checks (pure functions) ──────────────┐│
│                                                                      ││
│  run.ts          runChecks()            → FLATMAP FAN-OUT  (§1)    ││
│  _helpers.ts     groupBy()              → HASH GROUPING    (§2)    ││
│  mg-005/006/009  dedup via groupBy       → SET SEMANTICS    (§2)    ││
│  mg-008          median()                → SORT + SELECT   (§6)    ││
│  money.ts        Decimal arithmetic      → COST MODEL       (§1)    ││
└──────────────────────────────────────────────────────────────────┬──┘│
                            │ persisted findings                    │  │
┌─ Storage layer — SQLite via Prisma ───────────────────────────────▼──┘
│  Finding @@index([scanId, severityRank, checkId]) → BALANCED INDEX (§4) │
│  Shop → Scan → Finding cascade delete             → OWNERSHIP TREE (§4) │
└──────────────────────────────────────────────────────────────────────┘
                            ▲
┌─ Scan lifecycle — services/scan/state.ts ─────────────────────────────┐
│  QUEUED → READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS →       │
│  COMPLETED | FAILED             → STATE MACHINE AS A GRAPH (§5)        │
└────────────────────────────────────────────────────────────────────────┘

  DB-backed FIFO queue (queue.server.ts + worker-core.server.ts)
  → QUEUE DISCIPLINE OVER SQL, NOT AN IN-MEMORY STRUCTURE (§3)
```

## Reading order

1. `01-complexity-and-cost-models.md` — time/space/amortized analysis, and
   why "bounded by a budget" is a different cost model than "bounded by
   input size." Anchors: `catalog-reader.server.ts` pagination guardrail,
   `groupBy`'s single pass, `run.ts`'s `flatMap` fan-out.
2. `02-arrays-strings-and-hash-maps.md` — indexed sequences, string
   canonicalization, and the `Map`-backed grouping pattern that four checks
   share. Anchors: `_helpers.ts` `groupBy`/`normalizeSku`/`normalizeBarcode`,
   `csv.ts` `escapeCsvField`, `severity.ts` `buildSearchText`.
3. `03-stacks-queues-deques-and-heaps.md` — ordering disciplines. Anchors:
   the DB-backed FIFO scan queue (`queue.server.ts`, `worker-core.server.ts`),
   the precomputed-rank sort standing in for a priority queue
   (`severity.ts`, `schema.prisma`). Heaps and deques: `not yet exercised`.
4. `04-trees-tries-and-balanced-indexes.md` — hierarchies and ordered
   indexes. Anchors: the Shop→Scan→Finding cascade-delete tree
   (`schema.prisma`), the SQLite B-tree behind
   `@@index([scanId, severityRank, checkId])`. Tries and in-app tree
   structures: `not yet exercised`.
5. `05-graphs-and-traversals.md` — the scan pipeline modeled as a directed
   graph. Anchors: `state.ts`'s `LEGAL_FORWARD_TRANSITIONS` and
   `assertTransition`. BFS/DFS/shortest-path: `not yet exercised` (the graph
   is a single chain — no traversal algorithm is needed yet).
6. `06-sorting-searching-and-selection.md` — ordering and selection.
   Anchors: `money.ts`'s `median()` (sort-then-index selection), SQL
   `ORDER BY` as delegated multi-key sort. Binary search and quickselect:
   `not yet exercised`.
7. `07-recursion-backtracking-and-dynamic-programming.md` — state spaces
   and repeated subproblems. Anchor: `normalize.ts`'s deliberately iterative
   two-level nested loop instead of recursion. Backtracking and DP:
   `not yet exercised`.
8. `08-dsa-foundations-practice-map.md` — a ranked practice plan connecting
   what's exercised here to what's already in your `reincodes` DSA
   portfolio, and where each gap would attach if MerchGrid grew toward
   "Bulk AI."

## Ranked findings — what's most worth understanding first

1. **Hash grouping (`groupBy`) is the single most-reused mechanism in the
   engine.** Four of ten checks (MG-005, MG-006, MG-008, MG-009) are the same
   shape: bucket variants by a normalized key, then look at what landed in
   each bucket. Understand `groupBy` once and you understand 40% of the
   check suite. → `02-arrays-strings-and-hash-maps.md`.
2. **The scan pipeline is a graph with a name (`ScanStatus`) hiding in plain
   sight.** `assertTransition` is an edge-membership check on a 6-node
   directed graph. It's small enough that nobody had to write BFS — but
   naming it as a graph is what lets you reason about it correctly (why
   terminal states have no outgoing edges, why `FAILED` is reachable from
   everywhere). → `05-graphs-and-traversals.md`.
3. **Every "priority" and "queue" in this codebase is SQL doing the DSA
   work, not an in-memory structure.** No heap, no array-based queue. Both
   are modeled as `ORDER BY` over a persisted table. This is a deliberate,
   correct choice at this scale (durability matters more than in-memory
   speed for a background job queue) — and it's exactly the choice that
   stops being sufficient once you need live re-prioritization.
   → `03-stacks-queues-deques-and-heaps.md`.
4. **Money is a cost-model decision, not just a style rule.** `money.ts`
   never touches `Number`/floats; every comparison and every median goes
   through `decimal.js`. That's a complexity concept (which operations are
   exact vs. approximate) doing correctness work, not just performance
   work. → `01-complexity-and-cost-models.md`.

## `not yet exercised` — named up front

- **Heaps / priority queues** — no dynamic re-prioritization anywhere;
  severity ordering is precomputed and SQL-sorted.
- **Tries** — no prefix/autocomplete search; free-text search is a SQL
  substring `contains`.
- **General tree traversal in application code** — the product→variant
  hierarchy is a fixed two-level structure, not a general tree; Prisma's
  cascade delete does the only "tree walk" in the system, and the DB engine
  does it, not app code.
- **Graph traversal (BFS/DFS/shortest path)** — the scan state machine is a
  single forward chain; no branching graph exists yet that would need a
  traversal algorithm.
- **Binary search / quickselect** — all in-memory scans use linear
  `filter`/`map`; nothing is large enough, or accessed by index enough, to
  need a search algorithm faster than a scan.
- **Recursion, backtracking, dynamic programming** — every walk in the
  engine is a flat or two-level iterative loop. No overlapping subproblems,
  no constraint search.

Each of these gets its own section below: what it is, why the repo doesn't
need it today, and — concretely, not speculatively — where in the codebase it
would have to land if a specific future feature required it.

## See also

- `.aipe/study-system-design/00-overview.md` — the same repo through the
  architecture lens (layers, boundaries, failure handling). This guide
  covers the algorithms and data structures *inside* those boundaries; that
  guide covers the boundaries themselves. Cross-linked, not duplicated.
