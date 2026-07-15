import type { CatalogSnapshot, NormalizedVariant } from "./types.js";

export interface RawMoney {
  amount: string;
  currencyCode: string;
}

export interface RawInventoryItem {
  unitCost: RawMoney | null;
  tracked: boolean;
}

export interface RawVariantNode {
  id: string; // gid://shopify/ProductVariant/123
  title: string;
  price: string; // decimal string
  compareAtPrice: string | null;
  sku: string | null;
  barcode: string | null;
  inventoryItem: RawInventoryItem | null;
  inventoryPolicy?: string | null; // "DENY" | "CONTINUE"
  inventoryQuantity?: number | null;
}

export interface RawProductNode {
  id: string; // gid://shopify/Product/456
  title: string;
  status: string; // "ACTIVE" | "DRAFT" | "ARCHIVED"
  handle: string;
  variants: { nodes: RawVariantNode[] };
}

export interface RawCatalog {
  products: RawProductNode[];
  productsProcessed: number;
  variantsProcessed: number;
  partial: boolean;
}

export interface NormalizeOptions {
  shopId: string;
  shopDomain: string;
  currencyCode: string;
  apiVersion: string;
}

/**
 * Extracts the trailing numeric id from a Shopify GID, e.g.
 * "gid://shopify/Product/456" -> "456".
 */
export function numericId(gid: string): string {
  const segments = gid.split("/");
  return segments[segments.length - 1] ?? gid;
}

function nullIfBlank(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function buildDisplayName(productTitle: string, variantTitle: string): string {
  const trimmedVariantTitle = variantTitle.trim();
  if (trimmedVariantTitle && trimmedVariantTitle !== "Default Title") {
    return `${productTitle} - ${trimmedVariantTitle}`;
  }
  return productTitle;
}

function normalizeVariant(
  product: RawProductNode,
  variant: RawVariantNode,
  opts: NormalizeOptions,
): NormalizedVariant {
  const productId = numericId(product.id);
  const variantId = numericId(variant.id);
  const productTitle = product.title.trim();
  const variantTitle = variant.title.trim();

  const normalized: NormalizedVariant = {
    shopId: opts.shopId,
    productId,
    productTitle,
    productStatus: product.status,
    productHandle: product.handle,
    variantId,
    variantTitle,
    displayName: buildDisplayName(productTitle, variantTitle),
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    unitCost: variant.inventoryItem?.unitCost?.amount ?? null,
    currencyCode: opts.currencyCode,
    sku: nullIfBlank(variant.sku),
    barcode: nullIfBlank(variant.barcode),
    tracksInventory: variant.inventoryItem?.tracked === true,
    adminUrl: `https://${opts.shopDomain}/admin/products/${productId}?variant=${variantId}`,
  };

  if (variant.inventoryPolicy !== undefined && variant.inventoryPolicy !== null) {
    normalized.inventoryPolicy = variant.inventoryPolicy;
  }
  if (variant.inventoryQuantity !== undefined) {
    normalized.inventoryQuantity = variant.inventoryQuantity;
  }

  return normalized;
}

export function normalizeCatalog(raw: RawCatalog, opts: NormalizeOptions): CatalogSnapshot {
  const variants: NormalizedVariant[] = [];

  for (const product of raw.products) {
    for (const variant of product.variants.nodes) {
      variants.push(normalizeVariant(product, variant, opts));
    }
  }

  return {
    shopId: opts.shopId,
    apiVersion: opts.apiVersion,
    variants,
    productsProcessed: raw.productsProcessed,
    variantsProcessed: raw.variantsProcessed,
    partial: raw.partial,
  };
}
