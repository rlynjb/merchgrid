import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { CatalogCheckContext } from "../src/contract.js";

export function makeVariant(overrides: Partial<NormalizedVariant> = {}): NormalizedVariant {
  return {
    shopId: "shop_1",
    productId: "1",
    productTitle: "Test Product",
    productStatus: "ACTIVE",
    variantId: "1",
    variantTitle: "Default Title",
    displayName: "Test Product - Default Title",
    price: "10.00",
    compareAtPrice: null,
    unitCost: null,
    currencyCode: "USD",
    sku: null,
    barcode: null,
    tracksInventory: false,
    adminUrl: "https://admin.shopify.com/store/shop-1/products/1/variants/1",
    ...overrides,
  };
}

export function makeCtx(
  variants: NormalizedVariant[],
  minimumMarginPercent = 20,
): CatalogCheckContext {
  return {
    variants,
    settings: { minimumMarginPercent },
    now: "2026-07-14T00:00:00.000Z",
  };
}
