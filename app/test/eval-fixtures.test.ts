/**
 * MerchGrid Catalog Audit — golden-set EVAL
 * ==========================================
 *
 * This is a SEAM-LEVEL eval: it feeds a small, hand-built fixture catalog
 * through the real production seam `normalizeCatalog -> runChecks` (the
 * same two calls the worker uses in production) and asserts the resulting
 * findings match an INDEPENDENTLY-SPECIFIED expected set.
 *
 * "Independently specified" matters: the expectations below were written
 * by reading each `mg-00N.ts` check's stated behavior and reasoning about
 * what it *should* flag for each fixture — NOT by running the engine once
 * and snapshotting whatever came out. If a future change to a check
 * silently alters behavior, this test is meant to catch it, not rubber
 * -stamp it. Do not "fix" a red run here by copying the engine's actual
 * output into the expected table; that defeats the purpose of the eval.
 *
 * This is NOT the same thing as the LIVE end-to-end QA. A separate, manual
 * process seeds a real dev store with `scripts/seed-fixtures.ts` and runs
 * the full app (GraphQL fetch -> normalize -> checks -> export) against
 * it. That live run exercises the Shopify API integration and is out of
 * scope here; this eval only exercises the pure normalize+checks engine
 * seam, in-process, with no network calls.
 *
 * Note on drift: the fixtures below are DEFINED INDEPENDENTLY from
 * `scripts/seed-fixtures.ts`, even though many rows are conceptually
 * similar (both files were written against the same check specs). A
 * future improvement would be to share one fixture source between this
 * eval and the seeder to eliminate the duplication risk. For now they are
 * kept deliberately separate so this eval does not depend on, or get
 * silently broken by, changes made for the live-QA seeder.
 */
import { describe, expect, it } from "vitest";
import { normalizeCatalog, numericId } from "@merchgrid/catalog-core";
import type { RawCatalog, RawProductNode, RawVariantNode } from "@merchgrid/catalog-core";
import { ALL_CHECKS, runChecks } from "@merchgrid/catalog-checks";

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

let nextProductId = 1001;
let nextVariantId = 2001;

function variant(opts: {
  price: string;
  sku: string | null;
  unitCost: string | null;
  compareAtPrice?: string | null;
  barcode?: string | null;
  tracked?: boolean;
  title?: string;
}): RawVariantNode {
  const id = `gid://shopify/ProductVariant/${nextVariantId++}`;
  return {
    id,
    title: opts.title ?? "Default Title",
    price: opts.price,
    compareAtPrice: opts.compareAtPrice ?? null,
    sku: opts.sku,
    barcode: opts.barcode ?? null,
    inventoryItem: {
      unitCost: opts.unitCost === null ? null : { amount: opts.unitCost, currencyCode: "USD" },
      tracked: opts.tracked ?? true,
    },
  };
}

function product(opts: {
  title: string;
  status: string;
  handle: string;
  variants: RawVariantNode[];
}): RawProductNode {
  const id = `gid://shopify/Product/${nextProductId++}`;
  return {
    id,
    title: opts.title,
    status: opts.status,
    handle: opts.handle,
    variants: { nodes: opts.variants },
  };
}

// -- single-variant products (rows 1-5, 7-8, 10-13) --------------------------

const belowCostTeeVariant = variant({ price: "8.00", sku: "BC-001", unitCost: "10.00" });
const belowCostTee = product({
  title: "Below-Cost Tee",
  status: "ACTIVE",
  handle: "below-cost-tee",
  variants: [belowCostTeeVariant],
});

const thinMarginMugVariant = variant({ price: "10.00", sku: "TM-001", unitCost: "8.50" });
const thinMarginMug = product({
  title: "Thin-Margin Mug",
  status: "ACTIVE",
  handle: "thin-margin-mug",
  variants: [thinMarginMugVariant],
});

const freeSampleVariant = variant({ price: "0.00", sku: "FS-001", unitCost: "0.00" });
const freeSample = product({
  title: "Free Sample",
  status: "ACTIVE",
  handle: "free-sample",
  variants: [freeSampleVariant],
});

const badSaleHoodieVariant = variant({
  price: "10.00",
  sku: "BS-001",
  unitCost: "5.00",
  compareAtPrice: "9.00",
});
const badSaleHoodie = product({
  title: "Bad-Sale Hoodie",
  status: "ACTIVE",
  handle: "bad-sale-hoodie",
  variants: [badSaleHoodieVariant],
});

const noDiscountCapVariant = variant({
  price: "20.00",
  sku: "ND-001",
  unitCost: "10.00",
  compareAtPrice: "20.00",
});
const noDiscountCap = product({
  title: "No-Discount Cap",
  status: "ACTIVE",
  handle: "no-discount-cap",
  variants: [noDiscountCapVariant],
});

// -- row 6: shared SKU across two different products -------------------------

const sharedSkuAVariant = variant({ price: "10.00", sku: "SHARED-SKU", unitCost: "5.00" });
const sharedSkuA = product({
  title: "Shared SKU A",
  status: "ACTIVE",
  handle: "shared-sku-a",
  variants: [sharedSkuAVariant],
});

const sharedSkuBVariant = variant({ price: "12.00", sku: " shared-sku ", unitCost: "6.00" });
const sharedSkuB = product({
  title: "Shared SKU B",
  status: "ACTIVE",
  handle: "shared-sku-b",
  variants: [sharedSkuBVariant],
});

// -- row 7: duplicate barcode across two different products ------------------

const dupBarcodeXVariant = variant({
  price: "15.00",
  sku: "DBX-001",
  unitCost: "7.00",
  barcode: "0123456789012",
});
const dupBarcodeX = product({
  title: "Dup Barcode X",
  status: "ACTIVE",
  handle: "dup-barcode-x",
  variants: [dupBarcodeXVariant],
});

const dupBarcodeYVariant = variant({
  price: "15.00",
  sku: "DBY-001",
  unitCost: "7.00",
  barcode: "0123456789012",
});
const dupBarcodeY = product({
  title: "Dup Barcode Y",
  status: "ACTIVE",
  handle: "dup-barcode-y",
  variants: [dupBarcodeYVariant],
});

// -- row 8: tracked, no SKU ----------------------------------------------------

const trackedNoSkuVariant = variant({ price: "15.00", sku: null, unitCost: "7.00" });
const trackedNoSku = product({
  title: "Tracked No-SKU",
  status: "ACTIVE",
  handle: "tracked-no-sku",
  variants: [trackedNoSkuVariant],
});

// -- row 9: ONE product, THREE variants (Small/Medium/Large) -----------------

const voSmallVariant = variant({ price: "10.00", sku: "VO-S", unitCost: "4.00", title: "Small" });
const voMediumVariant = variant({ price: "11.00", sku: "VO-M", unitCost: "4.00", title: "Medium" });
const voLargeVariant = variant({ price: "100.00", sku: "VO-L", unitCost: "4.00", title: "Large" });
const variantOutlierProduct = product({
  title: "Variant-Outlier",
  status: "ACTIVE",
  handle: "variant-outlier",
  variants: [voSmallVariant, voMediumVariant, voLargeVariant],
});

// -- row 10: missing unit cost -------------------------------------------------

const missingCostVariant = variant({ price: "25.00", sku: "MC-001", unitCost: null });
const missingCostItem = product({
  title: "Missing-Cost Item",
  status: "ACTIVE",
  handle: "missing-cost-item",
  variants: [missingCostVariant],
});

// -- row 11: draft, zero price --------------------------------------------------

const draftZeroPriceVariant = variant({ price: "0.00", sku: "DZ-001", unitCost: "0.00" });
const draftZeroPrice = product({
  title: "Draft Zero-Price",
  status: "DRAFT",
  handle: "draft-zero-price",
  variants: [draftZeroPriceVariant],
});

// -- row 12: archived, below cost (no status gate on MG-002) -------------------

const archivedBelowCostVariant = variant({ price: "5.00", sku: "AR-001", unitCost: "10.00" });
const archivedBelowCost = product({
  title: "Archived Below-Cost",
  status: "ARCHIVED",
  handle: "archived-below-cost",
  variants: [archivedBelowCostVariant],
});

// -- row 13: unicode stress title, below cost -----------------------------------

const unicodeTeeVariant = variant({ price: "3.00", sku: "UNI-001", unitCost: "6.00" });
const unicodeTee = product({
  title: 'Café ☕ "Ünïcode", Tee',
  status: "ACTIVE",
  handle: "unicode-tee",
  variants: [unicodeTeeVariant],
});

const rawCatalog: RawCatalog = {
  products: [
    belowCostTee,
    thinMarginMug,
    freeSample,
    badSaleHoodie,
    noDiscountCap,
    sharedSkuA,
    sharedSkuB,
    dupBarcodeX,
    dupBarcodeY,
    trackedNoSku,
    variantOutlierProduct,
    missingCostItem,
    draftZeroPrice,
    archivedBelowCost,
    unicodeTee,
  ],
  productsProcessed: 15,
  variantsProcessed: 17,
  partial: false,
};

// ---------------------------------------------------------------------------
// Expected findings, keyed by human-readable fixture label -> gid.
// ---------------------------------------------------------------------------

const FIXTURES: Array<{ label: string; gid: string; expected: string[] }> = [
  { label: "Below-Cost Tee (BC-001)", gid: belowCostTeeVariant.id, expected: ["mg-002:CRITICAL"] },
  { label: "Thin-Margin Mug (TM-001)", gid: thinMarginMugVariant.id, expected: ["mg-003:WARNING"] },
  { label: "Free Sample (FS-001)", gid: freeSampleVariant.id, expected: ["mg-001:CRITICAL"] },
  { label: "Bad-Sale Hoodie (BS-001)", gid: badSaleHoodieVariant.id, expected: ["mg-004:CRITICAL"] },
  { label: "No-Discount Cap (ND-001)", gid: noDiscountCapVariant.id, expected: ["mg-004:WARNING"] },
  {
    label: "Shared SKU A",
    gid: sharedSkuAVariant.id,
    expected: ["mg-005:WARNING", "mg-009:WARNING"],
  },
  {
    label: "Shared SKU B",
    gid: sharedSkuBVariant.id,
    expected: ["mg-005:WARNING", "mg-009:WARNING"],
  },
  { label: "Dup Barcode X (DBX-001)", gid: dupBarcodeXVariant.id, expected: ["mg-006:WARNING"] },
  { label: "Dup Barcode Y (DBY-001)", gid: dupBarcodeYVariant.id, expected: ["mg-006:WARNING"] },
  { label: "Tracked No-SKU (no sku)", gid: trackedNoSkuVariant.id, expected: ["mg-007:WARNING"] },
  { label: "Variant-Outlier / Small (VO-S)", gid: voSmallVariant.id, expected: [] },
  { label: "Variant-Outlier / Medium (VO-M)", gid: voMediumVariant.id, expected: [] },
  { label: "Variant-Outlier / Large (VO-L)", gid: voLargeVariant.id, expected: ["mg-008:WARNING"] },
  {
    label: "Missing-Cost Item (MC-001)",
    gid: missingCostVariant.id,
    expected: ["mg-010:UNAVAILABLE"],
  },
  { label: "Draft Zero-Price (DZ-001)", gid: draftZeroPriceVariant.id, expected: [] },
  {
    label: "Archived Below-Cost (AR-001)",
    gid: archivedBelowCostVariant.id,
    expected: ["mg-002:CRITICAL"],
  },
  {
    label: 'Café ☕ "Ünïcode", Tee (UNI-001)',
    gid: unicodeTeeVariant.id,
    expected: ["mg-002:CRITICAL"],
  },
];

// ---------------------------------------------------------------------------
// Run the real seam once, group findings by variantId.
// ---------------------------------------------------------------------------

const snapshot = normalizeCatalog(rawCatalog, {
  shopId: "shop_1",
  shopDomain: "buffrmerch.myshopify.com",
  currencyCode: "USD",
  apiVersion: "2026-07",
});

const findings = runChecks(ALL_CHECKS, {
  variants: snapshot.variants,
  settings: { minimumMarginPercent: 20 },
  now: "2026-07-15T00:00:00.000Z",
});

const findingsByVariantId = new Map<string, Set<string>>();
for (const f of findings) {
  if (!f.variantId) continue;
  const set = findingsByVariantId.get(f.variantId) ?? new Set<string>();
  set.add(`${f.checkId}:${f.severity}`);
  findingsByVariantId.set(f.variantId, set);
}

function actualFor(gid: string): string[] {
  const variantId = numericId(gid);
  const set = findingsByVariantId.get(variantId);
  return set ? [...set].sort() : [];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("golden-set eval: fixture catalog -> normalize -> runChecks", () => {
  it("produces exactly 17 normalized variants across 15 products", () => {
    expect(snapshot.variants).toHaveLength(17);
    expect(snapshot.productsProcessed).toBe(15);
    expect(snapshot.variantsProcessed).toBe(17);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.label} matches expected findings`, () => {
      const actual = actualFor(fixture.gid);
      const expected = [...fixture.expected].sort();

      const missing = expected.filter((e) => !actual.includes(e));
      const unexpected = actual.filter((a) => !expected.includes(a));

      expect(
        { actual, missing, unexpected },
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      ).toEqual({ actual: expected, missing: [], unexpected: [] });
    });
  }

  it("has no orphan findings for variants outside the fixture table", () => {
    const knownVariantIds = new Set(FIXTURES.map((f) => numericId(f.gid)));
    const orphanVariantIds = [...findingsByVariantId.keys()].filter(
      (id) => !knownVariantIds.has(id),
    );
    expect(orphanVariantIds).toEqual([]);
  });
});
