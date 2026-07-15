# 01 — Complexity and cost models

### Big-O time/space analysis, amortized cost, and choosing the right cost model — Industry standard

## Zoom out, then zoom in

Every one of MerchGrid's ten checks runs against the same input: a
`CatalogSnapshot`, an in-memory array of every variant a merchant sells,
capped by `catalogVariantLimit` (default 5000). Before you can reason about
any single check, you need to know what "cost" even means here — is it the
number of variants? The number of GraphQL calls to Shopify? The number of
times a check has to re-scan the same array? Different mechanisms in this
repo answer to different cost models, and picking the wrong one makes every
design choice look arbitrary.

```
Zoom out — where cost models get decided

┌─ Service layer — worker process ────────────────────────────────┐
│  catalog-reader.server.ts: readCatalog()                         │
│  ★ cost model = "bounded by variantLimit budget, not by how big  │
│    the merchant's actual catalog is" ★              ← we are here│
└──────────────────────────┬────────────────────────────────────┬─┘
                            │ NormalizedVariant[]                │
┌─ Engine — @merchgrid/catalog-checks ─────────────────────────┐  │
│  run.ts: runChecks()  → 10 × O(n) or O(n log n) passes        │  │
│  _helpers.ts: groupBy() → single O(n) pass, O(n) space        │  │
│  money.ts: median() → O(n log n) time (sort), decimal-exact   │  │
└────────────────────────────────────────────────────────────────┘  │
                            │ persisted findings                    │
┌─ Storage layer — SQLite ──────────────────────────────────────────▼┐
│  cost model flips here: O(log n) index lookups, not O(n) scans     │
└──────────────────────────────────────────────────────────────────┘
```

Complexity analysis isn't academic box-ticking here — it's the reason
`catalog-reader.server.ts` stops paginating instead of reading a merchant's
entire 200,000-SKU catalog into memory, and it's the reason `getScanFindings`
does its sorting in SQL instead of loading every finding into Node and
calling `.sort()`.

## Structure pass

**Layers:** UI (renders a page of findings) → service (worker executes the
pipeline, one pass per check) → engine (pure functions, in-memory arrays) →
storage (SQLite, indexed).

**Axis to trace: cost — what does one unit of work cost, and what bounds it?**

```
One axis, four layers — "what bounds the cost of one unit of work?"

┌─ UI ───────────┐   ┌─ Service ──────────┐  ┌─ Engine ─────────┐  ┌─ Storage ─┐
│ page render:   │   │ catalog read:      │  │ each check:      │  │ query:    │
│ bounded by     │   │ bounded by         │  │ bounded by n =   │  │ bounded   │
│ pageSize       │   │ variantLimit       │  │ variants in this │  │ by index  │
│ (≤200 rows)    │   │ (5000, a business  │  │ scan (already    │  │ (B-tree,  │
│                │   │ decision, not a    │  │ capped upstream) │  │ O(log n)) │
│                │   │ memory limit)      │  │                  │  │           │
└────────────────┘   └────────────────────┘  └──────────────────┘  └───────────┘
```

**Seam:** the boundary between "bounded by an explicit budget" (service
layer) and "bounded by whatever n happens to be" (engine layer) is the one
that matters. The engine's checks make no attempt to bound their own input —
they trust the service layer already capped it. If that trust boundary ever
moved (say, the engine got called with an un-capped catalog), every `O(n)`
and `O(n log n)` check in this file quietly becomes `O(5000)` no more —
across every check, that's the whole story. This is why the guardrail lives
where it does, not scattered across ten checks.

## How it works

### Move 1 — the mental model

You already know the shape: every algorithm has a cost, and "cost" is a
function of input size. What's easy to skip is that **the input size isn't
always "how much data exists" — sometimes it's "how much data you decided to
let in."** MerchGrid's engine checks are honest textbook complexity (`n` =
variants in the array). The service layer above them is a different game:
it enforces a *budget*, and the budget — not the merchant's actual catalog
size — is what n is bounded by.

```
Pattern — two different meanings of "n"

  merchant's real catalog:  [ ................................ ]  (unbounded)
                                          │
                                          │ readCatalog() enforces
                                          │ variantLimit as a hard stop
                                          ▼
  what the engine ever sees:  [ ...... ]  n ≤ catalogVariantLimit (5000)
                                          │
                                          │ groupBy / filter / sort
                                          ▼
  cost of any single check:   O(n) or O(n log n), n ≤ 5000 — always
```

### Move 2 — the walkthrough

**Bounded iteration, not unbounded traversal — the pagination guardrail.**
You've built `fetch()` loops before; this is the same idea with a budget
attached. `readCatalog` in
`app/app/services/shopify/catalog-reader.server.ts:400-452` pages through
Shopify's GraphQL API 100 products at a time, and re-checks the remaining
budget after every product:

```ts
// app/app/services/shopify/catalog-reader.server.ts:424-444
for (let i = 0; i < pageNodes.length; i++) {
  const remaining = opts.variantLimit - variantsProcessed;
  const { product, truncated } = await buildProduct(
    admin, pageNodes[i], remaining, policy,
  );
  products.push(product);
  productsProcessed += 1;
  variantsProcessed += product.variants.nodes.length;

  if (truncated || variantsProcessed >= opts.variantLimit) {
    // stop — budget spent, mark the catalog partial
    return { products, productsProcessed, variantsProcessed, partial: /* … */ };
  }
}
```

`remaining` is recomputed every iteration (line 425) — this is what makes it
a *budget check*, not a fixed loop count. Even the sub-pagination inside one
product (`fetchAllVariants`, lines 309-344) re-checks `remaining` before
issuing another page request (line 323: `if (nodes.length >= remaining)
return { nodes, truncated: true }`). That's the boundary condition that
breaks if you remove it: without the inner re-check, one pathological
product with 50,000 variants could blow the whole budget by itself before
the outer loop ever gets a chance to stop it.

**One pass, one grouping — `groupBy`'s cost shape.** `_helpers.ts:32-48`
builds a `Map<string, T[]>` in a single `for` loop:

```ts
// app/packages/catalog-checks/src/checks/_helpers.ts:32-48
export function groupBy<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {          // one pass, O(n)
    const key = keyFn(item);
    if (key === null) continue;
    const group = groups.get(key) ?? []; // O(1) average lookup
    group.push(item);
    groups.set(key, group);              // O(1) average insert
  }
  return groups;
}
```

Time: `O(n)`. Space: `O(n)` — every item lands in exactly one bucket, so the
total size of all buckets combined equals the input size. This is the cost
model every dedup check (MG-005, MG-006, MG-009) and the outlier check
(MG-008) inherits for free. Four checks, one grouping cost paid four
separate times (once per check, since nothing caches the grouping across
checks) — that's a deliberate simplicity-over-micro-optimization tradeoff:
`runChecks` (`run.ts:26-28`) treats each check as independent and stateless,
so re-grouping is the price of not coupling ten checks together through a
shared cache.

**Execution trace — `groupBy` on three variants, keyed by normalized SKU:**

```
Execution trace — groupBy(variants, v => normalizeSku(v.sku))

input:  [ {sku:"ABC-1"}, {sku:"abc-1 "}, {sku:"XYZ-2"} ]

step | item processed      | key computed | groups Map after this step
-----|----------------------|--------------|----------------------------------
 1   | {sku:"ABC-1"}        | "abc-1"      | { "abc-1" → [v1] }
 2   | {sku:"abc-1 "}       | "abc-1"      | { "abc-1" → [v1, v2] }   ← same
     |                      |              |   bucket: normalization made
     |                      |              |   "ABC-1" and "abc-1 " collide
 3   | {sku:"XYZ-2"}        | "xyz-2"      | { "abc-1" → [v1, v2],
     |                      |              |   "xyz-2" → [v3] }

result: 3 items in, O(n) time, 2 buckets — MG-005 then flags v1 and v2
because their bucket has length ≥ 2 (mg-005.ts:15).
```

The trace is the whole lesson for why `normalizeSku` (`_helpers.ts:50-54`)
runs *before* the key goes into the map, not after grouping: `groupBy`
itself has no idea what a SKU is — it only compares key strings for
equality. Correctness (catching "ABC-1" and "abc-1 " as duplicates) is
entirely a string-canonicalization decision made by the caller, not a
property of the grouping algorithm. See
`02-arrays-strings-and-hash-maps.md` for that half.

**Decimal arithmetic as a cost-model decision, not a style rule.**
`money.ts` never calls `Number()` or `parseFloat()` on a price. Every
comparison (`lt`, `gt`, `eq`) and the `median()` calculation goes through
`decimal.js`:

```ts
// app/packages/catalog-checks/src/money.ts:28-37
export function median(values: Money[]): string {
  const sorted = [...values].map((v) => new Decimal(v)).sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!.toString();
  return sorted[mid - 1]!.plus(sorted[mid]!).dividedBy(2).toString();
}
```

This is a complexity concept even though it reads like a bug-avoidance rule:
floating-point comparison is *not exact* — `0.1 + 0.2 === 0.3` is `false` in
IEEE 754. If MG-002 ("selling price below unit cost") used floats, its cost
model would include an invisible error term that grows with every
arithmetic operation. Using `decimal.js` trades a constant-factor
performance cost (arbitrary-precision arithmetic is slower than native
floats) for an *exact* comparison — the right tradeoff here, because n never
gets large enough for the constant factor to matter, and being wrong about
whether a merchant is losing money on every sale is unacceptable at any n.

### Move 3 — the principle

**The cost model you should reason about is the one enforced at the trust
boundary, not the one the algorithm's Big-O implies in isolation.** `O(n)`
means nothing until you know what bounds `n`. In MerchGrid, `n` is bounded
twice — once by `variantLimit` at the Shopify-read boundary, once implicitly
by "this is a batch job, not a hot request path" — and both boundaries are
architectural decisions, not accidents of the math.

## Primary diagram

```
Complexity and cost models — the full picture

┌─ merchant's real catalog (unbounded) ─────────────────────────────┐
│  could be 200,000 variants                                         │
└──────────────────────────┬──────────────────────────────────────┬─┘
     readCatalog() enforces │ variantLimit budget (default 5000)   │
     re-checked every page  ▼                                       │
┌─ engine input: n ≤ 5000 ──────────────────────────────────────────┴┐
│  groupBy(): O(n) time, O(n) space, single pass, Map-backed          │
│  median(): O(n log n) time (sort), decimal-exact comparisons        │
│  runChecks(): 10 × independent O(n) or O(n log n) passes            │
└──────────────────────────┬──────────────────────────────────────────┘
     persisted, indexed     │
┌─ SQLite query layer ──────▼─────────────────────────────────────────┐
│  cost model flips to O(log n) index lookup + O(pageSize) scan       │
│  (getScanFindings: ORDER BY severityRank, checkId — SQL does the    │
│  sort, Node never holds more than one page in memory)               │
└──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "budget, not input size" cost model shows up anywhere a system talks to
an external API it doesn't control the size of — rate-limited third-party
APIs, paginated cursors, GraphQL cost throttling (which `runQuery` in
`catalog-reader.server.ts` also handles, via exponential backoff on Shopify's
`THROTTLED` errors — a cost-model concern in its own right: retries add
latency cost in exchange for reliability, capped by `RETRY_MAX_DELAY_MS` so
the retry cost itself stays bounded). The general lesson — that a cost model
worth reasoning about is the one enforced at a boundary, and that "n" is a
policy decision as often as it's a fact about the world — transfers directly
to anything you build that reads from someone else's system: an ANN index
that caps `topK`, a crawler that caps page-depth, an LLM call that caps
`max_tokens`.

## Interview defense

**Q: "Walk me through the time complexity of `groupBy`, and why does it
matter that duplicate-detection checks use it instead of, say, a nested
loop comparing every pair?"**
A: `groupBy` is `O(n)` — one pass, `Map.get`/`.set` are O(1) average. A
nested-loop pairwise comparison (`for each variant, for each other variant,
compare keys`) is `O(n²)`. At `n ≤ 5000` (the enforced budget), that's the
difference between 5,000 operations and 25,000,000. The reason it matters
here specifically: four separate checks (MG-005/006/008/009) each run their
own `groupBy` pass, so an `O(n²)` choice would be paid four times per scan.
*(sketch: the execution-trace diagram above, buckets forming in one pass)*
One-line anchor: **the hash map is what turns "duplicate detection" from a
pairwise problem into a single-pass problem.**

**Q: "The engine checks don't validate that the input isn't too large. Isn't
that a bug?"**
A: No — it's a deliberate trust boundary. The engine (`@merchgrid/catalog-checks`)
is a pure, zero-I/O package by design (see `app/packages/catalog-checks`);
bounding input size is a *policy* decision (how big a catalog should we
process per scan?), and policy belongs in the service layer, which is
exactly where `readCatalog`'s `variantLimit` guardrail lives. Pushing the
check into the engine would duplicate policy logic that can change (the
limit is even configurable per-shop via `ShopSettings.catalogVariantLimit`)
into a package that's supposed to stay pure and reusable.
One-line anchor: **the cap lives at the boundary that owns the policy, not
in every function that happens to receive the data.**

## See also

- `02-arrays-strings-and-hash-maps.md` — the data structure `groupBy` is
  built on, and the string-canonicalization half of the correctness story.
- `06-sorting-searching-and-selection.md` — `median()`'s `O(n log n)` cost
  and why a full sort, not quickselect, is the right call at this n.
- `.aipe/study-system-design/01-single-worker-db-queue.md` — the
  service-layer boundary that enforces the budget this file reasons about.
