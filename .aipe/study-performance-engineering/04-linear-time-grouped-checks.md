# Linear-Time Grouped Checks

### Hash-map grouping (group-by) — language-agnostic / DSA fundamental

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Engine layer (app/packages/catalog-checks) ─────────────────┐
  │  runChecks(ALL_CHECKS, ctx) — flatMap over 10 checks           │
  │    mg-002, mg-004, mg-007, mg-010: simple O(n) filter/map      │
  │    mg-005, mg-006, mg-008, mg-009: ★ groupBy first ★           │ ← we are here
  │      (duplicate SKU, duplicate barcode, price outlier,        │
  │       conflicting duplicate-SKU price/cost)                   │
  └──────────────────────────┬──────────────────────────────────────┘
                              │ pure functions, zero I/O
  ┌─ (bounded input from) ────▼──────────────────────────────────────┐
  │  NormalizedVariant[] — at most catalogVariantLimit (default 5000)│
  └────────────────────────────────────────────────────────────────────┘
```

Four of the ten checks need to answer a "does this variant share something with another variant" question — the same SKU, the same barcode, or the same product (to compare prices within it). The naive way to answer that is to compare every variant against every other variant. All four checks instead build one hash map first and only ever compare variants *within the same bucket* — the difference between an operation count that grows with the square of the catalog and one that grows linearly with it.

## The structure pass

**Axis: cost — how does the operation count grow as the variant count (n) grows?**

```
  Same question, two shapes, one flip

  ┌─ what you'd write first ──────────┐      ┌─ what's actually shipped ─────────┐
  │ for each variant i:                │      │ for each variant: bucket it by key │
  │   for each variant j:               │      │   (ONE pass, ONE Map)              │
  │     compare i and j                 │  →   │ for each bucket: check IF it has  │
  │                                     │      │   ≥2 members (or compute a median) │
  │ cost: O(n²) comparisons             │      │ cost: O(n) to build + O(bucket)   │
  └──────────────────────────────────────┘      │   per bucket ≈ O(n) total          │
                                                └──────────────────────────────────────┘
```

The seam is the `groupBy` helper itself (`app/packages/catalog-checks/src/checks/_helpers.ts:32-48`) — a single, shared function that all four checks call instead of each one hand-rolling its own comparison loop. That's the one place the axis flips from "pairwise" to "bucketed," and because it's shared, the flip only had to be gotten right once.

## How it works

**The mental model:** you've built exactly this shape before. `Graph.ts`'s adjacency list (from your DSA portfolio) is a `Map<string, Node[]>` where each key buckets the nodes reachable from it — you build the buckets once, in one pass, instead of checking every pair of nodes for an edge. `groupBy` here is the identical structure: a `Map<string, Variant[]>` where the key is a normalized SKU, a normalized barcode, or a product id, and each bucket holds every variant that shares that key. Build the buckets once (O(n)); then checking each bucket for a problem — "does this bucket have 2+ members," "what's this bucket's median price" — costs time proportional to *that bucket's own size*, never the whole catalog's.

```
  Pattern — bucket once, then scan buckets instead of pairs

  variants: [v1(sku=A), v2(sku=B), v3(sku=A), v4(sku=C)]

  build phase (one pass, O(n)):
    Map {
      "A" → [v1, v3]     ← same key, same bucket
      "B" → [v2]
      "C" → [v4]
    }

  check phase (per bucket, O(bucket size)):
    bucket "A" has 2 members → FLAG v1 and v3 as duplicates
    bucket "B" has 1 member  → nothing to flag
    bucket "C" has 1 member  → nothing to flag

  total work: O(n) to build + O(n) to scan all buckets combined = O(n)
  (never O(n²) — v1 was never compared against v2 or v4 at all)
```

### The skeleton — three parts, each load-bearing

- **The key function.** `normalizeSku` and `normalizeBarcode` (`_helpers.ts:50-60`) trim and lowercase before using the value as a Map key — get this wrong (compare raw, un-normalized strings) and `"ABC-123"` and `"abc-123"` land in different buckets, silently missing a real duplicate. This is a correctness detail hiding inside a performance mechanism: the bucketing is only as good as the key it buckets on.
- **The null-key skip — an easy detail to miss on a first read.** `groupBy`'s loop does `const key = keyFn(item); if (key === null) continue;` (`_helpers.ts:38-40`), and both `normalizeSku`/`normalizeBarcode` deliberately return `null` for an empty/blank value (`_helpers.ts:53, 58`) rather than `""`. Without that, every variant with a missing SKU would bucket together under the key `""` and get flagged as duplicates of each other — a false-positive storm on exactly the variants this data is *least* reliable for. The null-skip is what keeps "no SKU" from silently becoming "the same SKU."
- **Bucketing on the right key, per check.** `mg-008` (price-outlier detection, lines 7-43) groups by `productId`, not by SKU or barcode — on purpose. Comparing a variant's price only against its *own product's* other variants is both the only comparison that makes business sense (different products have different price scales) and the one that keeps the math local to a small bucket instead of computing one global median across the whole catalog. `mg-008`'s bucket-then-`median()` step (`money.ts:28-37`, called at `mg-008.ts:20`) only ever sorts the handful of variants within one product, never the full variant list.

### The code, side by side

`app/packages/catalog-checks/src/checks/_helpers.ts:32-48` — the one function all four checks share:

```ts
export function groupBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null) continue;          // ← the null-key skip
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;                          // ← O(n) total, one pass
}
```

`mg-006.ts:11` (duplicate barcode) and `mg-005.ts:11` (duplicate SKU) both call it identically — bucket, then flag any bucket with `length >= 2`. `mg-009.ts:19` (conflicting duplicate-SKU price/cost) buckets the same way, then checks whether the bucket's members *disagree* on price/cost rather than just counting them. `mg-008.ts:12` buckets by `productId` instead, then computes a `median()` per bucket and flags outliers against it (`gt`/`lt` against `median × 0.25` / `median × 4`, lines 20-26) — same kernel, different per-bucket work.

```
  Execution trace — mg-006 over four variants, two sharing a barcode

  variants:  v1(barcode="111")  v2(barcode="222")  v3(barcode="111")  v4(barcode="333")

  step 1: groupBy iterates in order —
    v1 → groups = { "111": [v1] }
    v2 → groups = { "111": [v1], "222": [v2] }
    v3 → groups = { "111": [v1, v3], "222": [v2] }        ← bucket "111" grows
    v4 → groups = { "111": [v1, v3], "222": [v2], "333": [v4] }

  step 2: scan each bucket's length —
    "111" → length 2 → FLAG v1 and v3
    "222" → length 1 → nothing
    "333" → length 1 → nothing

  total comparisons made between variants: ZERO — every decision came from bucket
  membership and bucket length, never a direct v-vs-v comparison
```

**What this actually buys at the repo's real ceiling:** `ShopSettings.catalogVariantLimit` defaults to 5,000 (`schema.prisma:54`, see `01-bounded-catalog-read.md`). A naive pairwise comparison at 5,000 variants is `n(n-1)/2 ≈ 12.5 million` comparisons *per check*. The `groupBy` approach is ~5,000 map operations to build the buckets plus a linear scan of the buckets' combined size — roughly **2,500× fewer operations at the ceiling this app actually enforces**, for each of the four checks that use it. And because `runChecks` (`app/packages/catalog-checks/src/run.ts:26-28`) runs all ten checks via one `.flatMap`, the whole engine's total cost is `O(checks × n)`, not `O(checks × n²})` — one slow check can't quietly make the others' cost worse, because none of them share state or comparisons across each other.

**The principle:** any "find things that share a property" problem is an O(n²) problem in disguise if you reach for nested loops first — and an O(n) problem the moment you notice the shared property *is* a valid hash-map key. The cost of building the map (one hash + one insert per item) is paid once; the payoff is that every subsequent "does X relate to Y" question becomes "are X and Y in the same bucket," which is exactly what a `Map` is built to answer in O(1). This is the same move as "group anagrams" or "two sum" from a DSA curriculum, applied to real catalog data instead of an interview prompt.

## Primary diagram

```
  Linear-time grouped checks — full recap

  NormalizedVariant[] (≤5,000, bounded by 01-bounded-catalog-read)
              │
              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  groupBy(variants, keyFn)   — ONE shared function          │
   │    mg-005 → keyFn = normalizeSku                            │
   │    mg-006 → keyFn = normalizeBarcode                        │
   │    mg-008 → keyFn = productId                               │
   │    mg-009 → keyFn = normalizeSku                             │
   └──────────────────────────┬─────────────────────────────────┘
                              ▼
              Map<string, Variant[]>  (buckets)
                              │
              ┌───────────────┴────────────────┐
              ▼                                 ▼
   length ≥ 2 → flag duplicates        median() + threshold → flag outliers
   (mg-005, mg-006, mg-009)            (mg-008, within-bucket only)

   total cost across all 4 checks: O(n) — never O(n²)
```

## Elaborate

This is the textbook hash-map bucketing tradeoff — the same move behind "group anagrams," "two sum," and every "find duplicates/pairs/groups" problem in a DSA curriculum: pay a hashing cost once per item, in exchange for never comparing every item against every other item. It generalizes past checks entirely — it's the same reasoning behind a compiler's symbol table (bucket declarations by name instead of re-scanning the whole program per lookup), or a database's hash join (bucket one table by join key instead of a nested-loop join across both tables).

What to read next: `01-bounded-catalog-read.md` for the mechanism that keeps `n` itself capped, which is *why* even the O(n) cost here stays cheap in practice; `.aipe/study-dsa-foundations/` for the general hash-map/grouping primitive if you want the data-structure view instead of this applied-cost view.

## Interview defense

**Q: Why hash-map grouping instead of a nested-loop comparison?**
A: Because a nested loop pays `O(n²)` to answer "does this share something with any other item," and a hash map pays `O(n)` to build buckets plus `O(bucket size)` to check each one — at this repo's 5,000-variant ceiling that's roughly 5,000 operations instead of 12.5 million, per check. One-line anchor: *trade a hash cost once for skipping the pairwise comparison entirely.*

```
  nested loop (O(n²))              hash-map grouping (O(n))
  ┌─────────────────┐              ┌─────────────────┐
  │ compare EVERY    │              │ bucket ONCE,      │
  │ pair (i, j)      │      vs      │ then scan buckets  │
  │ n=5000 → 12.5M   │              │ n=5000 → ~5000    │
  └─────────────────┘              └─────────────────┘
```

**Q: What's the part of this people forget to build?**
A: The null-key skip. It's tempting to bucket on the raw field value directly — but then every variant with a *missing* SKU or barcode lands in the same `""` bucket and gets flagged as a duplicate of every other variant with no SKU, which is exactly backwards (missing data isn't a duplicate signal). `groupBy` explicitly skips `null` keys, and `normalizeSku`/`normalizeBarcode` return `null` for blank values specifically so this false-positive storm can't happen.

**Q: How would you actually verify the O(n) claim holds, today?**
A: You can't from evidence in this repo — the golden eval (`test/eval-fixtures.test.ts`) checks correctness against 17 small fixtures, not operation count or timing at scale, and no test asserts that runtime grows linearly rather than quadratically as n increases (see `audit.md` lens 2 and lens 4). The real answer: time `runChecks` against fixture sets at, say, 500 / 2,500 / 5,000 variants and confirm the growth curve is linear, not quadratic — that comparison doesn't exist yet.

## See also

- `01-bounded-catalog-read.md` — the mechanism that caps `n` itself, which is why this file's O(n) cost stays cheap in absolute terms.
- `02-sql-side-pagination-and-severity-index.md` — what happens to these findings once they're persisted and need their own pagination story.
- `.aipe/study-dsa-foundations/` — the general hash-map/grouping primitive.
- `audit.md` → lens 4 (CPU/memory and allocation).
