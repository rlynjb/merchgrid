export type Money = string; // decimal string, e.g. "12.50"; never a float

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
  partial: boolean;
}
