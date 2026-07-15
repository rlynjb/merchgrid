import type { NormalizedVariant } from "@merchgrid/catalog-core";

export type FindingSeverity = "CRITICAL" | "WARNING" | "UNAVAILABLE";

export interface CatalogCheckContext {
  variants: NormalizedVariant[];
  settings: { minimumMarginPercent: number };
  now: string; // ISO 8601 detectedAt, injected so checks are deterministic
}

export interface CatalogFinding {
  id: string;
  checkId: string;
  severity: FindingSeverity;
  shopId: string;
  productId: string;
  variantId?: string;
  title: string;
  explanation: string;
  evidence: Record<string, string | number | boolean | null>;
  productTitle: string;
  variantTitle?: string;
  adminUrl: string;
  detectedAt: string;
}

export interface CatalogCheck {
  id: string;
  name: string;
  description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
