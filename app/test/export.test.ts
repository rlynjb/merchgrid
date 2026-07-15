import { describe, expect, it } from "vitest";
import { buildFindingsCsv } from "../app/services/scan/export.server";
import type { FindingRow } from "../app/services/scan/scan-api.server";

const EXPECTED_HEADER = [
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
].join(",");

function makeRow(overrides: Partial<FindingRow> = {}): FindingRow {
  return {
    id: "finding-1",
    checkId: "mg-002",
    severity: "WARNING",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    productTitle: "Widget",
    variantTitle: "Default",
    adminUrl: "https://admin.shopify.com/store/products/1",
    evidence: { foo: "bar" },
    explanation: "Price is below unit cost.",
    detectedAt: "2026-07-01T00:00:00.000Z",
    price: "8.00",
    compareAtPrice: "12.00",
    unitCost: "10.00",
    currency: "USD",
    sku: "SKU-123",
    barcode: "0123456789",
    productStatus: "ACTIVE",
    marginAmount: "-2.00",
    marginPercent: -25,
    ...overrides,
  };
}

describe("buildFindingsCsv", () => {
  it("emits the exact §9.6 header as the first line", () => {
    const csv = buildFindingsCsv([], { scanId: "scan-1", scannedAt: "2026-07-01T00:00:00.000Z" }, {});

    expect(csv.split("\r\n")[0]).toBe(EXPECTED_HEADER);
  });

  it("maps a FindingRow to a data row with check_name from the map and correct money/margin columns", () => {
    const row = makeRow();
    const csv = buildFindingsCsv(
      [row],
      { scanId: "scan-1", scannedAt: "2026-07-01T00:00:00.000Z" },
      { "mg-002": "Below-cost pricing" },
    );

    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    const fields = lines[1].split(",");

    expect(fields[0]).toBe("scan-1"); // scan_id
    expect(fields[1]).toBe("2026-07-01T00:00:00.000Z"); // scanned_at
    expect(fields[2]).toBe("WARNING"); // severity
    expect(fields[3]).toBe("mg-002"); // check_id
    expect(fields[4]).toBe("Below-cost pricing"); // check_name
    expect(fields[5]).toBe("gid://shopify/Product/1"); // product_id
    expect(fields[6]).toBe("Widget"); // product_title
    expect(fields[7]).toBe("gid://shopify/ProductVariant/1"); // variant_id
    expect(fields[8]).toBe("Default"); // variant_title
    expect(fields[9]).toBe("ACTIVE"); // product_status
    expect(fields[10]).toBe("8.00"); // price
    expect(fields[11]).toBe("12.00"); // compare_at_price
    expect(fields[12]).toBe("10.00"); // unit_cost
    expect(fields[13]).toBe("USD"); // currency
    expect(fields[14]).toBe("-2.00"); // margin_amount
    expect(fields[15]).toBe("-25.00"); // margin_percent
    expect(fields[16]).toBe("SKU-123"); // sku
    expect(fields[17]).toBe("0123456789"); // barcode
    expect(fields[18]).toBe("Price is below unit cost."); // explanation
    expect(fields[19]).toBe("https://admin.shopify.com/store/products/1"); // admin_url
  });

  it("falls back to the raw checkId as check_name when the map has no entry", () => {
    const row = makeRow({ checkId: "mg-999" });
    const csv = buildFindingsCsv([row], { scanId: "scan-1", scannedAt: "2026-07-01T00:00:00.000Z" }, {});

    const fields = csv.split("\r\n")[1].split(",");
    expect(fields[3]).toBe("mg-999");
    expect(fields[4]).toBe("mg-999");
  });

  it("handles null price/unitCost/sku/barcode without throwing and leaves those columns blank", () => {
    const row = makeRow({
      variantId: null,
      variantTitle: null,
      price: null,
      compareAtPrice: null,
      unitCost: null,
      currency: null,
      sku: null,
      barcode: null,
      productStatus: null,
    });

    const csv = buildFindingsCsv([row], { scanId: "scan-1", scannedAt: "2026-07-01T00:00:00.000Z" }, {});
    const fields = csv.split("\r\n")[1].split(",");

    expect(fields[9]).toBe(""); // product_status
    expect(fields[10]).toBe(""); // price
    expect(fields[11]).toBe(""); // compare_at_price
    expect(fields[12]).toBe(""); // unit_cost
    expect(fields[13]).toBe(""); // currency
    expect(fields[14]).toBe(""); // margin_amount
    expect(fields[15]).toBe(""); // margin_percent
    expect(fields[16]).toBe(""); // sku
    expect(fields[17]).toBe(""); // barcode
  });
});
