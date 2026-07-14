# MerchGrid: Catalog Audit — Build, Test & Deploy Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take MerchGrid: Catalog Audit from an empty repo to a live, publicly-installable Shopify App Store app — covering Shopify Partner signup, local build, testing on a development store, production deployment, and App Store submission.

**Architecture:** Embedded Shopify admin app on Shopify's official **Remix + TypeScript** template. A stateless web process serves the embedded UI and Admin GraphQL calls; a separate **worker process** runs server-managed scans (DB-backed job queue) so a browser refresh never cancels a scan. A pure, Shopify-agnostic **check engine** (`@merchgrid/catalog-checks`) runs deterministic rules against a normalized snapshot — the reusable core for the future Bulk AI product. Postgres via Prisma stores shops, scans, and findings.

**Tech Stack:** Node 20, TypeScript, Remix, Shopify App Bridge + Polaris, Prisma ORM, PostgreSQL, `@shopify/shopify-app-remix`, Vitest (unit/integration), Shopify CLI, Fly.io (host) + Fly Postgres. Money math via `decimal.js` (no floats). CSV via `csv-stringify`.

## Global Constraints

_Copied verbatim from the spec; every task's requirements implicitly include this section._

- **Read-only MVP.** No write scopes requested; no code path may issue a product/inventory mutation (spec §11.1, §21.6).
- **Requested scopes:** `read_products`, `read_inventory` (unit cost lives on `InventoryItem.unitCost` — needs `read_inventory`). No `read_customers`, `read_orders`, `read_themes`, or any `write_*` (spec §14).
- **Money is decimal.** All price/margin math uses decimal-safe arithmetic on string amounts. Floating-point must not be used for pricing or margin decisions (spec §7.3).
- **Deterministic checks only.** Findings come from explicit rules, not an LLM. Do not describe the app as AI-powered (spec §2.1, §17.6).
- **Naming:** App Store name is exactly `MerchGrid: Catalog Audit`; developer `Buffr Studio`. Same string across app config, embedded UI, listing, support (spec §17.1). Repo `merchgrid-catalog-audit`; packages `@merchgrid/catalog-core`, `@merchgrid/catalog-checks` (spec §13.2).
- **Findings framed as review recommendations, not guarantees.** Warnings must state they may be intentional (spec §11.1, §10.4 FR-FIND-006).
- **Catalog-size guardrail:** documented max variants per scan. Beta technical ceiling **5,000 variants**; count variants, not products; stop with a clear message beyond the limit (spec §13.5).
- **No customer/order data.** But the three **mandatory GDPR compliance webhooks** + `app/uninstalled` must exist and respond correctly or App Store review rejects (Shopify requirement; gap noted in spec review).
- **Billing via Shopify Billing API only** when introduced — no external processor (Shopify requirement). Billing is deferred past MVP (spec §16.2).

---

## Phase overview

| Phase | Outcome | Tasks |
|---|---|---|
| **A. Accounts & scaffold** | Partner account, dev store, running "hello world" embedded app | A1–A5 |
| **B. Data & platform** | Prisma schema, auth, mandatory webhooks | B1–B4 |
| **C. Catalog read + normalize** | Bulk read → `NormalizedVariant[]` | C1–C3 |
| **D. Check engine** | 10 checks, TDD, severity, evidence | D1–D12 |
| **E. Scan orchestration** | State machine + worker + persistence | E1–E4 |
| **F. UI & export** | Onboarding, run, progress, results, detail, CSV, settings | F1–F7 |
| **G. Testing** | Fixtures, integration, manual QA on dev store | G1–G4 |
| **H. Production deploy** | Fly.io web+worker+Postgres, secrets, migrations | H1–H6 |
| **I. App Store submission** | Listing, privacy, review, publish | I1–I4 |

Phases A–F are the build. Ship each phase to the dev store and eyeball it before moving on. **Commit after every task.**

---

# Phase A — Accounts, tooling, and scaffold

### Task A1: Create Shopify Partner account and a development store

No code. Done once, manually.

- [ ] **Step 1:** Go to `https://partners.shopify.com` → **Join now**. Register the organization as **Buffr Studio** (this becomes the public "Developer name"). Use a role/support email you will also list in the App Store.
- [ ] **Step 2:** In the Partner Dashboard, complete **Account settings → Business details** (legal name, address, payout later). App review checks that developer identity is complete.
- [ ] **Step 3:** Create a development store: **Stores → Add store → Create development store → Build a new app or theme**. Name it e.g. `merchgrid-dev`. Choose "Developer preview" latest API version. This store is free and resettable.
- [ ] **Step 4:** In that store's admin, add a few test products manually now (you'll add scripted fixtures in Phase G) so the first scan has something to find: one product with 3 variants, one variant priced `0`, one with a compare-at below price.

Exit: You can log into `merchgrid-dev.myshopify.com/admin` and the Partner Dashboard.

### Task A2: Install toolchain

- [ ] **Step 1:** Confirm Node 20 (`node -v` → `v20.x`; this repo already has it).
- [ ] **Step 2:** Install Shopify CLI globally.

```bash
npm install -g @shopify/cli@latest
shopify version    # expect a 3.x version
```

- [ ] **Step 3:** Authenticate the CLI to your Partner org.

```bash
shopify auth logout || true
# The next login happens on first `shopify app dev`; it opens a browser.
```

Exit: `shopify version` prints a version.

### Task A3: Scaffold the Remix app into this repo

The repo currently holds only the spec. Scaffold into a subfolder and keep the spec + plan at the root.

- [ ] **Step 1:** Scaffold with the official template.

```bash
cd /Users/rein/Public/merchgrid
shopify app init --template remix --name "merchgrid-catalog-audit" --path app
```

Pick: **TypeScript**, **Prisma** (default), **npm**.

- [ ] **Step 2:** Rename Prisma's default SQLite to Postgres-ready later; for now the template's SQLite dev DB is fine locally. Verify the app boots.

```bash
cd /Users/rein/Public/merchgrid/app
npm install
npm run dev   # == `shopify app dev`; select the merchgrid-dev store when prompted
```

The CLI creates the app in the Partner Dashboard, tunnels a URL, and opens the embedded app in the dev store. You should see the template's default page inside Shopify admin.

- [ ] **Step 3:** Stop (`Ctrl-C`). Commit the scaffold.

```bash
cd /Users/rein/Public/merchgrid
git add -A
git commit -m "chore: scaffold Shopify Remix app (merchgrid-catalog-audit)"
```

### Task A4: Configure app metadata and scopes

**Files:** Modify `app/shopify.app.toml`

- [ ] **Step 1:** Set the app name, scopes, and embedded flag. Edit `shopify.app.toml`:

```toml
name = "MerchGrid: Catalog Audit"
handle = "merchgrid-catalog-audit"
embedded = true

[access_scopes]
scopes = "read_products,read_inventory"

[webhooks]
api_version = "2025-07"   # pin; confirm latest stable at build time

[[webhooks.subscriptions]]
topics = [ "app/uninstalled" ]
uri = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
uri = "/webhooks/compliance"
```

- [ ] **Step 2:** Push config to Shopify.

```bash
cd app && shopify app deploy
```

Expect: "Configuration updated". In the Partner Dashboard the app now shows scopes `read_products, read_inventory` and the webhook subscriptions.

- [ ] **Step 3:** Commit.

```bash
git add app/shopify.app.toml && git commit -m "chore: set app name, read-only scopes, mandatory webhooks"
```

### Task A5: Create the internal packages (monorepo-lite)

**Files:** Create `app/packages/catalog-core/`, `app/packages/catalog-checks/`

Keep the engine Shopify-agnostic and separately testable — this is the reusable core (spec §8.3, §13.2, §25.4).

- [ ] **Step 1:** Create workspace packages.

```
app/packages/catalog-core/     -> types, DecimalValue, normalization helpers, admin URL builder
app/packages/catalog-checks/   -> CatalogCheck contract + MG-001..MG-010
```

- [ ] **Step 2:** Add them to the app's `package.json` workspaces and install `decimal.js`.

```bash
cd app && npm install decimal.js csv-stringify
```

- [ ] **Step 3:** Commit.

```bash
git commit -am "chore: add catalog-core and catalog-checks workspace packages"
```

---

# Phase B — Data model, auth, mandatory webhooks

### Task B1: Prisma schema for the domain

**Files:** Modify `app/prisma/schema.prisma`; Test: `app/tests/schema.test.ts`

Model from spec §12. The template already has a `Session` table — keep it.

**Interfaces — Produces:** Prisma models `Shop`, `ShopSettings`, `Scan`, `Finding`, `ScanArtifact` with the columns below (later tasks read/write these).

- [ ] **Step 1:** Add models (verbatim column set from spec §12).

```prisma
model Shop {
  id             String    @id @default(cuid())
  shopDomain     String    @unique
  shopifyShopId  String?
  installStatus  String    @default("INSTALLED")   // INSTALLED | UNINSTALLED
  installedAt    DateTime  @default(now())
  uninstalledAt  DateTime?
  settings       ShopSettings?
  scans          Scan[]
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}

model ShopSettings {
  id                   String  @id @default(cuid())
  shopId               String  @unique
  shop                 Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)
  minimumMarginPercent Int     @default(20)
  catalogVariantLimit  Int     @default(5000)
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
}

model Scan {
  id                       String    @id @default(cuid())
  shopId                   String
  shop                     Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  status                   String    @default("QUEUED") // QUEUED|READING_CATALOG|RUNNING_CHECKS|PREPARING_RESULTS|COMPLETED|FAILED
  apiVersion               String
  minimumMarginPercentUsed Int
  productsProcessed        Int       @default(0)
  variantsProcessed        Int       @default(0)
  criticalCount            Int       @default(0)
  warningCount             Int       @default(0)
  unavailableCount         Int       @default(0)
  startedAt                DateTime?
  completedAt              DateTime?
  failedAt                 DateTime?
  failureCode              String?
  failureMessageSafe       String?
  findings                 Finding[]
  createdAt                DateTime  @default(now())
  updatedAt                DateTime  @updatedAt
  @@index([shopId, status])
}

model Finding {
  id           String   @id @default(cuid())
  scanId       String
  scan         Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  shopId       String
  checkId      String
  severity     String   // CRITICAL | WARNING | UNAVAILABLE
  productId    String
  variantId    String?
  productTitle String
  variantTitle String?
  adminUrl     String
  evidenceJson Json
  explanation  String
  detectedAt   DateTime
  createdAt    DateTime @default(now())
  @@index([scanId, severity])
}

model ScanArtifact {
  id        String   @id @default(cuid())
  scanId    String
  type      String
  storageKey String
  expiresAt DateTime?
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2:** Generate + migrate locally.

```bash
cd app && npx prisma migrate dev --name domain_models
```

Expect: migration applied, client regenerated.

- [ ] **Step 3:** Commit.

```bash
git add app/prisma && git commit -m "feat: domain data model (shop, settings, scan, finding)"
```

### Task B2: Upsert Shop + ShopSettings on install/auth

**Files:** Modify `app/app/shopify.server.ts` (afterAuth hook); Test: `app/tests/afterAuth.test.ts`

- [ ] **Step 1: Write the failing test** — installing a shop creates a `Shop` row with default settings.

```ts
import { ensureShop } from "~/models/shop.server";
test("ensureShop creates shop and default settings", async () => {
  const shop = await ensureShop("merchgrid-dev.myshopify.com");
  expect(shop.installStatus).toBe("INSTALLED");
  expect(shop.settings?.minimumMarginPercent).toBe(20);
});
```

- [ ] **Step 2:** Run → FAIL (`ensureShop` not defined).
- [ ] **Step 3:** Implement `app/app/models/shop.server.ts` `ensureShop(domain)` that upserts `Shop` + nested `ShopSettings`, and call it from `afterAuth` in `shopify.server.ts`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: provision shop + settings on auth`.

### Task B3: Mandatory GDPR compliance webhooks

**Files:** Create `app/app/routes/webhooks.compliance.tsx`; Test: `app/tests/compliance-webhook.test.ts`

Required for App Store approval even though we store no customer data.

- [ ] **Step 1:** Test — the route verifies HMAC and returns 200 for each of the three topics.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: use `authenticate.webhook(request)`; switch on `topic`:
  - `CUSTOMERS_DATA_REQUEST` → we hold no customer data; log + 200.
  - `CUSTOMERS_REDACT` → no customer data; log + 200.
  - `SHOP_REDACT` → delete the `Shop` and cascade (`onDelete: Cascade` removes scans/findings); 200.
  Invalid HMAC → 401.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: mandatory GDPR compliance webhooks`.

### Task B4: app/uninstalled webhook

**Files:** Create `app/app/routes/webhooks.app.uninstalled.tsx`; Test: `app/tests/uninstall-webhook.test.ts`

- [ ] **Step 1:** Test — on `APP_UNINSTALLED`, shop marked `UNINSTALLED`, `uninstalledAt` set, sessions for the shop deleted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement per spec §15.3: deactivate install, delete session credentials, schedule retained-data deletion per retention policy (§12.1: keep latest ≤3 scans until `shop/redact`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: handle app/uninstalled cleanup`.

---

# Phase C — Catalog retrieval and normalization

### Task C1: NormalizedVariant + DecimalValue types

**Files:** Create `app/packages/catalog-core/src/types.ts`

**Interfaces — Produces:** `NormalizedVariant`, `DecimalValue`, `CatalogSnapshot` (consumed by C2, C3, and all Phase D checks).

- [ ] **Step 1:** Copy the shape from spec §7.3 **with one fix from the spec review**: money is one representation, not three. Use bare decimal strings + a single `currencyCode` on the variant; drop per-field `currencyCode` to avoid "which currency wins" bugs.

```ts
export type Money = string;   // decimal string, e.g. "12.50"; never a float

export interface NormalizedVariant {
  shopId: string;
  productId: string;
  productTitle: string;
  productStatus: "ACTIVE" | "DRAFT" | "ARCHIVED" | string;
  productHandle?: string;

  variantId: string;
  variantTitle: string;
  displayName: string;

  price: Money | null;
  compareAtPrice: Money | null;
  unitCost: Money | null;
  currencyCode: string;

  sku: string | null;
  barcode: string | null;

  tracksInventory: boolean;
  inventoryPolicy?: "DENY" | "CONTINUE" | string;
  inventoryQuantity?: number | null;

  adminUrl: string;
}

export interface CatalogSnapshot {
  shopId: string;
  apiVersion: string;
  variants: NormalizedVariant[];
  productsProcessed: number;
  variantsProcessed: number;
  partial: boolean;            // true if retrieval stopped early / hit the limit
}
```

- [ ] **Step 2:** Commit `feat: normalized catalog types`.

### Task C2: Shopify catalog reader (bulk operations)

**Files:** Create `app/app/services/shopify/catalog-reader.server.ts`; Test: `app/tests/catalog-reader.test.ts` (mock the GraphQL client)

**Interfaces — Consumes:** authenticated `admin` GraphQL client. **Produces:** `readCatalog(admin, {limit}): Promise<RawCatalogPage>` returning raw product/variant/inventoryItem nodes + `partial` flag.

- [ ] **Step 1:** Test — reader paginates products and stops at `limit` variants, setting `partial=true` when truncated.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. For MVP scale (≤5,000 variants) use paginated `products` query; design the function so a bulk-operation implementation can replace it later (spec §13.3 adapter, §13.5). Query fields:

```graphql
query Catalog($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title status handle
      variants(first: 100) {
        nodes {
          id title
          price
          compareAtPrice
          sku barcode
          inventoryItem { unitCost { amount currencyCode } tracked }
          inventoryPolicy
        }
      }
    }
  }
}
```

Enforce the variant limit: stop paging once `variantsProcessed >= limit`, set `partial=true` (spec FR-DATA-003, FR-SCAN-006, §13.5). Translate API errors into typed adapter errors (spec §13.3).

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: paginated read-only catalog reader with variant limit`.

### Task C3: Normalizer (raw → NormalizedVariant)

**Files:** Create `app/packages/catalog-core/src/normalize.ts`; Test: `app/packages/catalog-core/tests/normalize.test.ts`

- [ ] **Step 1:** Test cases: whitespace-only SKU → `null`; missing `unitCost` → `null`; money strings preserved exactly ("9.99" stays "9.99", no float); `adminUrl` built as `https://{shopDomain}/admin/products/{numericId}?variant={numericVariantId}`; GID `gid://shopify/ProductVariant/123` → `123`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `normalizeCatalog(raw, {shopId, shopDomain}): CatalogSnapshot`: trim strings, coerce empty/whitespace to `null`, keep money as strings, derive `tracksInventory` from `inventoryItem.tracked`, build admin URLs (spec FR-DATA-004, §13.3 normalizer).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: catalog normalizer`.

---

# Phase D — Check engine (the heart)

**Interfaces for all of Phase D — Produces:**

```ts
// app/packages/catalog-checks/src/contract.ts
export type FindingSeverity = "CRITICAL" | "WARNING" | "UNAVAILABLE";

export interface CatalogCheckContext {
  variants: NormalizedVariant[];
  settings: { minimumMarginPercent: number };
  now: string;                 // ISO 8601 detectedAt, injected (deterministic tests)
}

export interface CatalogFinding {
  id: string; checkId: string; severity: FindingSeverity;
  shopId: string; productId: string; variantId?: string;
  title: string; explanation: string;
  evidence: Record<string, string | number | boolean | null>;
  productTitle: string; variantTitle?: string;
  adminUrl: string; detectedAt: string;
}

export interface CatalogCheck {
  id: string; name: string; description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
```

Checks are **pure** — no Shopify/DB calls (spec §8.3). Each check is a task: failing test → implement → pass → commit. Use `decimal.js` for every comparison. `detectedAt` comes from `ctx.now` (never `Date.now()` inside a check) so tests are deterministic.

> **Engine → downstream contract (locked by the final engine review).** A `CatalogFinding` is a deliberately *lean* projection: it always carries `shopId`, `productId`, `variantId`, titles, `adminUrl`, `checkId`, `severity`, `explanation`, and a **per-check** `evidence` bag. It does **not** carry the full money/identity column set, and `evidence` shapes differ by check — so **do not** source the CSV/UI columns from `evidence`. Instead, the report/export layer (Task F3, F7) **joins each finding back to the scan's persisted variant data by `(shopId, variantId)`** to fill `price/compare_at_price/unit_cost/currency/sku/barcode/product_status`, and computes `margin_amount = price − unitCost` there (add a `marginAmount(price, cost)` decimal helper to `money.ts` at that point — the engine intentionally does not pre-compute it). `checkId` is the lowercase kebab id (`mg-001`); the UI maps it to the display name/`MG-001` label. **Code-vs-spec deltas to honor (code wins):** MG-004 guards `compareAtPrice > 0` and downgrades the equal-to-price case to WARNING (spec §8.2 still says Critical/"when present" — stale); MG-003 is suppressed when `price < unitCost` so it never double-counts MG-002. MG-005 and MG-009 intentionally *both* fire on a conflicting duplicate-SKU variant (two distinct WARNINGs) — the UI groups by variant, it does not dedupe them.

### Task D1: Contract + `runChecks` registry + money helpers

**Files:** Create `app/packages/catalog-checks/src/contract.ts`, `.../src/money.ts`, `.../src/run.ts`; Test: `.../tests/money.test.ts`

- [ ] **Step 1:** Test money helpers: `lt("9.99","10.00")===true`; `marginPercent("10.00","8.00")` ≈ `20`; `marginPercent("10.00", null)===null`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `money.ts` (`lt/lte/eq/sub/marginPercent` over `Decimal`), `run.ts` `runChecks(checks, ctx): CatalogFinding[]` (concat all), and the check registry array.
- [ ] **Step 4:** Run → PASS. Commit `feat: check contract, registry, decimal money helpers`.

### Task D2 — MG-001: Active variant zero/negative price (CRITICAL)

**Files:** Create `.../src/checks/mg-001.ts`; Test: `.../tests/mg-001.test.ts`

- [ ] Test: active variant `price="0"` → 1 CRITICAL; `price="10"` → none; DRAFT product with `price="0"` → none (applies only when product active). **Condition:** `price <= 0` (spec §8.2 MG-001). Explanation + false-positive note (samples/deposits may be intentional) from spec. Commit.

### Task D3 — MG-002: Price below unit cost (CRITICAL)

**Files:** `.../src/checks/mg-002.ts`; Test: `.../tests/mg-002.test.ts`

- [ ] Test: `price="8.00"`, `unitCost="10.00"` → CRITICAL with evidence `{lossPerUnit:"2.00", marginPercent:-25}`; missing cost → none (that's MG-010). **Applies when** price and cost both present, same currency. **Condition:** `price < unitCost`. Calculated fields per spec §8.2 MG-002 (keep margin amount `price - unitCost`; the "absolute loss" is its negation — expose one, `lossPerUnit`). Commit.

### Task D4 — MG-003: Margin below threshold (WARNING; CRITICAL if negative)

**Files:** `.../src/checks/mg-003.ts`; Test

- [ ] Test: threshold 20, `price="10"`, `cost="8.50"` → margin 15% → WARNING; `cost="12"` → negative → CRITICAL. **Suppression rule (spec-review fix):** if MG-002 already flags this variant (price<cost), MG-003 does **not** emit a duplicate — implement by having MG-003 skip variants where `price < unitCost` (MG-002 owns the below-cost story) and only fire on `0 <= marginPercent < threshold`, plus the explicitly-negative CRITICAL case is left to MG-002. Document this in the check description so counts don't double (spec review finding #5). Commit.

### Task D5 — MG-004: Invalid compare-at price (CRITICAL)

**Files:** `.../src/checks/mg-004.ts`; Test

- [ ] Test (**with spec-review fix**): `compareAt="0"` → **none** (0/absent = "not on sale" in Shopify; guard `compareAtPrice > 0`); `compareAt="9.99"`, `price="10.00"` → CRITICAL; `compareAt="10.00"`, `price="10.00"` → **WARNING** (equality is cosmetic, not financial — downgraded per review finding #6); `compareAt="15"`, `price="10"` → none. **Applies when** `compareAtPrice != null && compareAtPrice > 0`. Commit.

### Task D6 — MG-005: Duplicate non-empty SKU (WARNING)

**Files:** `.../src/checks/mg-005.ts`; Test

- [ ] Test: SKUs `"AB1"` and `" ab1 "` on two variants → both flagged (trim + case-insensitive detection; preserve original for display). Single occurrence → none. Empty/null → none. Cross-variant check: build a normalized-SKU→variants map. False-positive note (bundles/packs) per spec §8.2 MG-005. Commit.

### Task D7 — MG-006: Duplicate non-empty barcode (WARNING)

**Files:** `.../src/checks/mg-006.ts`; Test

- [ ] Test: same trimmed barcode on 2 variants → both WARNING. Same map pattern as MG-005. Commit.

### Task D8 — MG-007: Inventory-tracked variant missing SKU (WARNING)

**Files:** `.../src/checks/mg-007.ts`; Test

- [ ] Test: `tracksInventory=true`, `sku=null` → WARNING; `tracksInventory=false`, `sku=null` → none. Commit.

### Task D9 — MG-008: Variant price outlier within product (WARNING, low-confidence)

**Files:** `.../src/checks/mg-008.ts`; Test

- [ ] Test: product with prices `["10","11","100"]` (≥3 positive) → `"100"` flagged (>400% of median 11); product with 2 variants → none. **Heuristic:** ≥3 positive-priced variants; flag if `price < 0.25*median` or `price > 4*median` (spec §8.2 MG-008). Label as low-confidence in explanation. Commit.

### Task D10 — MG-009: Same SKU, conflicting price/cost (WARNING)

**Files:** `.../src/checks/mg-009.ts`; Test

- [ ] Test: two variants share normalized SKU but different `price` → WARNING on the group. **Applies when** a duplicate SKU exists (depends on the same SKU map as MG-005; note the shared-context dependency in the description — spec review finding #5). Commit.

### Task D11 — MG-010: Unit cost missing (UNAVAILABLE)

**Files:** `.../src/checks/mg-010.ts`; Test

- [ ] Test: variant otherwise evaluable, `unitCost=null` → 1 UNAVAILABLE. Do **not** also emit MG-002/003 for it. Explanation per spec §8.2 MG-010; display bucket "Could not evaluate". Commit.

### Task D12: Register all checks + engine-level integration test

**Files:** Modify `.../src/index.ts` (export `ALL_CHECKS`); Test: `.../tests/engine.test.ts`

- [ ] **Step 1:** Test a hand-built snapshot exercising every check at once; assert per-severity counts and that MG-002/MG-003/MG-010 don't triple-count the same below-cost/missing-cost variant.
- [ ] **Step 2:** Run → FAIL → wire `ALL_CHECKS = [mg001…mg010]`, `runChecks`.
- [ ] **Step 3:** Run → PASS. Commit `feat: register all v1 checks + engine integration test`.

---

# Phase E — Scan orchestration

### Task E1: Scan state machine

**Files:** Create `app/app/services/scan/state.ts`; Test: `app/tests/scan-state.test.ts`

- [ ] Test valid transitions only: `QUEUED→READING_CATALOG→RUNNING_CHECKS→PREPARING_RESULTS→COMPLETED`, any→`FAILED`; reject illegal jumps (spec §10.3 FR-SCAN-004). Implement `assertTransition(from,to)`. Commit.

### Task E2: Scan runner (read → normalize → check → persist)

**Files:** Create `app/app/services/scan/runner.server.ts`; Test: `app/tests/scan-runner.test.ts` (mock reader + admin)

- [ ] **Step 1:** Test: a queued scan runs end-to-end against a mocked catalog and writes `Finding` rows + updates severity counts; `partial` retrieval sets `failureCode="PARTIAL"` or a labeled partial-complete state, never a clean COMPLETED (spec FR-SCAN-006).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: load `ShopSettings`, `readCatalog` (limit from settings), `normalizeCatalog`, `runChecks(ALL_CHECKS, ctx)`, persist findings in a transaction, update `Scan` counts + `completedAt`. Idempotent by `scanId` — re-running a COMPLETED scan is a no-op; retries clear prior findings for that scan first so retries don't duplicate (spec §11.3). Commit.

### Task E3: Worker process + enqueue

**Files:** Create `app/worker.ts`, `app/app/services/scan/queue.server.ts`; Modify `app/package.json` scripts

- [ ] **Step 1:** Implement DB-backed queue: `enqueueScan(shopId)` creates a `QUEUED` Scan (rejects if one is already active for the shop — spec FR-SCAN-002), `worker.ts` polls for `QUEUED` scans and runs `runner`. Keep it a single modest worker; no distributed infra (spec §13.4).
- [ ] **Step 2:** Add scripts: `"worker": "tsx worker.ts"`, and a `dev:all` that runs web + worker. Commit `feat: DB-backed scan queue + worker process`.

### Task E4: Scan API routes

**Files:** Create `app/app/routes/api.scans.tsx` (POST start), `app/app/routes/api.scans.$id.tsx` (GET status/results)

- [ ] Implement authenticated (embedded session) endpoints. **Enforce shop authorization on every request** — a shop can only read its own scans/findings (spec §15.4, §21.6). POST enforces one active scan/shop. Add a debounce guard so repeated button clicks don't create duplicate scans (spec §9.3). Commit `feat: scan start + status API with per-shop authz`.

---

# Phase F — UI and export

_Polaris components inside the embedded app. UI tasks: build the route, load it in the dev store, verify visually. Keyboard + non-color severity are acceptance items (spec §11.4)._

### Task F1: Onboarding / home route
**Files:** `app/app/routes/app._index.tsx`
- [ ] Headline "Check your catalog for pricing and identifier mistakes / MerchGrid reads your product and variant data but never changes your store." Primary button **Run catalog audit**; show what's checked, current scan limit, privacy link; no forced multi-step onboarding (spec §9.2). Commit.

### Task F2: Scan progress
**Files:** `app/app/routes/app.scan.$id.tsx`
- [ ] Polling status view with staged checklist (Connecting → Reading → Checking → Preparing), survives refresh, retry action on failure, disabled button while active (spec §9.3, §21.2). Commit.

### Task F3: Results dashboard + summary cards
**Files:** `app/app/routes/app.results.$scanId.tsx`
- [ ] Summary cards Critical / Warnings / Could not evaluate / Variants checked; highest-priority callout; findings table (Severity, Check, Product/variant, Current data, Explanation, Open in Shopify) sorted Critical→Warning→Unavailable then by financial magnitude where available; server-side pagination (spec §9.4, §11.2 — table must stay responsive at high finding counts). Commit.

### Task F4: Filters + search
- [ ] Filter by severity + check type; search by product/variant title, SKU, barcode (spec §10.4 FR-FIND-003/004). Commit.

### Task F5: Finding detail drawer
- [ ] Drawer with product/variant/status/price/compare-at/cost/margin/SKU/barcode, exact rule, explanation + "may be intentional" note, Open-in-Shopify link. No Fix button (spec §9.5). Commit.

### Task F6: Settings (margin threshold)
**Files:** `app/app/routes/app.settings.tsx`
- [ ] Validated 0–90% input; changing it does not rewrite past scans; each scan displays the threshold it used (spec §10.5). Commit.

### Task F7: CSV export
**Files:** `app/app/routes/api.scans.$id.export.tsx`; Test: `app/tests/csv.test.ts`
- [ ] **Step 1:** Test CSV escaping: titles with commas/quotes/newlines stay valid; UTF-8 preserved; ISO-8601 timestamp; exact column order from spec §9.6.
- [ ] **Step 2:** FAIL → implement with `csv-stringify`, exports **all** findings by default (filters only if labeled — FR-EXP-002), filename `merchgrid-catalog-audit-findings-{shop}-{YYYY-MM-DD}.csv`, generated on demand, not persisted (spec §9.6, §10.6). **Fill money/identity columns via the engine→downstream contract above:** join each `Finding` to its persisted variant snapshot by `(shopId, variantId)` for `price/compare_at_price/unit_cost/currency/sku/barcode/product_status`; do NOT read them from `evidence`. Compute `margin_amount = price − unitCost` with a new `marginAmount` decimal helper, and format money to 2 decimals at this boundary (the decimal helpers strip trailing zeros — e.g. `sub` returns `"2"`, not `"2.00"`).
- [ ] **Step 3:** PASS. Commit `feat: CSV export`.

---

# Phase G — Testing

### Task G1: Test-catalog fixtures on the dev store
**Files:** `app/scripts/seed-fixtures.ts`
- [ ] Script that (read-only app aside — this uses a **separate throwaway script with a temporary write token on the dev store only**, never the app's creds) seeds: active/draft/archived products; 1-variant and many-variant products; zero/negative boundaries where Shopify allows; missing & stale costs; duplicate SKUs differing by case/whitespace; duplicate barcodes; intentional SKU reuse; extreme-but-legit price spreads; unicode + CSV-special titles; a ~3,000-variant product set for load (spec §22.3). Commit.

### Task G2: Integration tests
- [ ] Auth/session restore, pagination, cost-field permission failure, large pages, rate-limit/transient-error retry, scan retry without duplicate findings, DB cleanup after uninstall (spec §22.2). Commit.

### Task G3: Full run on dev store
- [ ] `npm run dev:all`, install on `merchgrid-dev`, run a scan over the fixtures, verify every acceptance item in spec §21.3 (each check detected), §21.4 (sort/filter/search/evidence/links), §21.5 (CSV valid), §21.6 (no mutations, authz enforced). Fix findings; re-run.

### Task G4: Manual QA + accessibility
- [ ] Install/uninstall clean store; refresh during scan; results in multiple tabs; retry after induced failure; open CSV in Sheets/Excel; keyboard nav + screen-reader labels; severity not color-only (spec §22.4, §11.4).

**Gate:** Do not proceed to production until G3 + G4 pass. This is the spec's **Phase 1 exit criteria**.

---

# Phase H — Production deployment (Fly.io)

_Host-specific. Swap Fly for Render/Railway by changing only H1–H3; the app is host-agnostic._

### Task H1: Provision Postgres + app
- [ ] **Step 1:** `fly launch --no-deploy` in `app/` (generates `fly.toml`, app name `merchgrid-catalog-audit`).
- [ ] **Step 2:** `fly postgres create --name merchgrid-db` then `fly postgres attach merchgrid-db` (sets `DATABASE_URL`).
- [ ] **Step 3:** Switch Prisma datasource to `postgresql` and create the initial Postgres migration; commit.

### Task H2: Two process groups (web + worker)
**Files:** Modify `app/fly.toml`
- [ ] Define processes:
```toml
[processes]
  web = "npm run start"
  worker = "npm run worker"
[[services]]
  processes = ["web"]
  internal_port = 3000
  # ... http service config
```
Worker has no public service. Commit.

### Task H3: Secrets
- [ ] Set production secrets (never in logs/source — spec §15.2):
```bash
fly secrets set \
  SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... \
  SCOPES="read_products,read_inventory" \
  SHOPIFY_APP_URL="https://merchgrid-catalog-audit.fly.dev" \
  SESSION_SECRET="$(openssl rand -hex 32)"
```
Encrypt Shopify access tokens at rest (template stores sessions in DB; ensure token column encryption per spec §15.2).

### Task H4: Point the Shopify app at production
**Files:** `app/shopify.app.toml`
- [ ] Set `application_url` and `redirect_urls` to the Fly URL; `cd app && shopify app deploy` to push config + webhook URIs. Confirm webhook endpoints resolve on the prod domain.

### Task H5: Deploy + migrate
- [ ] **Step 1:** Add a release command to run migrations on deploy:
```toml
[deploy]
  release_command = "npx prisma migrate deploy"
```
- [ ] **Step 2:** `fly deploy`. Expect web + worker healthy (`fly status` shows both process groups).
- [ ] **Step 3:** Install on `merchgrid-dev` **against the production URL**, run a real scan end-to-end. Verify observability events fire (install, scan start/complete, duration, catalog size, failures — spec §11.5, §19) and that no catalog payloads/secrets land in logs.

### Task H6: Production smoke + safety verification
- [ ] Re-verify spec §21.6 in prod: grep the deployed bundle/routes to confirm **no mutation GraphQL** exists; confirm only `read_*` scopes are live in the Partner Dashboard; confirm cross-shop authz (attempt to read another shop's scan id → denied). Commit any fixes.

**Gate:** This is the spec's **Phase 2 (private beta)** entry — recruit ≥5 external test stores, add a feedback + false-positive logging path, watch scan completion rate.

---

# Phase I — App Store submission

### Task I1: Legal + support prerequisites
- [ ] Publish a **privacy policy** URL matching actual retention/deletion behavior (spec §12.1, §15). Verified Buffr Studio developer identity + support contact/email. Help-center answers for the 7 common support cases (spec §20).

### Task I2: Listing assets
- [ ] App name `MerchGrid: Catalog Audit`, developer `Buffr Studio`; subtitle, short description, feature bullets **verbatim from spec §17.2–17.4**; screenshots from the real dashboard; app icon + wordmark. Avoid the prohibited messages (no SEO/AI-score/"Powered by AI" — spec §17.6).

### Task I3: App review checklist (self-audit before submit)
- [ ] Embedded + App Bridge session-token auth ✔; only `read_products,read_inventory` requested ✔; **all four webhooks respond (3 GDPR + app/uninstalled)** ✔ — this is the most common rejection cause; no protected-data scopes ✔; billing (if any) via Shopify Billing API ✔ (deferred → none at launch); performance sane on a real catalog ✔. Test install/uninstall/reinstall.

### Task I4: Submit
- [ ] Partner Dashboard → app → **Distribution → Shopify App Store → Create listing → Submit for review**. Track review feedback; address inline. On approval the app is publicly installable.

**This is the spec's Phase 3 exit.** Post-launch: enable production monitoring + support templates; defer scheduling/history/billing to Phase 4 pending real demand (spec §16.2, §24, §25).

---

## Self-review — spec coverage map

| Spec section | Covered by |
|---|---|
| §7.1 core capabilities (auth, read, checks, results, export) | A3–A4, B2, C, D, F |
| §7.3 normalization / decimal money | C1, C3, D1 |
| §8 severity model + MG-001..010 | D1–D12 (with review fixes to MG-003/004) |
| §8.3 engine contract (pure, no Shopify calls) | D1, packages split A5 |
| §9 UX flows, dashboard, detail, export | F1–F7 |
| §10 functional requirements (AUTH/DATA/SCAN/FIND/SET/EXP) | B2–B4, C2, E1–E4, F4/F6/F7 |
| §11 NFRs (safety/perf/reliability/a11y/observability) | Global Constraints, E2, F3, G4, H5 |
| §12 data model + retention | B1, B4, I1 |
| §13 architecture (adapter/normalizer/engine/orchestrator/worker) | A5, C2, C3, D, E |
| §14 permissions & data boundaries | A4 (`read_products,read_inventory`), H6 |
| §15 privacy/security (encryption, uninstall, per-shop authz) | B3, B4, E4, H3, H6 |
| §17 App Store positioning | I2 |
| §19 analytics events | H5 (wire), F routes |
| §21 acceptance criteria | G3 |
| §22 test plan | D (unit), G1–G4 |
| §24 release plan phases 0–3 | Phase gates after F, G, H, I |
| **Gaps found in spec review, fixed in plan** | MG-004 `compareAt>0` guard (D5), MG-002/003/010 suppression (D4/D11/D12), mandatory GDPR webhooks (B3), `read_inventory` scope (A4), Shopify Billing note (Global Constraints/I3) |

---

## Notes carried from the spec review (already folded into tasks)

1. **Mandatory GDPR webhooks** were absent from the spec → Task B3 (blocks App Store approval otherwise).
2. **MG-004 false-positive** on `compareAt=0`/unset → guarded in D5; equality downgraded to WARNING.
3. **Check overlap** (MG-002/003 and MG-010) → suppression rules in D4, D11, D12 so severity counts don't double.
4. **`read_inventory` scope** needed for `unitCost` → A4.
5. **Money-representation redundancy** in the spec's `NormalizedVariant` → simplified to one currency field in C1.
6. **Billing must use Shopify Billing API** (deferred, but noted) → Global Constraints + I3.
