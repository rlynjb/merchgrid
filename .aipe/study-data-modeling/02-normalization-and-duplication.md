# Normalization and duplication

### Normalization / Denormalization — Single Source of Truth vs read-optimized copy — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where duplication decisions get made

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  results table reads Finding rows as-is, no re-derivation │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Service layer ───────────▼────────────────────────────────┐
  │  runner.server.ts persists the copies AT WRITE TIME         │
  │  ★ THIS CONCEPT ★ — the decision of what to copy and why    │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Storage layer ───────────▼────────────────────────────────┐
  │  Finding table carries copies of Scan.shopId and of the     │
  │  live-at-scan-time variant fields                           │
  └──────────────────────────────────────────────────────────┘
```

Normalization is information hiding applied to data: one fact, one place it's editable, everything else reads through a reference. Denormalization breaks that on purpose, trading a single source of truth for read speed or read-completeness. This repo has three real instances of duplicated data on `Finding`, and they are not all justified the same way — that's the point of this file.

## Structure pass

**Axis: is the copy still true after it's made, and does anything read it back?**

```
  Three duplications, one axis: "does the copy stay correct, and is it read?"

  minimumMarginPercentUsed (Scan)     → SNAPSHOT — correct by design, always read
  price/unitCost/sku/etc. (Finding)   → SNAPSHOT — correct by design, always read
  severityRank / searchText (Finding) → DERIVED  — recomputable, always read
  shopId (Finding)                    → COPY     — correct (never changes), NEVER read
```

The seam: three of the four duplications earn their keep by being read on a hot path (`getScanFindings`, the CSV export, the settings history). The fourth — `Finding.shopId` — is correct in the sense that it can never drift (a finding's shop never changes), but it fails the "is it read" half entirely. That's the difference between a deliberate denormalization and dead weight that happens to also be harmless.

## How it works

### Case 1: `minimumMarginPercentUsed` — a snapshot, not a duplicate

**Bridge from what you know:** this is the same pattern as an invoice line item storing the unit price at time of sale instead of a live foreign key to the current product price — the invoice must never change because the catalog price changed later.

```ts
// app/app/services/scan/queue.server.ts:70-77
return prisma.scan.create({
  data: {
    shopId,
    status: "QUEUED",
    apiVersion: CATALOG_API_VERSION,
    minimumMarginPercentUsed: shop.settings.minimumMarginPercent,  // ← copied at enqueue time
  },
});
```

```ts
// app/app/models/settings.server.ts:45-49 (comment, verbatim intent)
// Only ShopSettings is updated; existing Scan rows keep the
// minimumMarginPercentUsed they were created with, so past scans
// are unaffected by later threshold changes.
```

This is **not** a normalization violation, even though the same fact (a margin percentage) exists in two tables at once. `ShopSettings.minimumMarginPercent` answers "what threshold applies to a *new* scan"; `Scan.minimumMarginPercentUsed` answers "what threshold did *this specific historical scan* actually check against." Those are two different facts that happen to share a data type. Collapsing them into one column would make every past scan's findings silently reinterpret themselves the moment a merchant changes their margin setting — which is exactly the bug this design avoids.

### Case 2: `Finding`'s display-field copy — a point-in-time snapshot, justified by data minimization

```ts
// app/app/services/scan/runner.server.ts:145-180
// Keyed by variantId so each persisted finding can be denormalized with
// its variant's price/cost/sku/etc (spec §9.5/§9.6: CSV export and the
// finding-detail UI need these self-contained on the finding, since we
// deliberately do not persist the whole catalog).
const variantsById = new Map(
  snapshot.variants.map((v) => [v.variantId, v] as const),
);

const findingRows = findings.map((f) => {
  const variant = f.variantId ? variantsById.get(f.variantId) : undefined;
  return {
    ...
    price: variant?.price ?? null,
    compareAtPrice: variant?.compareAtPrice ?? null,
    unitCost: variant?.unitCost ?? null,
    currencyCode: variant?.currencyCode ?? null,
    sku: variant?.sku ?? null,
    barcode: variant?.barcode ?? null,
    productStatus: variant?.productStatus ?? null,
    ...
  };
});
```

Here's the load-bearing constraint that makes this the right call: there is no `Catalog` or `Variant` table in this schema at all. The full catalog snapshot that `readCatalog` fetches from Shopify (`app/app/services/shopify/catalog-reader.server.ts`) is never persisted — only the flagged variants, and only the fields needed to render or export them, survive past the scan run. That's a deliberate trade named in `.aipe/project/context.md`: *"Data minimization. Don't retain whole catalog payloads."* The alternative — a normalized `Variant` table joined from `Finding` — would mean persisting every variant in the merchant's catalog (thousands of rows) to support displaying the handful that got flagged. This denormalization isn't an optimization layered on top of a "proper" normalized design; it's the only design that satisfies the minimization constraint at all.

The cost, named without flinching: if a merchant fixes a price *after* a scan completes, the finding still shows the old price — it's a snapshot, not a live view. That's correct behavior for an audit report (you want to know what was wrong *when the scan ran*), but it does mean "export CSV" three days after a scan can show stale numbers. Nothing in the UI currently warns about that; it's an honest gap, not a bug.

### Case 3: `severityRank` / `searchText` — derived columns for SQL-native sort and search

**Bridge from what you know:** this is the same move as adding a `slug` column so you can `ORDER BY slug` instead of computing a slug from `title` in application code on every read — pre-computing at write time so the database can do the sort/filter instead of the app.

```ts
// app/app/services/scan/severity.ts:13-39
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  UNAVAILABLE: 2,
};

export function severityToRank(severity: string): number {
  return SEVERITY_RANK[severity as FindingSeverity] ?? SEVERITY_RANK.UNAVAILABLE;
}

export function buildSearchText(
  parts: Array<string | null | undefined>,
): string {
  return parts
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}
```

Both are 100% recomputable from `severity` and `productTitle`/`variantTitle`/`sku`/`barcode` — nothing here is a fact that could ever disagree with its source. They're stored anyway, at persist time (`runner.server.ts:162,178`), so that `getScanFindings` can do this:

```ts
// app/app/services/scan/scan-api.server.ts:264-270
const total = await prisma.finding.count({ where });
const rows = await prisma.finding.findMany({
  where,
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],   // ← SQL ORDER BY, not JS .sort()
  skip: (page - 1) * pageSize,
  take: pageSize,
});
```

Without `severityRank`, sorting "CRITICAL, WARNING, UNAVAILABLE" (not alphabetical) would require pulling every matching row into memory and sorting in JS before paginating — which defeats pagination entirely, since you can't `LIMIT`/`OFFSET` in SQL and then re-sort correctly. Without `searchText`, the free-text search (`where.searchText = { contains: search }`, `scan-api.server.ts:261`) would need to concatenate and lowercase four fields per row in application code, again before the database could filter — the exact in-memory-filtering pattern the code comment explicitly rules out (`// spec §11.2: no in-memory filtering`).

This is the correct denormalization: single source of truth stays in `severity`/`productTitle`/etc, the derived columns are write-time cache invalidated by construction (they're only ever written once, at scan-persist time, never updated independently), and the payoff (SQL-native sort/filter/paginate) is real and exercised on every results-page load.

### Case 4: `Finding.shopId` — the one that isn't earning its keep

```ts
// app/prisma/schema.prisma:88-91
// Intentional denormalization: shopId is duplicated here (no relation/index
// by design) so shop-scoped finding queries and retention cleanup can filter
// without joining through Scan. Do not "fix" this into a relation.
shopId       String
```

```ts
// app/app/services/scan/runner.server.ts:157-159
return {
  scanId,
  shopId: shop.id,        // ← populated on every persisted finding
  ...
```

The comment states a real justification — avoiding a join through `Scan` for shop-scoped queries and a future retention job — and it's a legitimate reason to denormalize *if* those queries exist. They don't, yet: a repo-wide search for `shopId` used in any `Finding`-scoped `where` clause returns nothing, and there is no retention/cleanup job in the codebase at all (grepping for `cleanup`, `retention`, `cron` across `app/app` turns up nothing that touches `Finding`). This is a documented, correct, never-wrong copy — it just isn't spent yet. Call it what it is: **forward-looking denormalization, not yet exercised.** It costs one `TEXT` column and one extra field to populate per finding; that's cheap enough that leaving it in place until the retention job actually ships is a reasonable bet, but it shouldn't be mistaken for an active optimization the way `severityRank`/`searchText` are.

## Primary diagram

```
  The four duplications, ranked by whether they're actually spent

  ┌────────────────────────────┬───────────┬───────────┬─────────────────┐
  │ field                      │ kind      │ read?     │ verdict         │
  ├────────────────────────────┼───────────┼───────────┼─────────────────┤
  │ minimumMarginPercentUsed   │ snapshot  │ yes       │ correct, active │
  │ price/sku/unitCost/etc.    │ snapshot  │ yes       │ correct, active │
  │ severityRank / searchText  │ derived   │ yes       │ correct, active │
  │ Finding.shopId             │ copy      │ NO        │ dead weight     │
  └────────────────────────────┴───────────┴───────────┴─────────────────┘
```

## Elaborate

The general principle this repo demonstrates well: denormalization is a bet you place against a specific, named read pattern — and the bet only pays off once that read pattern actually exists and runs. `severityRank`/`searchText` show the bet paying off immediately (the pagination/search code that needs them shipped in the same commit as the columns, per migration `20260715172521_finding_search_rank`). `Finding.shopId` shows the same bet placed *before* the read pattern exists — which isn't wrong, but it's worth being honest that "documented intent" and "exercised optimization" are different states. The DB-analog of information hiding (`.aipe/study-software-design/`) is the same call: a fact should have exactly one place that's the source of truth, and every copy should be justified by a concrete consumer, not a hypothetical one.

## Interview defense

**Q: Isn't storing the same margin percentage on both `ShopSettings` and `Scan` a normalization bug?**
A: No — they answer different questions. `ShopSettings.minimumMarginPercent` is "what threshold applies now"; `Scan.minimumMarginPercentUsed` is "what threshold did this specific historical run check against." Collapsing them would let a settings change retroactively reinterpret every past scan's findings.

```
  ShopSettings.minimumMarginPercent = 25   (current, changeable)
  Scan#7.minimumMarginPercentUsed   = 20   (frozen at the moment Scan#7 was enqueued)
```

**Q: `severityRank` is 100% derivable from `severity` — why store it at all?**
A: So the database can `ORDER BY severityRank` in SQL, which is required for correct pagination — sorting by "CRITICAL before WARNING before UNAVAILABLE" isn't alphabetical, so without a stored rank you'd have to pull every row into memory, sort in JS, and lose `LIMIT`/`OFFSET`. It's cache-invalidation-free because it's written once, at persist time, and never updated independently of `severity`.

**Q: What's the weakest denormalization in this schema?**
A: `Finding.shopId`. The comment justifying it (avoid a join for shop-scoped queries and retention cleanup) is a real reason to denormalize, but neither of those consumers exists yet — grep confirms zero `where` clauses filter `Finding` by `shopId`. It's harmless (a copy of a fact that never changes can't drift) but it's schema weight ahead of its own justification.

## See also

- `01-the-data-model-and-its-shape.md` — where these fields sit on the `Finding` entity.
- `03-indexing-vs-query-patterns.md` — `severityRank`/`searchText` only pay off because they're also indexed; see the composite index that makes the sort free.
- `.aipe/study-software-design/` — information hiding in code; this file is that same discipline applied to rows and columns.
