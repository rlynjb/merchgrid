# 03 — Engine/app boundary

**Port (`CatalogCheck` contract) / pure core, hexagonal-style boundary.** Industry standard pattern (ports and adapters) — project-specific implementation (`app/packages/catalog-core`, `app/packages/catalog-checks`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Service layer (worker + web, both processes) ─────────────────┐
│  runner.server.ts: normalizeCatalog(raw) → runChecks(checks,ctx) │
│  app.scans.$id.tsx: ALL_CHECKS[].name/.description (display only)│
└──────────────────────────┬───────────────────────────────────────┘
                            │  in-process function calls, no network
┌─ Engine layer ─────────────▼───────────────────────────────────┐
│  @merchgrid/catalog-core     ★ THIS CONCEPT ★  ← we are here    │
│  @merchgrid/catalog-checks   (zero I/O, zero Shopify/Prisma)     │
└────────────────────────────────────────────────────────────────┘
```

Everything else in this repo either talks to Shopify or talks to SQLite. These two packages talk to neither. `packages/catalog-checks/package.json:20-23` lists exactly two dependencies — `@merchgrid/catalog-core` and `decimal.js` — nothing that reaches a network or a database. That's not an accident of what got imported; it's an enforced boundary.

## Structure pass

**Axis: dependency — who depends on whom, and which way does the arrow point?** The app (`runner.server.ts`, the UI routes) depends on the engine. The engine depends on nothing app-shaped — no Prisma types, no Shopify SDK, no Remix. That's dependency inversion in its plainest form: the reusable logic doesn't know the thing calling it exists.

**Seam:** the `CatalogCheck` interface (`contract.ts:27-32`) is the actual contract — a port in the standard sense. Anything that satisfies `{ id, name, description, run(ctx) => CatalogFinding[] }` is a valid check; `runChecks` (`run.ts:26-28`) doesn't care how a check is implemented, only that it matches the shape. The seam is load-bearing because the *trust* axis flips across it: inside the engine, everything is pure and synchronous; outside, the app trusts the engine's output without re-validating it (the `CatalogFinding[]` it gets back goes straight to the `Finding` table via `runner.server.ts`).

```
Trust flips at the port

axis traced = "what does each side have to verify?"

┌─ app side ──────────────┐  seam: CatalogCheck   ┌─ engine side ───────┐
│ trusts engine output      │ ═══════╪════════════► │ verifies its own     │
│ verbatim into the DB       │ (interface shape)      │ inputs (types, decimal)│
└─────────────────────────────┘                        └─────────────────────┘
```

## How it works

You've translated code between Vue and React before, and between Python and TypeScript — the concept survives the framework. This is the same discipline applied inside one codebase: the *checking logic* (is this price below cost? is this SKU missing?) shouldn't know or care whether it's being called from a Remix worker today or a completely different runtime tomorrow (context.md names the actual future consumer: a planned "MerchGrid: Bulk AI" product that reuses this same engine for changeset preflight).

### The kernel — isolate it

```
Engine boundary kernel

  RawCatalog (Shopify GraphQL shape)
       │
  normalizeCatalog(raw, ctx) ──► CatalogSnapshot { variants: NormalizedVariant[] }
       │                              (catalog-core)
       ▼
  runChecks(ALL_CHECKS, ctx) ──► CatalogFinding[]
       │                              (catalog-checks)
       ▼
  handed back to the app, which persists it (see 02)
```

**What breaks if the engine imported Prisma directly:** every check would need a live database connection to run at all, which kills the "planned future Bulk AI product reuses this same engine" story from context.md, and it kills testability — the engine's own test suite (83 tests, per context.md) runs with zero database, zero Shopify mocks, because there's nothing to mock.

### The port — a interface any check must satisfy

```ts
// contract.ts:27-32
export interface CatalogCheck {
  id: string;
  name: string;
  description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
```

Ten concrete implementations (`checks/mg-001.ts` … `mg-010.ts`) each satisfy this shape; `run.ts:13-24` just lists them in an array. Adding an eleventh check means writing one more object matching `CatalogCheck` and appending it to `ALL_CHECKS` — nothing about the runner, the worker, or the persistence layer needs to change. That's the payoff of the port: the *set of checks* is an implementation detail behind a stable interface.

### The driver — `runChecks` doesn't know what a check does

```ts
// run.ts:26-28
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

Three lines, and that's the entire "check runner." It takes a list of checks and a context, and flattens whatever findings come back. It has no knowledge of pricing rules, margin math, or barcode formats — that all lives inside each individual check. **What breaks if you inlined all 10 checks' logic into this function instead:** you'd lose the ability to test a single check in isolation (each check's own test file targets just its `run()`), and you'd lose the "port" property entirely — there'd be nothing left to satisfy or swap.

### The input side — normalization is the other half of the boundary

`normalizeCatalog` (in `catalog-core`) converts Shopify's raw GraphQL node shapes (`RawProductNode`/`RawVariantNode`) into `NormalizedVariant`s the checks actually operate on — so no check ever has to know what a Shopify GraphQL response looks like. Called once, at the top of `runner.server.ts:118-123`, right after `readCatalog` returns:

```ts
// runner.server.ts:118-123
const snapshot = normalizeCatalog(raw, {
  shopId: shop.id,
  shopDomain: shop.shopDomain,
  currencyCode,
  apiVersion: CATALOG_API_VERSION,
});
```

This is the same dependency-inversion move applied to the *input* side: checks depend on `NormalizedVariant`, never on `RawVariantNode`. If Shopify's GraphQL shape changes in a future API version, only `normalizeCatalog` needs to change — none of the 10 checks do.

### The money boundary — a purity rule enforced inside the engine itself

Every check that touches price/cost math uses `money.ts`'s `decimal.js`-backed helpers, never a raw JS number — this is context.md's explicit "never floats for money" constraint, and it's enforced by convention *inside* the same pure-engine boundary, not by the app layer. That's worth noting because it shows the engine boundary isn't just "no I/O" — it's also where a domain-correctness rule (decimal money) is centralized once instead of re-implemented at every call site.

## Move 2.5 — current state vs. future state

```
Phase A (today)                      Phase B (planned: MerchGrid Bulk AI)
────────────────────                  ─────────────────────────────────────
one consumer: the scan worker          a second consumer: changeset preflight
imports catalog-core + catalog-checks   imports the SAME two packages
compiled to dist/, aliased to src/      no engine code changes required —
  in tests (package.json scripts)        the whole point of the boundary

  what doesn't have to change: contract.ts, run.ts, any of the 10 checks.
  what would be new: a second app-layer caller with its own I/O.
```

## Move 3 — the principle

A pure core stays reusable exactly as long as it refuses every temptation to import the thing that's calling it. The moment `catalog-checks` imports `@prisma/client` "just to look up a setting," the whole reuse story (Bulk AI, easier testing, swappable callers) collapses — not gradually, but immediately, because now every caller needs a Prisma client just to construct a check context.

## Primary diagram

```
Full recap — the boundary and its two directions

  Shopify GraphQL response (RawCatalog)
        │
        ▼
┌─ Engine: catalog-core ─────────────┐
│  normalizeCatalog() → CatalogSnapshot│
└──────────────────┬───────────────────┘
                    │ NormalizedVariant[]
┌─ Engine: catalog-checks ───────────▼───┐
│  CatalogCheck (port) × 10 implementations│
│  runChecks() → CatalogFinding[]           │
└──────────────────┬────────────────────────┘
                    │ findings, verbatim
┌─ App: runner.server.ts ───────────▼──────┐
│  persists via one $transaction (see 02)    │
└───────────────────────────────────────────┘

  zero arrows point INTO the engine boxes from Prisma/Shopify/Remix.
```

## Elaborate

This is the same shape as hexagonal architecture / ports-and-adapters, scaled down to two workspace packages instead of a whole layered application. The standard vocabulary: `CatalogCheck` is the port, each `mg-0NN.ts` file is an adapter satisfying it, `runChecks` is the driver that depends on the port and never on a concrete adapter. What makes it real here (not just a diagram) is the build boundary: `catalog-core`/`catalog-checks` compile to `dist/` for runtime and are aliased to `src/` only in tests (context.md) — so the "no I/O" rule isn't just a convention, it's checked at typecheck time by what's importable from those packages' `package.json` exports.

`not yet exercised`: a second real adapter/consumer (the Bulk AI product context.md mentions is still a "planned future" item, not shipped) — so the reuse payoff is designed-for but not yet proven by a second caller.

## Interview defense

**Q: Why not just put the check logic directly in `runner.server.ts`?**
A: Because then it couldn't be reused by anything that isn't `runner.server.ts` — including the planned Bulk AI product, and including a test suite that wants to run checks without spinning up Prisma or mocking Shopify. The boundary is what makes the 83 engine tests possible with zero I/O mocks.

**Q: What's the actual enforced rule, not just the convention?**
A: `packages/catalog-checks/package.json`'s dependencies are exactly `@merchgrid/catalog-core` and `decimal.js` (`package.json:20-23`) — no Prisma, no Shopify SDK, no Remix. Import one of those and either the build fails to produce a Shopify/Prisma-free package, or (worse, silently) the engine stops being callable from a context with no database.

**Q: Name the load-bearing part someone would forget.**
A: The input-side normalization (`normalizeCatalog`), not just the output-side checks. It's tempting to think "pure engine" only means the checks are pure — but if `normalizeCatalog` leaked Shopify's raw GraphQL shape straight into the checks, you'd have re-coupled the engine to Shopify through the back door even with a clean `CatalogCheck` port on the output side.

## See also

- `02-atomic-idempotent-scan-pipeline.md` — where the engine's output (`CatalogFinding[]`) gets persisted.
- `audit.md` → lens 1 (system map — the engine box), lens 7 (scale — the engine has no shared state to contend over).
- `study-software-design` → PATTERN VOCABULARY, for the standard port/adapter/driver role-names used here.
