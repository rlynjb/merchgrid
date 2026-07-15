# 08 — DSA foundations practice map

### A ranked learning plan: exercised concepts first, missing foundations second — Project-specific

## Zoom out, then zoom in

Seven files back, you walked complexity models, arrays/strings/hash maps,
queues/heaps, trees/indexes, graphs, sorting/selection, and recursion/DP —
each grounded in this repo or honestly marked absent. This file is the map
back down to a practice plan: what to drill first because you'll recognize
it immediately in code you already understand, and what to drill next
because it's the highest-leverage gap between what MerchGrid exercises and
what a growing version of it would need.

```
Zoom out — this file's place in the guide

┌─ Files 01-07 — the seven concept areas ────────────────────────────┐
│  each: pattern + repo evidence + honest "not yet exercised"          │
└──────────────────────────┬──────────────────────────────────────┬─┘
                            │ ranked and sequenced                 │
┌─ This file — the practice map ─────────────────────────────────────┘
│  ★ exercised-first, then gap-ranked, anchored to your reincodes    │
│    portfolio where it already covers a gap ★        ← we are here  │
└────────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** what MerchGrid exercises today (files 01-07's grounded
sections) → what your existing `reincodes` DSA portfolio already covers →
what's genuinely missing from both.

**Axis to trace: readiness — for each concept, do you have a working
implementation to point to, and does this repo give you a live example to
reason from?**

```
"Do you have BOTH a repo example AND your own implementation?" — four cells

┌────────────────────┬─────────────────────────┬─────────────────────────┐
│                     │ repo example: YES        │ repo example: NO        │
├────────────────────┼─────────────────────────┼─────────────────────────┤
│ your own impl: YES  │ hash grouping, decimal    │ heaps/priority queues,   │
│                     │ arithmetic, sorting        │ graph BFS/DFS,           │
│                     │                             │ BSTs — you've built      │
│                     │                             │ these, just not HERE     │
├────────────────────┼─────────────────────────┼─────────────────────────┤
│ your own impl: NO   │ state machines as graphs, │ tries, backtracking,     │
│                     │ B-tree indexes (schema,   │ tabulated DP —           │
│                     │ not app code)              │ genuinely new ground     │
└────────────────────┴─────────────────────────┴─────────────────────────┘
```

**Seam:** the top-right cell — things you've already built in `reincodes`
but that MerchGrid never needed — is the highest-leverage practice target,
not the bottom-right. You already have working `BinaryHeap.ts`,
`PriorityQueue.ts`, `Graph.ts`/`Graph2.ts` with BFS/DFS/Dijkstra, and
`BinarySearchTree.ts`. The practice that pays off fastest is connecting
those existing implementations to a *concrete* MerchGrid extension point —
not re-learning the data structure, but learning to recognize when a real
codebase's requirements shift enough to need it.

## How it works

### Move 1 — the mental model

You already know how to prioritize a backlog: rank by leverage (how much
does this unblock) not by difficulty or by what's freshest in memory. This
practice map is that same ranking applied to DSA gaps — sequenced by "how
close is this to something you've already built," then by "how directly
does this connect to a named, real extension point in this repo," rather
than by textbook chapter order.

```
Pattern — the ranking funnel

  all seven concept areas
         │
         ▼
  ┌───────────────────┐
  │ exercised in repo?│──yes──► rank by "how load-bearing is it" (file 00's
  └─────────┬─────────┘         ranked findings already did this)
            │ no
            ▼
  ┌───────────────────┐
  │ already built in   │──yes──► HIGH-LEVERAGE PRACTICE: wire it to a named
  │ reincodes?          │         MerchGrid extension point (this file, below)
  └─────────┬─────────┘
            │ no
            ▼
  ┌───────────────────┐
  │ genuinely new       │──────► LOWER PRIORITY: study the pattern here,
  │ ground              │         practice it standalone before connecting it
  └───────────────────┘         to any repo
```

### Move 2 — the ranked plan

**Tier 1 — exercised here, understand these first (they're the fastest
path to reading the rest of this codebase fluently).**

1. **Hash grouping (`groupBy`)** — `02-arrays-strings-and-hash-maps.md`.
   Four checks depend on it. Understanding one function
   (`_helpers.ts:32-48`) unlocks MG-005, MG-006, MG-008, MG-009 at once.
2. **State machine as a directed graph** — `05-graphs-and-traversals.md`.
   `state.ts`'s `assertTransition` is the single place correctness of the
   entire scan pipeline is enforced.
3. **Decimal arithmetic as a correctness-not-just-performance cost model**
   — `01-complexity-and-cost-models.md`. `money.ts` is small, but getting
   *why* it exists wrong (treating it as a style preference instead of a
   correctness boundary) means missing the most consequential design
   decision in the engine.
4. **Sort-then-select for median** — `06-sorting-searching-and-selection.md`.
   The clearest "right-sized tool for the n you actually have" example in
   the repo.
5. **B-tree index behind `ORDER BY`** — `04-trees-tries-and-balanced-indexes.md`.
   Not code you'll write, but understanding it is what tells you why
   `getScanFindings` never needs an in-memory sort.

**Tier 2 — you've already built the data structure; the gap is connecting
it to a repo like this one.** This is the highest-leverage practice tier,
because the DSA work is done — the practice is architectural judgment.

6. **Heaps / priority queues.** You have `BinaryHeap.ts` and
   `PriorityQueue.ts` (heap-backed, with `updatePriority`) already built and
   proven inside your Dijkstra animation. MerchGrid's `severityRank` +
   SQL `ORDER BY` (`03-stacks-queues-deques-and-heaps.md`) is a *precomputed,
   static* priority order — it never needs `updatePriority` because nothing
   re-prioritizes a finding after it's written. **Practice exercise:**
   design (on paper, or as a real prototype) a "live top-10 most-severe
   findings across all shops" feature that updates as scans complete
   concurrently — that's exactly the shape that needs your
   `PriorityQueue`'s `updatePriority`, not a static SQL sort.
7. **Graph traversal (BFS/DFS).** You have `Graph.ts`/`Graph2.ts` with BFS,
   DFS, and Dijkstra already built. MerchGrid's state graph
   (`05-graphs-and-traversals.md`) is a single chain — small enough that
   `assertTransition`'s lookup replaces a traversal entirely. **Practice
   exercise:** extend `state.ts`'s graph on paper with a `PAUSED` status
   reachable from `RUNNING_CHECKS`, resumable to either `RUNNING_CHECKS` or
   `FAILED`; write the reachability check ("can a `PAUSED` scan ever reach
   `COMPLETED`?") as a BFS over the edge list instead of eyeballing a
   4-entry map — the point where a lookup table stops being enough.
8. **Binary search trees.** You have `BinarySearchTree.ts` (insert, search,
   delete, all three traversals, successor/predecessor) already built.
   Nothing in MerchGrid needs an in-memory ordered structure — `04` covers
   why a persisted B-tree index does that job instead. **Practice
   exercise:** none needed against this repo specifically; this is a case
   where the gap is genuinely "not yet exercised" with no near-term
   attachment point, and that's fine to name honestly rather than force.

**Tier 3 — genuinely new ground, not covered by `reincodes` or by this
repo.** Lower priority than Tier 2 because there's no existing
implementation to connect — this is where new study time, not
connection-practice, pays off.

9. **Tries.** No prefix-search feature exists or is implied here.
   **Where you'd practice it:** standalone (autocomplete over a word list,
   IP-routing-table lookups) — MerchGrid has no natural attachment point
   until (if ever) it grows SKU type-ahead search.
10. **Backtracking.** `07-recursion-backtracking-and-dynamic-programming.md`
    names the concrete future attachment point: a "Bulk AI" changeset
    preflight validating a batch of proposed changes against constraints
    (no duplicate SKUs, no zero-priced active variants) is a
    constraint-satisfaction shape — try an assignment, detect a violation,
    backtrack. Worth a standalone drill (N-Queens or Sudoku-style) before
    it's needed for real.
11. **Dynamic programming (tabulation).** Your existing DSA notes are
    strong on recursion-with-memoization; tabulation (bottom-up, iterative
    DP) and true 0/1-knapsack-shaped optimization are the specific gap.
    **Where you'd practice it:** the same hypothetical from `07` — an
    "optimal set of price adjustments under a total-change budget" feature
    is a knapsack problem, and knapsack is the standard DP teaching example
    for exactly that reason.

### Move 3 — the principle

**Rank practice by leverage, not by textbook order: what's already built
and just needs a repo to attach to beats what's genuinely unstudied, and
what's load-bearing in the repo you're actually reading beats what's merely
present.** The fastest path to being dangerous in this specific codebase is
Tier 1; the fastest path to closing your portfolio's real gaps is Tier 2,
precisely because the DSA work there is already proven — reincodes did it —
and what's missing is the judgment call of recognizing when a requirement
has shifted enough to need it.

## Primary diagram

```
DSA foundations practice map — the full ranking

TIER 1 — exercised here, learn these to read this repo fluently
  1. groupBy (hash grouping)         → 4 checks depend on it
  2. state machine as directed graph → the pipeline's correctness boundary
  3. decimal arithmetic              → correctness, not just performance
  4. sort-then-select (median)       → right-sized tool for the actual n
  5. B-tree index behind ORDER BY    → why no in-memory sort is needed

TIER 2 — you've built the DS; practice is connecting it to a real repo
  6. heaps/priority queues  (have: BinaryHeap.ts, PriorityQueue.ts)
     → practice: live top-10-severity feature needing updatePriority
  7. graph BFS/DFS          (have: Graph.ts, Graph2.ts, Dijkstra)
     → practice: extend state.ts with a branch, then BFS reachability
  8. BSTs                   (have: BinarySearchTree.ts)
     → no near-term attachment point in this repo — honestly noted

TIER 3 — genuinely new ground, no existing implementation to connect
  9.  tries                 → standalone drill; no repo attachment point yet
  10. backtracking           → attaches to a future "Bulk AI" preflight feature
  11. tabulated DP           → attaches to a future price-optimization feature
```

## Elaborate

This ranking is a snapshot, not a permanent verdict — the moment MerchGrid
(or its planned "Bulk AI" sibling) grows a feature that needs Tier 2 or
Tier 3 vocabulary, that concept moves from "practice against a hypothetical"
to "grounded in real code," and the next run of this generator should pick
that up and re-rank accordingly (see the UUID rule in `me.md`'s two-pass
discipline: this is a curriculum-style guide, so on UPDATE the discipline is
simpler than the audit-style two-pass shape — reconcile each concept file's
"exercised" vs. "not yet exercised" sections against current code, and move
anything newly exercised out of this practice map's gap list).

## Interview defense

**Q: "You've built a heap-backed priority queue before — why does
MerchGrid not use one?"**
A: Because MerchGrid's only "priority" need is a static, precomputed
severity rank, sorted once via an indexed SQL `ORDER BY` for pagination —
not a live structure that needs `updatePriority` after insertion. A heap
earns its keep when priorities *change* after items enter the structure, or
when you need "give me the current max" without re-sorting everything. If
MerchGrid grew a live cross-shop severity dashboard, that's exactly where my
`PriorityQueue.ts` (heap-backed, with `updatePriority`) would apply
directly.
*(sketch: the four-cell readiness grid from the structure pass)*
One-line anchor: **the data structure isn't missing because I don't know
it — it's absent because the current access pattern (sorted page reads,
never live re-prioritization) doesn't need it yet.**

**Q: "How would you sequence learning the gaps in this guide?"**
A: Not by textbook order — by leverage. First, the concepts this specific
repo already exercises (hash grouping, the state-machine graph, decimal
arithmetic), because they make the existing code legible immediately.
Second, gaps where I already have a proven implementation elsewhere
(heaps, graph traversal) and the practice is architectural judgment, not
re-learning the data structure. Last, genuinely new ground (tries,
backtracking, tabulated DP) where there's no existing implementation to
connect yet, so standalone drills come before any attempt to force a repo
connection that isn't there.
One-line anchor: **rank by what's already proven and just needs a real
attachment point — that's the fastest route to closing a genuine gap.**

## See also

- `00-overview.md` — the ranked findings and `not yet exercised` list this
  file's Tier 1/2/3 sequencing is built from.
- `03-stacks-queues-deques-and-heaps.md`, `05-graphs-and-traversals.md` —
  the two Tier-2 concept files with the most direct connection to your
  existing `reincodes` implementations.
- `07-recursion-backtracking-and-dynamic-programming.md` — the Tier-3
  concepts and their named future attachment points.
