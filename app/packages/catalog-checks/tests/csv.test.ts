import type { NormalizedVariant } from "@merchgrid/catalog-core";
import { describe, expect, it } from "vitest";
import type { CatalogFinding } from "../src/contract.js";
import { findingsToCsv } from "../src/csv.js";

const HEADER =
  "scan_id,scanned_at,severity,check_id,check_name,product_id,product_title,variant_id,variant_title,product_status,price,compare_at_price,unit_cost,currency,margin_amount,margin_percent,sku,barcode,explanation,admin_url";

const META = { scanId: "scan_1", scannedAt: "2026-07-14T00:00:00.000Z" };

function makeVariant(overrides: Partial<NormalizedVariant> = {}): NormalizedVariant {
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
    unitCost: "8.00",
    currencyCode: "USD",
    sku: "SKU-1",
    barcode: "BAR-1",
    tracksInventory: false,
    adminUrl: "https://admin.shopify.com/store/shop-1/products/1/variants/1",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<CatalogFinding> = {}): CatalogFinding {
  return {
    id: "mg-001:1",
    checkId: "mg-001",
    severity: "CRITICAL",
    shopId: "shop_1",
    productId: "1",
    variantId: "1",
    title: "Zero price",
    explanation: "This variant has a problem.",
    evidence: {},
    productTitle: "Test Product",
    variantTitle: "Default Title",
    adminUrl: "https://admin.shopify.com/store/shop-1/products/1/variants/1",
    detectedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("findingsToCsv", () => {
  it("emits the exact 20-column header as the first line", () => {
    const csv = findingsToCsv([], META);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(HEADER);
    expect(HEADER.split(",")).toHaveLength(20);
  });

  it("maps a normal row with margin_amount and margin_percent", () => {
    const csv = findingsToCsv(
      [{ finding: makeFinding(), variant: makeVariant() }],
      META,
    );
    const dataLine = csv.split("\r\n")[1]!;
    const cols = dataLine.split(",");
    // scan_id,scanned_at,severity,check_id,check_name,product_id,product_title,
    // variant_id,variant_title,product_status,price,compare_at_price,unit_cost,
    // currency,margin_amount,margin_percent,sku,barcode,explanation,admin_url
    expect(cols[0]).toBe("scan_1");
    expect(cols[1]).toBe("2026-07-14T00:00:00.000Z");
    expect(cols[2]).toBe("CRITICAL");
    expect(cols[3]).toBe("mg-001");
    expect(cols[10]).toBe("10.00"); // price
    expect(cols[12]).toBe("8.00"); // unit_cost
    expect(cols[14]).toBe("2.00"); // margin_amount
    expect(cols[15]).toBe("20.00"); // margin_percent
  });

  it("leaves unit_cost, margin_amount and margin_percent empty when unitCost is null", () => {
    const csv = findingsToCsv(
      [{ finding: makeFinding(), variant: makeVariant({ unitCost: null }) }],
      META,
    );
    const cols = csv.split("\r\n")[1]!.split(",");
    expect(cols[12]).toBe(""); // unit_cost
    expect(cols[14]).toBe(""); // margin_amount
    expect(cols[15]).toBe(""); // margin_percent
  });

  it("escapes fields containing commas, quotes and newlines per RFC 4180", () => {
    const csv = findingsToCsv(
      [
        {
          finding: makeFinding(),
          variant: makeVariant({ productTitle: 'Big, "Red" Tee\nSecond line' }),
        },
      ],
      META,
    );
    // product_title is column index 6 and, being quoted with an embedded
    // newline, spans across the naive \r\n split, so assert the exact
    // quoted substring instead.
    const expectedField = '"Big, ""Red"" Tee\nSecond line"';
    expect(csv).toContain(expectedField);
    // The inner newline must be preserved verbatim inside the quotes.
    expect(csv).toContain("Tee\nSecond line");
  });

  it("passes unicode through unchanged", () => {
    const csv = findingsToCsv(
      [{ finding: makeFinding(), variant: makeVariant({ productTitle: "Café ☕ Ünïcode" }) }],
      META,
    );
    expect(csv).toContain("Café ☕ Ünïcode");
  });

  it("renders null sku and barcode as empty columns, not the string 'null'", () => {
    const csv = findingsToCsv(
      [{ finding: makeFinding(), variant: makeVariant({ sku: null, barcode: null }) }],
      META,
    );
    const cols = csv.split("\r\n")[1]!.split(",");
    expect(cols[16]).toBe(""); // sku
    expect(cols[17]).toBe(""); // barcode
    expect(csv).not.toContain("null");
  });

  it("produces header + one line per row separated by \\r\\n", () => {
    const csv = findingsToCsv(
      [
        { finding: makeFinding(), variant: makeVariant() },
        { finding: makeFinding({ id: "mg-001:2" }), variant: makeVariant() },
      ],
      META,
    );
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 rows, no trailing newline
    expect(lines[0]).toBe(HEADER);
  });
});
