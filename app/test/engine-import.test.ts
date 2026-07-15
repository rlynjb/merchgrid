import { describe, expect, it } from "vitest";
import { normalizeCatalog } from "@merchgrid/catalog-core";
import type { RawCatalog } from "@merchgrid/catalog-core";
import {
  ALL_CHECKS,
  findingsToCsv,
  runChecks,
} from "@merchgrid/catalog-checks";

// This test proves the Remix app can resolve and execute the in-repo
// "engine" packages via their package specifiers (not relative paths),
// mirroring the shapes exercised by the engine's own test suite under
// app/packages/*/tests.

const rawCatalog: RawCatalog = {
  products: [
    {
      id: "gid://shopify/Product/1",
      title: "Test Product",
      status: "ACTIVE",
      handle: "test-product",
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/1",
            title: "Default Title",
            price: "0.00",
            compareAtPrice: null,
            sku: "SKU-1",
            barcode: null,
            inventoryItem: null,
            inventoryPolicy: "DENY",
            inventoryQuantity: 0,
          },
        ],
      },
    },
  ],
  productsProcessed: 1,
  variantsProcessed: 1,
  partial: false,
};

describe("engine import via package specifiers", () => {
  it("exposes all ten checks", () => {
    expect(ALL_CHECKS.length).toBe(10);
  });

  it("normalizes a raw catalog and runs the checks without throwing", () => {
    const snapshot = normalizeCatalog(rawCatalog, {
      shopId: "shop_1",
      shopDomain: "shop-1.myshopify.com",
      currencyCode: "USD",
      apiVersion: "2026-01",
    });

    const ctx = {
      variants: snapshot.variants,
      settings: { minimumMarginPercent: 20 },
      now: "2026-07-14T00:00:00.000Z",
    };

    const findings = runChecks(ALL_CHECKS, ctx);
    expect(Array.isArray(findings)).toBe(true);
  });

  it("renders a CSV header for an empty findings list", () => {
    const csv = findingsToCsv([], {
      scanId: "s",
      scannedAt: "2026-07-14T00:00:00.000Z",
    });
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      "scan_id,scanned_at,severity,check_id,check_name,product_id,product_title,variant_id,variant_title,product_status,price,compare_at_price,unit_cost,currency,margin_amount,margin_percent,sku,barcode,explanation,admin_url",
    );
  });
});
