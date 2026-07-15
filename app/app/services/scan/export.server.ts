import type { CatalogFinding } from "@merchgrid/catalog-checks";
import { findingsToCsv } from "@merchgrid/catalog-checks";
import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { FindingRow } from "./scan-api.server";

/**
 * Pure CSV builder for the "Export CSV" download (spec §9.6). Deliberately
 * has no `shopify.server` (or any Remix/Prisma) import: it only maps the
 * already-authorized, already-loaded `FindingRow[]` onto the engine's
 * `CsvRowInput` shape and hands off to `findingsToCsv` for the actual
 * formatting/escaping. Authorization and data loading live in
 * `getAllFindingsForExport` (scan-api.server.ts); this function never talks
 * to the database.
 */
export function buildFindingsCsv(
  rows: FindingRow[],
  meta: { scanId: string; scannedAt: string },
  checkNames: Record<string, string>,
): string {
  const inputs = rows.map((row) => {
    const finding: CatalogFinding = {
      id: row.id,
      checkId: row.checkId,
      severity: row.severity as CatalogFinding["severity"],
      shopId: "",
      productId: row.productId,
      variantId: row.variantId ?? undefined,
      title: checkNames[row.checkId] ?? row.checkId,
      explanation: row.explanation,
      evidence: row.evidence as CatalogFinding["evidence"],
      productTitle: row.productTitle,
      variantTitle: row.variantTitle ?? undefined,
      adminUrl: row.adminUrl,
      detectedAt: row.detectedAt,
    };

    const variant: NormalizedVariant = {
      shopId: "",
      productId: row.productId,
      productTitle: row.productTitle,
      productStatus: row.productStatus ?? "",
      variantId: row.variantId ?? "",
      variantTitle: row.variantTitle ?? "",
      displayName: row.variantTitle ?? row.productTitle,
      price: row.price,
      compareAtPrice: row.compareAtPrice,
      unitCost: row.unitCost,
      currencyCode: row.currency ?? "",
      sku: row.sku,
      barcode: row.barcode,
      tracksInventory: false,
      adminUrl: row.adminUrl,
    };

    return { finding, variant };
  });

  return findingsToCsv(inputs, meta);
}
