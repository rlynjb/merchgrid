import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { CatalogCheckContext, CatalogFinding, FindingSeverity } from "../contract.js";

export function findingFor(
  v: NormalizedVariant,
  ctx: CatalogCheckContext,
  f: {
    checkId: string;
    severity: FindingSeverity;
    title: string;
    explanation: string;
    evidence: Record<string, string | number | boolean | null>;
  },
): CatalogFinding {
  return {
    id: `${f.checkId}:${v.variantId}`,
    checkId: f.checkId,
    severity: f.severity,
    shopId: v.shopId,
    productId: v.productId,
    variantId: v.variantId,
    title: f.title,
    explanation: f.explanation,
    evidence: f.evidence,
    productTitle: v.productTitle,
    variantTitle: v.variantTitle,
    adminUrl: v.adminUrl,
    detectedAt: ctx.now,
  };
}

export function normalizeSku(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

export function normalizeBarcode(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}
