import { describe, expect, it } from "vitest";
import type { CatalogSnapshot, NormalizedVariant } from "../src/index.js";

describe("catalog-core types", () => {
  it("allows constructing a well-formed NormalizedVariant", () => {
    const variant: NormalizedVariant = {
      shopId: "shop_1",
      productId: "prod_1",
      productTitle: "Test Product",
      productStatus: "ACTIVE",
      variantId: "var_1",
      variantTitle: "Default",
      displayName: "Test Product - Default",
      price: "12.50",
      compareAtPrice: null,
      unitCost: "5.00",
      currencyCode: "USD",
      sku: "SKU-1",
      barcode: null,
      tracksInventory: true,
      inventoryQuantity: 10,
      adminUrl: "https://example.com/admin/products/1",
    };

    expect(variant.price).toBe("12.50");
  });

  it("allows constructing a well-formed CatalogSnapshot", () => {
    const snapshot: CatalogSnapshot = {
      shopId: "shop_1",
      apiVersion: "2024-10",
      variants: [],
      productsProcessed: 0,
      variantsProcessed: 0,
      partial: false,
    };

    expect(snapshot.partial).toBe(false);
  });
});
