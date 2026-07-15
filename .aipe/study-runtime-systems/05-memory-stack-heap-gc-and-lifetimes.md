# Memory: stack, heap, GC, and lifetimes

### Heap allocation, garbage collection pressure, and object lifetimes — Industry standard (V8/JS memory model), applied to this repo's data-shaping choices

## Zoom out, then zoom in

```
Zoom out — where memory pressure gets created or avoided

┌─ Storage layer ────────────────────────────────────────────────────┐
│  SQLite: findings persisted per-row, NOT the whole catalog           │
└──────────────────────────┬─────────────────────────────────────────────┘
┌─ Service layer ─────────────▼──────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                       │
│  readCatalog builds an in-memory array, bounded by variantLimit        │
│  runChecks / normalizeCatalog: synchronous, bounded, over that array   │
│  money.ts: a heap-allocated Decimal object per arithmetic op            │
│  getAllFindingsForExport: loads ALL findings for one scan into memory  │
└──────────────────────────┬──────────────────────────────────────────────┘
┌─ Process layer ──────────────▼────────────────────────────────────────────┐
│  V8 heap, one per process (web, worker) — GC reclaims what's unreferenced │
└──────────────────────────────────────────────────────────────────────────┘
```

Every allocation in this repo is either (a) explicitly bounded by a configured limit, or (b) unbounded but in practice small because of the numbers involved. This file walks both categories — where the bound is, and where there quietly isn't one yet.

## Structure pass

**Layers:** JS call stack (function frames — not interesting here, nothing recurses deeply) → JS heap (where every object, array, and `Decimal` instance lives) → V8's garbage collector (reclaims heap objects with zero remaining references). The stack layer is genuinely uneventful in this repo; the heap layer is where the real decisions are.

**Axis: cost — what does each allocation choice cost, and who pays it?**

```
  catalogVariantLimit (default 5000)  → bounds readCatalog's array size;
                                        cost is paid ONCE, at read time,
                                        capped regardless of real catalog size

  decimal.js Decimal objects           → cost paid on EVERY money
                                        comparison/arithmetic call — a
                                        heap allocation where a float
                                        primitive would cost nothing,
                                        traded deliberately for precision

  getAllFindingsForExport (no cap)     → cost scales with the scan's
                                        finding count, with NO configured
                                        ceiling of its own — currently
                                        bounded only transitively by
                                        catalogVariantLimit
```

**Seam:** the boundary between "explicitly bounded" and "bounded only because the upstream number happens to be small" is exactly where a future growth in scale (a bigger `catalogVariantLimit`, or a check that emits many findings per variant) would first show up as a real memory problem — worth watching, not yet a problem.

## How it works

### Move 1 — the mental model

You already reason about this every time you decide whether a `.map()` needs pagination or can just render the whole array — an array of 20 todo items costs nothing to hold in memory and re-render; an array of 2 million rows would. The exact same judgment call shows up server-side: is this collection bounded by something you control, or does it grow with whatever the upstream system happens to have?

```
Pattern — bounded vs. unbounded allocation, side by side

  BOUNDED (readCatalog):                 UNBOUNDED-IN-PRACTICE
                                          (getAllFindingsForExport):
  ┌─────────────────────┐                ┌─────────────────────┐
  │ variantLimit = 5000  │                │ findMany({ scanId }) │
  │ loop checks count      │                │ no take/skip at all  │
  │ AGAINST the limit       │                │ size = whatever the │
  │ every iteration          │                │ scan actually found │
  └─────────────────────┘                └─────────────────────┘
     grows to a KNOWN ceiling               grows with scan output
```

### Move 2 — walking the allocation decisions

**The bounded case: `readCatalog`'s in-memory `products` array — `app/app/services/shopify/catalog-reader.server.ts:400-452`.**

```javascript
// app/app/services/shopify/catalog-reader.server.ts:404-406, 424-444 (condensed)
const products: RawProductNode[] = [];
let variantsProcessed = 0;
// ...
for (let i = 0; i < pageNodes.length; i++) {
  const remaining = opts.variantLimit - variantsProcessed;
  const { product, truncated } = await buildProduct(admin, pageNodes[i], remaining, policy);
  products.push(product);
  variantsProcessed += product.variants.nodes.length;

  if (truncated || variantsProcessed >= opts.variantLimit) {
    return { products, /* ..., */ partial: true /* or computed */ };
  }
}
```
Every product pushed onto `products` stays live in memory for the duration of one `readCatalog` call — this whole array is what `runScan` later hands to `normalizeCatalog`. The ceiling on how large that array (and every variant array nested inside it) can grow is `settings.catalogVariantLimit` (default 5000, `app/prisma/schema.prisma`'s `ShopSettings` model), enforced not just at the top level but *inside* `fetchAllVariants`'s own pagination (`catalog-reader.server.ts:309-344`) — so a single pathological product with 50,000 variants can't blow past the budget either. **What breaks if this bound didn't exist:** a merchant with an unusually large catalog (or a buggy/malicious upstream response) could grow this array without limit, and since it's held entirely in memory until the whole read completes — no streaming, no incremental persistence — that's a direct path to the worker process's heap growing unboundedly on one scan.

**The deliberate heap-cost tradeoff: `decimal.js` for money, `app/packages/catalog-checks/src/money.ts`.**

```javascript
// app/packages/catalog-checks/src/money.ts (excerpt)
export function sub(a: Money, b: Money): string {
  return new Decimal(a).minus(new Decimal(b)).toString();
}
export function mul(a: Money, b: Money): string {
  return new Decimal(a).times(new Decimal(b)).toString();
}
```
Every one of these calls allocates *two* `Decimal` objects (one per operand) on the heap, does the operation, and converts back to a string — where a float (`a - b`) would cost nothing beyond a primitive-value operation with no heap allocation at all. This repo's `context.md` states the constraint bluntly: "never use floats/`Number()`/`parseFloat` for price/margin." **The concrete consequence** (not just "this is safer"): if `mul`/`sub`/`marginPercent` ran on JS floats instead, a margin calculation like `0.1 + 0.2` would produce `0.30000000000000004` — a real bug for a product whose entire purpose is flagging pricing/margin problems precisely. The GC cost of allocating a short-lived `Decimal` per operation is the price paid for correctness; at this repo's scale (checks run once per scan, over ≤ `catalogVariantLimit` variants), that cost is trivially absorbed and garbage-collected within the same scan run — these are small, short-lived objects, exactly the case V8's generational GC (the "young generation"/scavenger) is fastest at reclaiming.

**The place with no cap of its own — `getAllFindingsForExport`, `app/app/services/scan/scan-api.server.ts:286-304`.**

```javascript
// app/app/services/scan/scan-api.server.ts:296-301
const rows = await prisma.finding.findMany({
  where: { scanId: scan.id },
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],
});
const findings: FindingRow[] = rows.map(toFindingRow);
```
No `take`, no `skip`, no page size — every `Finding` row for the scan comes back in one array, then gets mapped into a second array (`FindingRow[]`), which then feeds `buildFindingsCsv` (`app/app/services/scan/export.server.ts:15-59`) to build the *entire CSV as one string* before it's ever sent as an HTTP response. Contrast this directly with `getScanFindings` (`scan-api.server.ts:225-275`), which is explicitly paginated — `DEFAULT_PAGE_SIZE = 50`, capped at `MAX_PAGE_SIZE = 200` (`scan-api.server.ts:27-28`). The asymmetry is deliberate, not an oversight: export needs the *complete* result set to produce a correct CSV in one response, while the results-page UI only ever needs one page at a time. **Today, this is fine** — the finding count for one scan is bounded transitively by `catalogVariantLimit` (at most a small multiple of it, since each variant can trigger a handful of the 10 checks), so this array tops out in the low tens of thousands of small objects at worst. **What would make this a real concern:** raising `catalogVariantLimit` substantially, or adding checks that emit many findings per variant, without ever revisiting this export path — at that point, building one giant string in memory (rather than streaming rows to the response as they're formatted) is the first place you'd feel it.

**What this repo does NOT do, by design: retain the whole catalog.** `context.md`'s "data minimization" constraint — "don't retain whole catalog payloads; findings carry only the per-variant fields needed for display/CSV" — shows up concretely in `runner.server.ts:145-180`: the `snapshot.variants` array (the full normalized catalog) is only ever read from during the `findingRows.map(...)` pass to look up each finding's `sku`/`barcode`/`price` via `variantsById` (a `Map` built for O(1) lookup, line 149-151); nothing about `snapshot` itself is persisted. Once `runScan` returns, the entire normalized catalog — the largest in-memory structure this repo ever builds — has zero references left held anywhere, and V8's GC is free to reclaim it. **This is the lifetime that matters most in this repo:** the full catalog snapshot lives for exactly the duration of one scan's pipeline, never longer.

### Move 3 — the principle

The question worth asking of every collection you build in memory isn't "is this fast enough" — it's "what's the ceiling, and who set it." `readCatalog`'s array has an explicit, configured ceiling. `getAllFindingsForExport`'s array has an implicit one, inherited from an upstream bound it doesn't itself enforce. Both are fine right now; only one of them would tell you, on its own, if the assumption ever stopped holding.

## Primary diagram

```
Memory lifetimes across one scan, start to finish

┌─ readCatalog ──────────────────────────────────────────────────────┐
│  products[] grows, bounded by catalogVariantLimit (explicit cap)     │
└──────────────────────────┬────────────────────────────────────────────┘
                            ▼ returned once, consumed once
┌─ normalizeCatalog ──────────▼────────────────────────────────────────────┐
│  snapshot.variants[] — the LARGEST structure this repo builds           │
│  lifetime: exactly this scan's pipeline; zero refs after runScan return │
└──────────────────────────┬────────────────────────────────────────────────┘
                            ▼ read to build findingRows, then dropped
┌─ runChecks → findingRows[] ──▼────────────────────────────────────────────┐
│  small Decimal allocations per money comparison, GC'd almost immediately  │
└──────────────────────────┬────────────────────────────────────────────────┘
                            ▼ persisted to SQLite; JS objects now droppable
┌─ LATER: export ────────────▼────────────────────────────────────────────┐
│  getAllFindingsForExport re-reads ALL findings — no cap of its own,      │
│  bounded only transitively by catalogVariantLimit upstream               │
└────────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This repo doesn't do anything unusual with V8's memory model — no manual heap-size tuning (`--max-old-space-size` isn't set anywhere in `Dockerfile`/`fly.toml`), no `WeakRef`/`FinalizationRegistry`, no attempt to control GC timing. That's the right level of engagement for a workload this size: the interesting memory decisions here are all at the *data-shaping* level (what do you hold onto, for how long, bounded by what) rather than the GC-tuning level, and that's where the effort correctly went.

## Interview defense

**Q: "Where's the biggest object this repo ever builds in memory, and how long does it live?"**
A: `snapshot.variants` inside `runScan` — the fully normalized catalog, bounded by `catalogVariantLimit`. It lives for exactly one scan's pipeline: built by `normalizeCatalog`, read once to enrich `findingRows` with display fields via a `Map` lookup, then never referenced again once `runScan` returns. Nothing persists the whole snapshot — only the enriched `Finding` rows survive to SQLite.
One-line anchor: the biggest allocation here has the shortest deliberate lifetime — built, used once, dropped.

**Q: "Why pay the heap cost of `Decimal` objects instead of using JS floats for money?"**
A: Floating-point arithmetic on money produces representation errors (`0.1 + 0.2 !== 0.3`) that would corrupt exactly the pricing/margin comparisons this app's core checks depend on. The heap allocation cost per operation is trivial at this repo's scale (bounded variant counts, checks run once per scan) — correctness was worth far more here than the GC pressure it costs.
One-line anchor: pick the data type whose failure mode you can't afford, not the one that's cheapest to allocate.

**Q: "`getAllFindingsForExport` has no `take`/`skip` — is that a bug?"**
A: Not today — it's bounded transitively by `catalogVariantLimit`, and a CSV export genuinely needs the complete set in one response, unlike the paginated results-page reads. It's a place to revisit if `catalogVariantLimit` ever grows substantially or a future check starts emitting many findings per variant — at that point it's the first thing that would need streaming instead of one in-memory string.

## See also

- `04-shared-state-races-and-synchronization.md` — the same `catalogVariantLimit` bound this file discusses, from the shared-resource-contention angle.
- `06-filesystem-streams-and-resource-lifecycle.md` — how the CSV built here reaches the HTTP response (unstreamed) and how the Prisma client's own lifetime compares to the objects this file walks.
- `07-backpressure-bounded-work-and-cancellation.md` — `catalogVariantLimit` and `MAX_PAGE_SIZE` as bounded-work mechanisms, not just memory ceilings.
