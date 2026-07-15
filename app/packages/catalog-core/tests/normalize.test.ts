import { describe, expect, it } from "vitest";
import { normalizeCatalog } from "../src/index.js";
import type { RawCatalog, RawProductNode, RawVariantNode } from "../src/index.js";

const opts = {
  shopId: "shop_1",
  shopDomain: "shop.myshopify.com",
  currencyCode: "USD",
  apiVersion: "2024-10",
};

function variant(overrides: Partial<RawVariantNode> = {}): RawVariantNode {
  return {
    id: "gid://shopify/ProductVariant/123",
    title: "Default Title",
    price: "9.99",
    compareAtPrice: null,
    sku: "AB1",
    barcode: null,
    inventoryItem: { unitCost: { amount: "5.00", currencyCode: "USD" }, tracked: true },
    ...overrides,
  };
}

function product(overrides: Partial<RawProductNode> = {}, variants: RawVariantNode[] = [variant()]): RawProductNode {
  return {
    id: "gid://shopify/Product/456",
    title: "Tee",
    status: "ACTIVE",
    handle: "tee",
    variants: { nodes: variants },
    ...overrides,
  };
}

function catalog(products: RawProductNode[], overrides: Partial<RawCatalog> = {}): RawCatalog {
  return {
    products,
    productsProcessed: products.length,
    variantsProcessed: products.reduce((n, p) => n + p.variants.nodes.length, 0),
    partial: false,
    ...overrides,
  };
}

describe("normalizeCatalog", () => {
  it("trims sku/barcode and nulls out blank strings, preserving case", () => {
    const raw = catalog([
      product({}, [variant({ sku: "   ", barcode: "" })]),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.sku).toBeNull();
    expect(snapshot.variants[0]?.barcode).toBeNull();
  });

  it("trims a real sku, preserving case", () => {
    const raw = catalog([product({}, [variant({ sku: " AB1 " })])]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.sku).toBe("AB1");
  });

  it("sets unitCost to null and tracksInventory to false when inventoryItem is missing", () => {
    const raw = catalog([product({}, [variant({ inventoryItem: null })])]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.unitCost).toBeNull();
    expect(snapshot.variants[0]?.tracksInventory).toBe(false);
  });

  it("sets unitCost to null when inventoryItem.unitCost is missing", () => {
    const raw = catalog([
      product({}, [variant({ inventoryItem: { unitCost: null, tracked: true } })]),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.unitCost).toBeNull();
    expect(snapshot.variants[0]?.tracksInventory).toBe(true);
  });

  it("preserves money strings exactly with no float coercion", () => {
    const raw = catalog([
      product({}, [variant({ price: "9.99", compareAtPrice: null })]),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.price).toBe("9.99");
    expect(snapshot.variants[0]?.compareAtPrice).toBeNull();
  });

  it("converts gids to numeric ids", () => {
    const raw = catalog([
      product(
        { id: "gid://shopify/Product/456" },
        [variant({ id: "gid://shopify/ProductVariant/123" })],
      ),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.productId).toBe("456");
    expect(snapshot.variants[0]?.variantId).toBe("123");
  });

  it("builds the admin url from shop domain and numeric ids", () => {
    const raw = catalog([
      product(
        { id: "gid://shopify/Product/456" },
        [variant({ id: "gid://shopify/ProductVariant/123" })],
      ),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.adminUrl).toBe(
      "https://shop.myshopify.com/admin/products/456?variant=123",
    );
  });

  it("uses product title alone when variant title is Default Title", () => {
    const raw = catalog([
      product({ title: "Tee" }, [variant({ title: "Default Title" })]),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.displayName).toBe("Tee");
  });

  it("combines product and variant title when variant title is meaningful", () => {
    const raw = catalog([
      product({ title: "Tee" }, [variant({ title: "Large" })]),
    ]);
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants[0]?.displayName).toBe("Tee - Large");
  });

  it("flattens variants across products and propagates counters", () => {
    const raw = catalog(
      [
        product({ id: "gid://shopify/Product/1" }, [variant({ id: "gid://shopify/ProductVariant/1" })]),
        product({ id: "gid://shopify/Product/2" }, [
          variant({ id: "gid://shopify/ProductVariant/2" }),
          variant({ id: "gid://shopify/ProductVariant/3" }),
        ]),
      ],
      { variantsProcessed: 3, partial: true },
    );
    const snapshot = normalizeCatalog(raw, opts);
    expect(snapshot.variants.length).toBe(3);
    expect(snapshot.variantsProcessed).toBe(3);
    expect(snapshot.partial).toBe(true);
  });
});
