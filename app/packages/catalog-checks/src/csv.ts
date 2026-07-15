import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { CatalogFinding } from "./contract.js";
import { formatMoney, marginAmount, marginPercent } from "./money.js";

export interface CsvRowInput {
  finding: CatalogFinding;
  variant: NormalizedVariant;
}

export interface CsvMeta {
  scanId: string;
  scannedAt: string; // pre-formatted ISO 8601 string, passed in
}

const COLUMNS = [
  "scan_id",
  "scanned_at",
  "severity",
  "check_id",
  "check_name",
  "product_id",
  "product_title",
  "variant_id",
  "variant_title",
  "product_status",
  "price",
  "compare_at_price",
  "unit_cost",
  "currency",
  "margin_amount",
  "margin_percent",
  "sku",
  "barcode",
  "explanation",
  "admin_url",
] as const;

/**
 * RFC 4180 field escaping: wrap a field in double quotes when it contains a
 * comma, a double quote, a carriage return, or a line feed; inside a quoted
 * field every `"` is doubled. Non-special fields are emitted raw.
 */
export function escapeCsvField(s: string): string {
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowFields({ finding, variant }: CsvRowInput, meta: CsvMeta): string[] {
  const price = variant.price == null ? "" : formatMoney(variant.price);
  const compareAtPrice =
    variant.compareAtPrice == null ? "" : formatMoney(variant.compareAtPrice);
  const unitCost = variant.unitCost == null ? "" : formatMoney(variant.unitCost);

  const hasMargin = variant.price != null && variant.unitCost != null;
  const margin_amount = hasMargin
    ? formatMoney(marginAmount(variant.price!, variant.unitCost!))
    : "";
  const m = hasMargin ? marginPercent(variant.price!, variant.unitCost!) : null;
  const margin_percent = m == null ? "" : m.toFixed(2);

  return [
    meta.scanId,
    meta.scannedAt,
    finding.severity,
    finding.checkId,
    finding.title,
    variant.productId,
    variant.productTitle,
    variant.variantId,
    variant.variantTitle,
    variant.productStatus,
    price,
    compareAtPrice,
    unitCost,
    variant.currencyCode,
    margin_amount,
    margin_percent,
    variant.sku ?? "",
    variant.barcode ?? "",
    finding.explanation,
    variant.adminUrl,
  ];
}

export function findingsToCsv(rows: CsvRowInput[], meta: CsvMeta): string {
  const lines: string[] = [COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(rowFields(row, meta).map(escapeCsvField).join(","));
  }
  return lines.join("\r\n");
}
