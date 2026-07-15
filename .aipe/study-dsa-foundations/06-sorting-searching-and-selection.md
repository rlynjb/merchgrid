# 06 — Sorting, searching, and selection

### Comparison sort, binary search, partitioning, and order-statistic selection — Industry standard

## Zoom out, then zoom in

MerchGrid needs an ordered view of data in exactly two places: MG-008 needs
the *median* price within a product to decide if a variant is an outlier,
and the findings API needs every finding *sorted* by severity before it
paginates. Both are selection/ordering problems, and both are solved with
the simplest correct tool — a full sort — rather than a faster
order-statistic algorithm. That's not an oversight; it's the right call at
the sizes involved, and knowing why is the actual lesson.

```
Zoom out — where sorting/searching/selection live

┌─ Engine — money.ts ────────────────────────────────────────────────┐
│  ★ median(): sort a product's prices, pick the middle ★             │
│                                              ← we are here          │
└──────────────────────────┬───────────────────────────────────────┬─┘
                            │ used by mg-008.ts                     │
┌─ Storage layer — SQLite ──▼─────────────────────────────────────────┘
│  ORDER BY severityRank, checkId — a full, multi-key sort, delegated │
│  to the database instead of Array.prototype.sort() in Node          │
└────────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** in-memory selection (one product's variant prices, tiny n) vs.
SQL-delegated sort (potentially every finding in a scan, larger n, but never
loaded into Node all at once).

**Axis to trace: cost — where does the sort actually execute, and how much
data does it touch at once?**

```
"Where does the sort run, and on how much data?" — traced across both

┌─ median() (money.ts) ────────────┐   ┌─ getScanFindings (SQL) ─────────┐
│ runs in: Node, in-memory           │   │ runs in: SQLite's query engine    │
│ data touched: one product's        │   │ data touched: one page at a time  │
│   variants (small, capped by        │   │   (≤200 rows), via an index seek  │
│   Shopify's ~100-variant cap)       │   │   — never the whole result set    │
│ algorithm: full sort, O(n log n)    │   │ algorithm: index-ordered scan,    │
│                                      │   │   effectively free (§04)          │
└──────────────────────────────────────┘   └────────────────────────────────────┘
```

**Seam:** the difference between these two isn't the sorting *algorithm* —
it's *who* holds the data being sorted and *how much* of it at once. Cross
that seam the wrong way (say, load every finding for a scan into Node and
`.sort()` there before paginating) and you'd be re-implementing, badly, work
SQLite's index already does for free — this is exactly the reason the
`scan-api.server.ts` comment at lines 256-261 exists: "spec §11.2: no
in-memory filtering."

## How it works

### Move 1 — the mental model

You know `Array.prototype.sort()` and you know binary search from a phone
book or a sorted leaderboard. The pattern worth naming precisely here is
**selection**: sometimes you don't need the *whole* order, you need one
specific position in it — the median is "the value at the middle position
after sorting," nothing more. A full sort gets you that position (and every
other position, which you throw away), in `O(n log n)`. A dedicated
selection algorithm (quickselect, or median-of-medians for a worst-case
guarantee) gets you *just* that position in `O(n)` average time, by
partitioning instead of fully ordering.

```
Pattern — sort-then-select vs. a dedicated selection algorithm

  sort-then-select (what MerchGrid does):
    [7, 2, 9, 4] → sort → [2, 4, 7, 9] → pick middle → 5.5 (avg of 4,7)
    cost: O(n log n), throws away the "extra" full ordering after use

  quickselect (not used here, the faster alternative for large n):
    [7, 2, 9, 4] → partition around a pivot, recurse into ONLY the half
    that contains the target rank → never fully orders the other half
    cost: O(n) average — but more code, and a worse worst case (O(n²))
    unless you use median-of-medians for a guaranteed O(n)
```

### Move 2 — the walkthrough

**`median()` — sort, then index into the middle.** `money.ts:28-37`:

```ts
// app/packages/catalog-checks/src/money.ts:28-37
export function median(values: Money[]): string {
  const sorted = [...values].map((v) => new Decimal(v)).sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!.toString();                              // odd: exact middle
  }
  return sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2).toString();  // even: average the two middles
}
```

Three moving parts, each with a specific job: (1) `[...values]` copies the
array before sorting — `Array.prototype.sort()` mutates in place, and
mutating the caller's array out from under it would be a silent
side-effect bug; (2) `.sort((a, b) => a.comparedTo(b))` uses `Decimal`'s own
comparator, not the default `Array.prototype.sort()` behavior (which
coerces to strings and would sort `"10"` before `"9"`); (3) the odd/even
branch is the actual selection logic — median is defined differently
depending on parity, and both branches are needed for correctness, not just
one "close enough" case.

**Where `median()` is used — MG-008's outlier detection.**
`mg-008.ts:11-26` groups variants by product first (see
`02-arrays-strings-and-hash-maps.md`), then selects the median *within each
group*:

```ts
// app/packages/catalog-checks/src/checks/mg-008.ts:12-26
const groups = groupBy(ctx.variants, (v) => v.productId);
for (const group of groups.values()) {
  const positive = group.filter((v) => v.price !== null && gt(v.price, "0"));
  if (positive.length < 3) continue;         // guard: median of <3 isn't a meaningful signal

  const prices = positive.map((v) => v.price as string);
  const m = median(prices);                   // selection happens HERE, per group
  const low = mul(m, "0.25");
  const high = mul(m, "4");

  for (const v of positive) {
    const price = v.price as string;
    if (!lt(price, low) && !gt(price, high)) continue;   // outside [0.25×, 4×] median → flag
    // …
  }
}
```

The `positive.length < 3` guard (line 17) is the boundary condition worth
noticing: median is *defined* for any n ≥ 1, but a median computed from two
variants isn't a useful outlier baseline — with two prices, one of them is
always "the outlier" relative to the other, which would make this check
fire constantly on small product families. Three is the minimum n where
"most variants agree, one doesn't" becomes a meaningful pattern rather than
a coin flip.

**Execution trace — median across an odd-sized and even-sized group:**

```
Execution trace — median(["19.99", "24.99", "9.99"])   (odd, n=3)

step 1: map to Decimal, sort by comparedTo
  [9.99, 19.99, 24.99]
step 2: mid = floor(3/2) = 1
step 3: n odd → return sorted[1] = 19.99
result: "19.99"

Execution trace — median(["19.99", "24.99", "9.99", "14.99"])   (even, n=4)

step 1: map to Decimal, sort by comparedTo
  [9.99, 14.99, 19.99, 24.99]
step 2: mid = floor(4/2) = 2
step 3: n even → average sorted[1] and sorted[2]
  (14.99 + 19.99) / 2 = 17.49
result: "17.49"
```

**Multi-key sort, delegated to SQL.** `Array.prototype.sort()` with a
comparator is how you'd write a multi-key sort by hand ("sort by severity
first, then by checkId as a tiebreaker") — MerchGrid never writes that
comparator, because `getScanFindings` hands the same two-key ordering
straight to SQL:

```ts
// app/app/services/scan/scan-api.server.ts:267
orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
```

This is exactly the "first key, then tiebreaker" shape of a hand-written
comparator (`(a, b) => a.rank - b.rank || a.checkId.localeCompare(b.checkId)`),
just expressed declaratively and executed by SQLite against an index built
for that exact column order (`04-trees-tries-and-balanced-indexes.md`).

### Move 3 — the principle

**A full sort is the right tool for selection when n is small or when you
need the whole order anyway — reach for a dedicated selection algorithm
only when n is large AND you provably only need one position.** MerchGrid's
`median()` runs per product group, and Shopify caps a product at 100
variants by default — `n ≤ 100` per call, and `median()` is called once per
product, not once globally. At that n, the constant-factor difference
between `O(n log n)` (full sort) and `O(n)` (quickselect) is unmeasurable;
writing quickselect here would be complexity spent on a problem that doesn't
exist yet.

## Primary diagram

```
Sorting, searching, and selection — the full picture

┌─ median() (money.ts:28-37) ───────────────────────────────────────┐
│  copy → sort by Decimal.comparedTo → O(n log n)                    │
│  odd n: middle element   even n: average of the two middles        │
│  used once per product group inside MG-008, n ≤ ~100                │
└────────────────────────────────────────────────────────────────────┘

┌─ SQL ORDER BY (scan-api.server.ts:267) ───────────────────────────┐
│  orderBy: [severityRank asc, checkId asc]  ← multi-key sort         │
│  executed by SQLite against the B-tree index (§04), not Node        │
│  never loads more than one page (≤200 rows) into memory at once     │
└────────────────────────────────────────────────────────────────────┘

  not yet exercised: binary search, quickselect / median-of-medians,
  partition-based algorithms in application code — every in-memory scan
  in this repo is a linear filter/map, never a search over a sorted
  structure by index.
```

## Elaborate

Sort-then-select is the textbook first move for order-statistic problems,
and it's the correct default until profiling says otherwise — quickselect
earns its complexity when you're repeatedly selecting from large,
in-memory collections where the full sort's `O(n log n)` becomes measurably
worse than `O(n)`. Binary search's absence here is equally instructive: it
accelerates lookups into an already-sorted, randomly-indexable structure,
and MerchGrid never holds such a structure in memory — its arrays are
scanned linearly because they're small, and its large, persisted data lives
in SQLite, which already gives it `O(log n)` lookups via the B-tree index
(`04-trees-tries-and-balanced-indexes.md`) without any application code
needing to implement binary search itself.

## Interview defense

**Q: "Why does `median()` copy the array with `[...values]` before
sorting?"**
A: `Array.prototype.sort()` sorts in place and returns the same array
reference — calling it directly on `values` would mutate whatever array the
caller passed in (in this case, `positive.map((v) => v.price as string)` in
MG-008, which is itself a fresh array, but `median()` doesn't know that
about every caller). Copying first makes `median()` side-effect-free
regardless of what the caller does with `values` afterward — a pure
function contract worth keeping in a package that advertises itself as
zero-I/O and side-effect-free (`app/packages/catalog-checks`).
*(sketch: the execution trace above, step 1 "map to Decimal, sort by
comparedTo")*
One-line anchor: **a "pure" function that mutates its input isn't actually
pure — the defensive copy is what keeps the contract honest.**

**Q: "At what n would you switch `median()` to quickselect?"**
A: Only once profiling showed the sort was a measurable cost — which,
bounded by Shopify's ~100-variant-per-product cap and called once per
product group, it isn't here. Quickselect's payoff is asymptotic (`O(n)`
vs. `O(n log n)`), and asymptotic differences only matter once n is large
enough for the constant factors to stop dominating. At n ≤ 100, the
`O(n log n)` sort and the more complex quickselect would run in
practically the same wall-clock time, so the simpler, easier-to-verify
option wins.
One-line anchor: **big-O differences are a reason to *investigate*, not a
reason to *rewrite*, until the n in your actual system is large enough for
them to matter.**

## See also

- `01-complexity-and-cost-models.md` — the `O(n log n)` cost of `median()`
  in the context of the engine's overall per-check cost model.
- `04-trees-tries-and-balanced-indexes.md` — the B-tree index that makes
  SQL's `ORDER BY` cheap without an in-memory sort.
- `02-arrays-strings-and-hash-maps.md` — the `groupBy` step that runs
  before `median()` in MG-008.
