# 02 — Arrays, strings, and hash maps

### Indexed sequences, string canonicalization, sets/maps, and collision tradeoffs — Industry standard

## Zoom out, then zoom in

Take away every domain concept from MerchGrid — prices, SKUs, margins — and
what's left is three primitives repeated constantly: an **array** of
variants you iterate over, **strings** you have to compare *as if* they were
the same value even when they're not byte-identical ("ABC-1" vs. "abc-1 "),
and a **hash map** that turns "find everything that shares this key" from an
`O(n²)` problem into an `O(n)` one. This is the substrate every check in the
engine is built from.

```
Zoom out — where arrays/strings/maps live

┌─ Engine — @merchgrid/catalog-checks ──────────────────────────────┐
│  ctx.variants: NormalizedVariant[]        ← the array              │
│  normalizeSku / normalizeBarcode          ← string canonicalization│
│  ★ groupBy(): Map<string, T[]> ★          ← the hash map            │
│                                              (we are here)          │
└──────────────────────────┬─────────────────────────────────────────┘
                            │ CatalogFinding[]
┌─ Storage layer — csv.ts / severity.ts ────────────────────────────┐
│  escapeCsvField(): regex-based string escaping                    │
│  buildSearchText(): string join + lowercase for SQL `contains`     │
└──────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** raw Shopify strings (GID, price string, SKU) → normalized
strings (canonical form) → grouped structure (`Map<string, T[]>`) → findings.

**Axis to trace: state — where does the canonical form of a value live, and
who's responsible for producing it?**

```
"Who owns the canonical form of this string?" — traced across layers

┌─ raw ────────────┐  ┌─ normalize.ts ─────┐  ┌─ _helpers.ts ─────────┐
│ sku: " ABC-1"    │→ │ nullIfBlank(): trims│→ │ normalizeSku(): trims │
│ (whatever         │  │ blank→null only,    │  │ AND lowercases        │
│ Shopify returns)  │  │ preserves case      │  │ (comparison-specific) │
└──────────────────┘  └─────────────────────┘  └───────────────────────┘
   Shopify owns it       NormalizedVariant        groupBy's caller owns
                         owns the display form      the comparison form
```

**Seam:** `NormalizedVariant.sku` (produced once, in `normalize.ts`) is
*display* canonical — trimmed, blank-to-null, but still case-preserving,
because the UI and CSV export want to show the SKU the merchant actually
typed. `normalizeSku`/`normalizeBarcode` in `_helpers.ts` produce a
*second*, stricter canonical form — lowercased too — used only as a
`groupBy` key. That's a real seam: two different "normalized" forms of the
same field, deliberately not unified, because unifying them would mean
either showing merchants a lowercased SKU they didn't type, or letting
case-different duplicates slip past dedup checks. Miss this seam and you'd
"simplify" it into a bug.

## How it works

### Move 1 — the mental model

You've built a `.map()` with a `key` prop a thousand times — the array half
of this is nothing new. The hash-map half is the same idea you get from a
JS/TS `object` or `Map`: give it a key, get back a bucket, in roughly
constant time regardless of how many other keys exist. The pattern that
makes MerchGrid's dedup checks work is **grouping**: instead of asking "is
this variant a duplicate of any other variant?" (which needs to compare
every pair), you ask "which bucket does this variant's key belong to, and is
that bucket bigger than one?" — the map turns an `O(n²)` question into an
`O(n)` one.

```
Pattern — bucket-then-inspect

  variants:  [ v1(sku=A) v2(sku=B) v3(sku=A) v4(sku=C) v5(sku=B) ]
                    │        │        │         │         │
                    └───┬────┘        │         └────┬────┘
                        ▼              ▼              ▼
              Map: "a" → [v1,v3]   "c" → [v4]   "b" → [v2,v5]
                        │                              │
                bucket size ≥ 2 → flag             bucket size ≥ 2 → flag
```

### Move 2 — the walkthrough

**Arrays — filter/map/flatMap as the default traversal.** Most checks never
touch `groupBy` at all; they're a straight linear scan. MG-001
(`mg-001.ts:12-15`) is the clearest example:

```ts
// app/packages/catalog-checks/src/checks/mg-001.ts:12-15
return ctx.variants
  .filter((v) => v.productStatus === "ACTIVE" && v.price !== null)  // O(n)
  .filter((v) => lte(v.price as string, "0"))                        // O(n)
  .map((v) => findingFor(v, ctx, { /* … */ }));                      // O(n)
```

Three linear passes chained — still `O(n)` overall (three passes, not
nested), and each pass is easy to read in isolation. This is the
skeleton-parts lesson: what breaks if you collapse it into one `.filter()`
with a compound condition? Nothing breaks functionally — it's a readability
choice, not a correctness one. Contrast that with MG-003
(`mg-003.ts:12-45`), which uses an explicit `for...of` loop instead of
chained array methods because it needs an early `continue` mid-iteration (to
skip variants MG-002 already claimed) — chaining doesn't compose as cleanly
once you need to short-circuit per item.

**Strings — canonicalization is where correctness lives, not the map.**
`_helpers.ts:50-60`:

```ts
// app/packages/catalog-checks/src/checks/_helpers.ts:50-60
export function normalizeSku(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim().toLowerCase();   // canonical comparison form
  return trimmed === "" ? null : trimmed;    // blank → null, not ""
}

export function normalizeBarcode(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim();                  // trimmed, but NOT lowercased
  return trimmed === "" ? null : trimmed;     // barcodes are case-sensitive
}
```

Notice the asymmetry: `normalizeSku` lowercases, `normalizeBarcode` doesn't.
That's not an inconsistency — SKUs are merchant-chosen text where "ABC-1"
and "abc-1" are the same item to a human; barcodes are machine-scanned
values (UPC/EAN) where case doesn't even apply the same way, and merchants
typing a barcode by hand rarely introduce case variance the way they do with
SKUs. The `groupBy` call downstream is *completely blind* to this — it just
does `Map.get(key)`/`Map.set(key, …)`. Get the normalization wrong (e.g.
group by raw `v.sku` instead of `normalizeSku(v.sku)`) and MG-005 silently
stops catching "ABC-1" vs. "abc-1 " as duplicates — not because the map
broke, but because two different strings that should collide, don't.

**GID parsing — string splitting as a decode step.** `numericId` in
`normalize.ts:51-54` turns a Shopify GID into the numeric id the rest of the
app uses:

```ts
// app/packages/catalog-core/src/normalize.ts:51-54
export function numericId(gid: string): string {
  const segments = gid.split("/");             // ["gid:", "", "shopify", "Product", "456"]
  return segments[segments.length - 1] ?? gid;  // last segment, or the whole string as fallback
}
```

`"gid://shopify/Product/456".split("/")` → `["gid:", "", "shopify",
"Product", "456"]`, and `segments[segments.length - 1]` picks off `"456"`.
The `?? gid` fallback matters: if `split` somehow returns an empty array (it
can't, in practice, for a non-empty string, but the type system doesn't know
that), returning the original string is safer than crashing on
`undefined`.

**Sets — a `ReadonlySet` for O(1) membership.** `state.ts:17-20` uses a
`Set`, not an array, for terminal-status membership:

```ts
// app/app/services/scan/state.ts:17-20
const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set(["COMPLETED", "FAILED"]);
```

`.has()` on a `Set` is `O(1)` average — the same underlying hash-table
mechanism as `Map`, just without a value attached to each key. With only two
elements the performance difference from `.includes()` on an array is
unmeasurable; the reason to reach for `Set` here is what it *communicates*:
"this is a membership check with no duplicates and no order," not "this is
an ordered, possibly-repeating collection." The data structure choice is
documentation.

**Execution trace — CSV field escaping, a string state machine over
characters:**

```ts
// app/packages/catalog-checks/src/csv.ts:43-48
export function escapeCsvField(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
```

```
Execution trace — escapeCsvField on two inputs

input: 'Blue, Size M'
  test /[",\r\n]/  → true (comma present)
  replace /"/g → no quotes to double
  result: '"Blue, Size M"'                     ← wrapped, unchanged inside

input: 'Widget "Pro" Edition'
  test /[",\r\n]/  → true (quote present)
  replace /"/g with '""' → 'Widget ""Pro"" Edition'
  result: '"Widget ""Pro"" Edition"'           ← wrapped AND quotes doubled
```

This is RFC 4180 escaping: a field needs quoting when it contains a comma,
quote, or newline, and every internal quote doubles. Skip the doubling step
and a SKU like `Widget "Pro"` would corrupt the CSV's column boundaries the
moment a spreadsheet tool tries to parse it back.

### Move 3 — the principle

**A hash map's correctness is only as good as the key function feeding it.**
`Map`/`Set` guarantee O(1) average lookup for whatever key you hand them —
they make no promise that two values a human considers "the same" will
produce the same key. That promise is the caller's job, and in this repo
it's concentrated in exactly two small functions (`normalizeSku`,
`normalizeBarcode`) that every dedup check shares. Get the canonicalization
right once, and every check built on `groupBy` inherits it for free.

## Primary diagram

```
Arrays, strings, and hash maps — the full picture

  raw Shopify string (case/whitespace as typed)
             │
             ▼
  ┌─ normalize.ts: nullIfBlank ──────────┐   display-canonical
  │  trim, blank → null                  │   (NormalizedVariant.sku)
  └──────────────────┬────────────────────┘
                      │ separate, stricter pass
                      ▼
  ┌─ _helpers.ts: normalizeSku/Barcode ──┐   comparison-canonical
  │  trim (+ lowercase for SKU only)     │   (groupBy key only)
  └──────────────────┬────────────────────┘
                      │ keyFn
                      ▼
  ┌─ _helpers.ts: groupBy ────────────────┐
  │  Map<string, T[]>, O(n) build          │
  │  "abc-1" bucket: [v1, v2]  ← collide   │
  └──────────────────┬────────────────────┘
                      │ bucket.length ≥ 2 → finding
                      ▼
              CatalogFinding[] → csv.ts escapes strings on the way out
```

## Elaborate

Hash grouping is one of the oldest tricks in the book precisely because it
generalizes so well: "bucket by a key, then inspect the buckets" is the same
move behind SQL's `GROUP BY`, a compiler's symbol table, and a rate limiter's
per-user counter map. The part that's easy to under-teach is the
canonicalization half — a hash map with a bad key function is a
*silently* wrong hash map, not a crashing one, because it never throws; it
just under-groups. That's why this repo keeps `normalizeSku`/
`normalizeBarcode` as small, named, unit-testable functions instead of
inlining `.trim().toLowerCase()` at each call site — the normalization rule
is a decision worth being able to point at.

## Interview defense

**Q: "Why does `normalizeSku` lowercase but `normalizeBarcode` doesn't?"**
A: Different real-world semantics. SKUs are merchant-authored strings where
case is cosmetic to a human but meaningless to the business — "ABC-1" and
"abc-1" refer to the same product. Barcodes are scanned/standardized values
(UPC/EAN) where the two normalization concerns (whitespace vs. case) don't
carry the same risk profile, so the code only trims. It's a deliberate,
field-specific canonicalization rule, not a missed case.
*(sketch: the "who owns the canonical form" structure-pass diagram above)*
One-line anchor: **canonicalization rules are business rules, not a
generic string-utility default.**

**Q: "What's the time complexity of `groupBy`, and what would break it?"**
A: `O(n)` time, `O(n)` space — one pass, `Map.get`/`.set` are O(1) average.
What breaks it: a `keyFn` that isn't actually a function of comparison
identity — e.g. if `keyFn` returned something non-deterministic, or included
whitespace/case that should have been stripped, buckets would fracture
(false negatives — duplicates that don't collide) rather than the algorithm
failing loudly.
One-line anchor: **the map does the O(n) work; the key function decides
whether that work is correct.**

## See also

- `01-complexity-and-cost-models.md` — the cost side of `groupBy`; this
  file is the data-structure and correctness side.
- `03-stacks-queues-deques-and-heaps.md` — the other data structures in this
  repo (a `ReadonlySet`, a DB-backed queue) and the ones missing (heaps).
- `06-sorting-searching-and-selection.md` — what happens after grouping in
  MG-008, where `median()` operates on one bucket's array.
