# Bounded Catalog Read

### Bounded work / soft-limit early-exit pagination — language-agnostic pattern

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  onboarding action: "run a scan"                           │
  └──────────────────────────┬──────────────────────────────────┘
                              │ enqueueScan → worker claims
  ┌─ Service layer ───────────▼──────────────────────────────────┐
  │  runScan()  →  ★ readCatalog() — THE BUDGET LIVES HERE ★     │ ← we are here
  │              →  normalizeCatalog() → runChecks() → persist   │
  └──────────────────────────┬──────────────────────────────────┘
                              │ paginated Admin GraphQL (query only)
  ┌─ Provider layer ───────────▼──────────────────────────────────┐
  │  Shopify Admin API — has no idea a limit exists;              │
  │  would happily hand back every product forever                │
  └────────────────────────────────────────────────────────────────┘
```

Here's the shape: Shopify's product catalog has no upper bound the app controls. A merchant could have 50 products or 500,000. Nothing on Shopify's side stops at "enough" — the app has to decide what "enough" means and enforce it itself, mid-flight, before a single pathological catalog turns one scan into an unbounded amount of GraphQL calls and memory. That's `readCatalog` (`app/app/services/shopify/catalog-reader.server.ts`): a paginated walk over products and variants that carries its own running counter and stops itself.

## The structure pass

**Axis: cost — who owns the ceiling, and where is it enforced?**

```
  One number, four layers, one flip

  ┌─ Data layer ────────────────────────────┐
  │ ShopSettings.catalogVariantLimit = 5000 │  → the ceiling as CONFIGURATION
  │ (schema.prisma:54, merchant-editable)   │     (owned by the shop's settings row)
  └──────────────────┬───────────────────────┘
                      │ read at scan start
  ┌─ Orchestration ────▼───────────────────────┐
  │ runScan(): variantLimit: settings.         │  → just forwards the number
  │   catalogVariantLimit (runner.server.ts:104)│
  └──────────────────┬───────────────────────────┘
                      │ passed as opts.variantLimit
  ┌─ Enforcement ──────▼───────────────────────────┐
  │ readCatalog(): running counter checked AFTER   │  → the ceiling as CODE
  │ every product AND mid-product (catalog-reader   │     (owned by a live loop)
  │  .server.ts:400-452, 320-325)                   │
  └──────────────────┬───────────────────────────────┘
                      │ GraphQL query (no LIMIT-equivalent sent)
  ┌─ Provider ──────────▼───────────────────────────────┐
  │ Shopify Admin API — no concept of this limit exists │  → axis doesn't apply here
  └────────────────────────────────────────────────────────┘
```

The seam that matters is between the data layer and the enforcement layer: the ceiling is *configuration* (a per-shop, merchant-editable number sitting in a database row) until the moment `readCatalog` reads it into a local variable — from there down, it's *code*, a plain running counter with no further reference back to the settings row. Nothing enforces the limit on Shopify's side; the seam between "enforcement" and "provider" is where the axis (who owns the ceiling) simply stops applying — Shopify will hand back however much you ask for, forever.

## How it works

**The mental model:** you've written a `SELECT ... LIMIT 100` before — the database stops materializing rows once it hits the limit, and you never think about it again. This is the same shape, except the "database" is Shopify's Admin API over an external network call, and Shopify doesn't have a `LIMIT` clause for "stop the whole catalog walk once you've handed me N variants total." So the app has to be its own `LIMIT`: keep a running count, and check it before every expensive next step, not just at the end.

```
  Pattern — bounded work with a live running counter

  remaining = LIMIT
  for each page of products:
    for each product in page:
       fetch this product's variants (paginating within IT if needed)
       │
       ▼
       remaining = LIMIT − variantsProcessedSoFar
       ┌─────────────────────────────┐
       │ still have room? ───────────┼── yes → keep going
       │ (checked BEFORE the next    │
       │  expensive sub-fetch, not   │
       │  only after the product)    │
       └──────────────┬──────────────┘
                       │ no
                       ▼
              STOP. mark partial=true.
              return what you have.
```

### The skeleton — what breaks if you remove a part

Three parts, and each is load-bearing on its own:

- **The running counter (`variantsProcessed`).** Drop it and there's nothing to compare against the limit — the walk never knows when to stop. This is the whole mechanism's memory of "how much have I already spent."
- **The check-before-fetch, not just check-after-product.** This is the part people skip when they first write this pattern, and it's the one that actually matters here. Look at `fetchAllVariants` (`catalog-reader.server.ts:309-344`): a single Shopify product can have more than 100 variants, which means it needs its *own* sub-pagination (`PRODUCT_VARIANTS_PAGE_QUERY`, lines 87-115). If the budget were only checked between products — "finished this product, now check the total" — a single pathological product with, say, 50 variant sub-pages could blow straight past the whole catalog-wide limit before the outer per-product check ever fires. That's why line 323 checks `if (nodes.length >= remaining) return { nodes, truncated: true };` **inside** the variant-pagination loop, before issuing the next sub-query — the budget check has to sit at the same granularity as the thing that could blow it.
- **The `truncated`/`partial` flag.** Drop this and a budget-limited scan looks identical to a complete one — the merchant would see "347 findings" with no way to know 4,000 variants were never even read. `readCatalog`'s return value threads `partial: truncated || moreProductsInThisPage || pageInfo.hasNextPage` (line 442) all the way out to the `Scan.partial` column, which the UI surfaces directly: `app/app/routes/app.scans.$id.tsx:558-563` renders a warning banner — "This scan was partial — only the first N variants were reviewed" — whenever that flag is true.

### Where the numbers actually come from, in this repo

```
  Layers-and-hops — the budget's actual journey through the code

  ┌─ ShopSettings (SQLite) ──┐  hop 1: default 5000, merchant-editable
  │ catalogVariantLimit=5000 │ ─────────────────────────────────────►
  └───────────────────────────┘         (schema.prisma:54)
                                            │
  ┌─ runScan() ────────────────────────────▼──────────────────────┐
  │ variantLimit: settings.catalogVariantLimit                     │ hop 2: forwarded
  │ (runner.server.ts:103-104)                                      │  verbatim, once
  └────────────────────────────────────────┬────────────────────────┘
                                            │
  ┌─ readCatalog() ─────────────────────────▼────────────────────────┐
  │ remaining = opts.variantLimit − variantsProcessed                │ hop 3: re-derived
  │ (catalog-reader.server.ts:425), rechecked every product AND      │  every iteration
  │ every variant sub-page (line 323)                                │
  └────────────────────────────────────────┬────────────────────────┘
                                            │ hop 4: last product may
                                            │  come back TRUNCATED
  ┌─ Scan row (SQLite) ─────────────────────▼────────────────────────┐
  │ partial = true → UI banner (app.scans.$id.tsx:558-563)           │
  └───────────────────────────────────────────────────────────────────┘
```

The retry policy that wraps every GraphQL call this loop makes (`resolveRetryPolicy`/`runQuery`, `catalog-reader.server.ts:160-241`) is the *twin* mechanism — it bounds how the app behaves when Shopify says "slow down," not how much data the app is willing to read. See `03-exponential-backoff-with-jitter.md` for that half.

**The principle:** an external system with no upper bound of its own can't be trusted to stop for you — you have to carry the stopping condition yourself, and you have to check it at the same granularity as the thing that could blow past it. A budget checked only at the coarse level (per product) is a budget with a hole in it exactly the size of your finest-grained unbounded operation (one product's own variant pages). This is the same shape as an HTTP client capping total bytes read from a streaming response, or a recursive tree walk carrying a depth counter instead of trusting the tree not to be malicious.

## Primary diagram

```
  Bounded catalog read — full recap

  ShopSettings.catalogVariantLimit (merchant-editable, default 5000)
            │
            ▼
  runScan() reads it once, hands it to readCatalog as opts.variantLimit
            │
            ▼
  ┌─────────────────────────────────────────────────────────┐
  │ readCatalog() loop                                        │
  │  for each product page (100/page):                        │
  │    for each product:                                      │
  │      fetch its variants, paginating within IT if >100      │
  │        ── budget check BEFORE each sub-page fetch ──       │
  │      variantsProcessed += this product's variant count     │
  │      ── budget check AFTER each product ──                 │
  │      if over limit: STOP, mark truncated                   │
  └─────────────────────────────────────────────────────────┘
            │
            ▼
  { products, variantsProcessed, partial } ──► Scan.partial column
                                          ──► UI: "scan was partial" banner
```

## Elaborate

This is the same move as a resource quota anywhere a caller doesn't control the far end's size: a `fetch()` wrapped with a byte-counting `AbortController`, a Kubernetes namespace's CPU/memory quota, or a recursive parser given a max-depth argument so a maliciously nested document can't blow the stack. The common thread is always the same: **the boundary that can't be trusted to self-limit has to be paired with a boundary that enforces the limit from the inside.** Shopify's API is the untrusted-to-self-limit side here — read-only and well-behaved, but with no concept of "this app only wants 5,000 variants."

What to read next: `03-exponential-backoff-with-jitter.md` for the sibling mechanism inside the same file (bounding *retry* cost, not *catalog* cost); `02-sql-side-pagination-and-severity-index.md` for what happens to the bounded catalog once it's turned into findings and needs its *own* pagination story on the way back out to the UI.

## Interview defense

**Q: Why cap the read instead of just paginating through the whole catalog?**
A: Because "the whole catalog" is attacker-shaped from the app's point of view — the app doesn't control how big a merchant's store is, and an unbounded read means unbounded GraphQL call count, unbounded memory for the in-flight `RawCatalog` array, and an unbounded scan duration. Capping it turns "however big the input is" into "however big I decided to allow, ever." One-line anchor: *unbounded input, bounded cost.*

```
  unbounded            bounded
  ┌───────────┐        ┌───────────┐
  │  ??? size │   →    │ ≤ N size  │
  │  no ceiling│        │  ceiling  │
  └───────────┘        └───────────┘
```

**Q: What's the part of this mechanism people forget to build?**
A: The check-before-fetch inside a single product's own sub-pagination (`fetchAllVariants`, line 323), not just between products. If you only check the budget after finishing a whole product, one product with enough variant pages can blow straight through the limit before the coarser check ever runs. The budget check has to live at the same granularity as the loop that could overrun it — that's the load-bearing detail, not the counter itself (the counter is the easy 90%).

**Q: How would you actually verify this holds under load?**
A: Today you can't — there's no fixture at or near the 5,000-variant ceiling and no timing captured (see `audit.md` lens 2). The real answer: seed a catalog at exactly the limit and one variant over it, assert `partial` flips correctly at the boundary, and time the walk to confirm the call count matches what the pagination math predicts (roughly `ceil(products/100) + extra sub-pages`), not an unbounded number.

## See also

- `02-sql-side-pagination-and-severity-index.md` — what happens to the (bounded) catalog's findings on the way back out.
- `03-exponential-backoff-with-jitter.md` — the sibling mechanism in the same file, bounding retry behavior instead of read size.
- `04-linear-time-grouped-checks.md` — why the checks that run over this bounded variant list stay cheap even at the ceiling.
- `audit.md` → lens 1 (performance budget), lens 4 (CPU/memory).
