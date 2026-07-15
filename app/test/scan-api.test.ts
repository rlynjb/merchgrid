import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { CATALOG_API_VERSION } from "../app/config";
import { ActiveScanError } from "../app/services/scan/queue.server";
import {
  ScanNotFoundError,
  startScan,
  getScanSummary,
  getScanFindings,
  getActiveScanForShop,
  getAllFindingsForExport,
} from "../app/services/scan/scan-api.server";

async function seedShop(
  domain: string,
  settingsOverrides: Record<string, unknown> = {},
) {
  return prisma.shop.create({
    data: {
      shopDomain: domain,
      settings: { create: settingsOverrides },
    },
    include: { settings: true },
  });
}

async function seedScan(
  shopId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.scan.create({
    data: {
      shopId,
      status: "COMPLETED",
      apiVersion: CATALOG_API_VERSION,
      minimumMarginPercentUsed: 20,
      ...overrides,
    },
  });
}

async function seedFinding(
  scanId: string,
  shopId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.finding.create({
    data: {
      scanId,
      shopId,
      checkId: "check-a",
      severity: "WARNING",
      productId: "gid://shopify/Product/1",
      variantId: null,
      productTitle: "Some Product",
      variantTitle: null,
      adminUrl: "https://admin.shopify.com/some",
      evidenceJson: JSON.stringify({ foo: "bar" }),
      explanation: "Something is off.",
      detectedAt: new Date(),
      price: null,
      compareAtPrice: null,
      unitCost: null,
      currencyCode: null,
      sku: null,
      barcode: null,
      productStatus: null,
      ...overrides,
    },
  });
}

describe("startScan", () => {
  it("resolves the shop by domain and enqueues a QUEUED scan", async () => {
    const shop = await seedShop("scan-api-start.myshopify.com");

    const summary = await startScan(shop.shopDomain);

    expect(summary.status).toBe("QUEUED");
    expect(summary.id).toEqual(expect.any(String));
  });

  it("propagates ActiveScanError when a scan is already active for the shop", async () => {
    const shop = await seedShop("scan-api-start-active.myshopify.com");
    await seedScan(shop.id, { status: "READING_CATALOG" });

    await expect(startScan(shop.shopDomain)).rejects.toThrow(ActiveScanError);
  });

  it("throws when the shop domain does not resolve to a known shop", async () => {
    await expect(startScan("no-such-shop.myshopify.com")).rejects.toThrow();
  });
});

describe("getActiveScanForShop", () => {
  it("returns the active scan's summary when one is in flight", async () => {
    const shop = await seedShop("scan-api-active.myshopify.com");
    const scan = await seedScan(shop.id, { status: "READING_CATALOG" });

    const summary = await getActiveScanForShop(shop.shopDomain);

    expect(summary).not.toBeNull();
    expect(summary?.id).toBe(scan.id);
    expect(summary?.status).toBe("READING_CATALOG");
  });

  it("returns null when the shop only has terminal scans", async () => {
    const shop = await seedShop("scan-api-active-terminal.myshopify.com");
    await seedScan(shop.id, { status: "COMPLETED" });
    await seedScan(shop.id, { status: "FAILED" });

    const summary = await getActiveScanForShop(shop.shopDomain);

    expect(summary).toBeNull();
  });

  it("returns null for an unknown shop domain", async () => {
    const summary = await getActiveScanForShop(
      "scan-api-active-unknown.myshopify.com",
    );

    expect(summary).toBeNull();
  });
});

describe("getScanSummary — per-shop authorization", () => {
  it("returns the scan summary when the requesting shop owns the scan", async () => {
    const shopA = await seedShop("scan-api-a.myshopify.com");
    const scan = await seedScan(shopA.id);

    const summary = await getScanSummary(shopA.shopDomain, scan.id);

    expect(summary.id).toBe(scan.id);
    expect(summary.status).toBe("COMPLETED");
  });

  it("throws ScanNotFoundError when a different shop requests the scan", async () => {
    const shopA = await seedShop("scan-api-authz-a.myshopify.com");
    const shopB = await seedShop("scan-api-authz-b.myshopify.com");
    const scan = await seedScan(shopA.id);

    await expect(
      getScanSummary(shopB.shopDomain, scan.id),
    ).rejects.toThrow(ScanNotFoundError);
  });

  it("throws ScanNotFoundError for a nonexistent scan id", async () => {
    const shopA = await seedShop("scan-api-missing.myshopify.com");

    await expect(
      getScanSummary(shopA.shopDomain, "does-not-exist"),
    ).rejects.toThrow(ScanNotFoundError);
  });

  it("throws ScanNotFoundError when the shop domain itself is unknown", async () => {
    await expect(
      getScanSummary("unknown-shop.myshopify.com", "some-id"),
    ).rejects.toThrow(ScanNotFoundError);
  });
});

describe("getScanFindings", () => {
  it("returns findings sorted CRITICAL -> WARNING -> UNAVAILABLE then by checkId, with parsed evidence", async () => {
    const shop = await seedShop("scan-api-findings.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, {
      checkId: "z-check",
      severity: "UNAVAILABLE",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "b-check",
      severity: "CRITICAL",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "a-check",
      severity: "CRITICAL",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "m-check",
      severity: "WARNING",
      evidenceJson: JSON.stringify({ nested: { value: 42 } }),
    });

    const page = await getScanFindings(shop.shopDomain, scan.id);

    expect(page.findings.map((f) => [f.severity, f.checkId])).toEqual([
      ["CRITICAL", "a-check"],
      ["CRITICAL", "b-check"],
      ["WARNING", "m-check"],
      ["UNAVAILABLE", "z-check"],
    ]);
    expect(page.total).toBe(4);
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(50);

    const warningFinding = page.findings.find((f) => f.checkId === "m-check");
    expect(warningFinding?.evidence).toEqual({ nested: { value: 42 } });
    expect(typeof warningFinding?.evidence).toBe("object");
  });

  it("returns the denormalized per-variant fields on a FindingRow, mapping currency from currencyCode", async () => {
    const shop = await seedShop("scan-api-variant-fields.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, {
      checkId: "variant-fields-check",
      severity: "WARNING",
      price: "8.00",
      compareAtPrice: "12.00",
      unitCost: "10.00",
      currencyCode: "USD",
      sku: "SKU-123",
      barcode: "0123456789",
      productStatus: "ACTIVE",
    });

    const page = await getScanFindings(shop.shopDomain, scan.id);
    const finding = page.findings.find((f) => f.checkId === "variant-fields-check");

    expect(finding).toBeDefined();
    expect(finding!.price).toBe("8.00");
    expect(typeof finding!.price).toBe("string");
    expect(finding!.compareAtPrice).toBe("12.00");
    expect(finding!.unitCost).toBe("10.00");
    expect(finding!.currency).toBe("USD");
    expect(finding!.sku).toBe("SKU-123");
    expect(finding!.barcode).toBe("0123456789");
    expect(finding!.productStatus).toBe("ACTIVE");
  });

  it("returns nulls for the per-variant fields when a finding has no matching variant data", async () => {
    const shop = await seedShop("scan-api-variant-fields-null.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, { checkId: "no-variant-check" });

    const page = await getScanFindings(shop.shopDomain, scan.id);
    const finding = page.findings.find((f) => f.checkId === "no-variant-check");

    expect(finding).toBeDefined();
    expect(finding!.price).toBeNull();
    expect(finding!.compareAtPrice).toBeNull();
    expect(finding!.unitCost).toBeNull();
    expect(finding!.currency).toBeNull();
    expect(finding!.sku).toBeNull();
    expect(finding!.barcode).toBeNull();
    expect(finding!.productStatus).toBeNull();
  });

  it("paginates results using page/pageSize", async () => {
    const shop = await seedShop("scan-api-findings-page.myshopify.com");
    const scan = await seedScan(shop.id);

    for (let i = 0; i < 5; i++) {
      await seedFinding(scan.id, shop.id, {
        checkId: `check-${i}`,
        severity: "WARNING",
      });
    }

    const page1 = await getScanFindings(shop.shopDomain, scan.id, {
      page: 1,
      pageSize: 2,
    });
    const page2 = await getScanFindings(shop.shopDomain, scan.id, {
      page: 2,
      pageSize: 2,
    });

    expect(page1.findings).toHaveLength(2);
    expect(page2.findings).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page2.page).toBe(2);
    expect(page1.findings[0].id).not.toBe(page2.findings[0].id);
  });

  it("throws ScanNotFoundError when a different shop requests findings for the scan", async () => {
    const shopA = await seedShop("scan-api-findings-authz-a.myshopify.com");
    const shopB = await seedShop("scan-api-findings-authz-b.myshopify.com");
    const scan = await seedScan(shopA.id);
    await seedFinding(scan.id, shopA.id);

    await expect(
      getScanFindings(shopB.shopDomain, scan.id),
    ).rejects.toThrow(ScanNotFoundError);
  });

  it("filters by severity, reporting the filtered count as total", async () => {
    const shop = await seedShop("scan-api-findings-severity-filter.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, {
      checkId: "check-critical",
      severity: "CRITICAL",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "check-warning",
      severity: "WARNING",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "check-unavailable",
      severity: "UNAVAILABLE",
    });

    const page = await getScanFindings(shop.shopDomain, scan.id, {
      severity: "WARNING",
    });

    expect(page.findings).toHaveLength(1);
    expect(page.findings[0].severity).toBe("WARNING");
    expect(page.total).toBe(1);
  });

  it("filters by checkId", async () => {
    const shop = await seedShop("scan-api-findings-checkid-filter.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, { checkId: "check-a" });
    await seedFinding(scan.id, shop.id, { checkId: "check-b" });
    await seedFinding(scan.id, shop.id, { checkId: "check-b" });

    const page = await getScanFindings(shop.shopDomain, scan.id, {
      checkId: "check-b",
    });

    expect(page.findings).toHaveLength(2);
    expect(page.findings.every((f) => f.checkId === "check-b")).toBe(true);
    expect(page.total).toBe(2);
  });

  it("filters by free-text search across productTitle, variantTitle, sku, and barcode, case-insensitively, with total reflecting the filtered count", async () => {
    const shop = await seedShop("scan-api-findings-search-filter.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, {
      checkId: "check-sku-match",
      sku: "ABC-123",
      productTitle: "Unrelated product",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "check-title-match",
      productTitle: "Vintage Hoodie",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "check-no-match",
      productTitle: "Something else entirely",
      sku: "XYZ-999",
    });

    const bySku = await getScanFindings(shop.shopDomain, scan.id, {
      search: "abc-123",
    });
    expect(bySku.findings.map((f) => f.checkId)).toEqual(["check-sku-match"]);
    expect(bySku.total).toBe(1);

    const byTitle = await getScanFindings(shop.shopDomain, scan.id, {
      search: "hoodie",
    });
    expect(byTitle.findings.map((f) => f.checkId)).toEqual([
      "check-title-match",
    ]);
    expect(byTitle.total).toBe(1);
  });

  it("applies pagination AFTER filtering: total is the filtered count and the slice indexes into the filtered set", async () => {
    const shop = await seedShop("scan-api-findings-page-after-filter.myshopify.com");
    const scan = await seedScan(shop.id);

    // 3 CRITICAL + 2 WARNING. Distinct checkIds so the filtered set has a
    // deterministic sort order (severity then checkId).
    await seedFinding(scan.id, shop.id, { checkId: "crit-a", severity: "CRITICAL" });
    await seedFinding(scan.id, shop.id, { checkId: "crit-b", severity: "CRITICAL" });
    await seedFinding(scan.id, shop.id, { checkId: "crit-c", severity: "CRITICAL" });
    await seedFinding(scan.id, shop.id, { checkId: "warn-a", severity: "WARNING" });
    await seedFinding(scan.id, shop.id, { checkId: "warn-b", severity: "WARNING" });

    const page2 = await getScanFindings(shop.shopDomain, scan.id, {
      severity: "CRITICAL",
      page: 2,
      pageSize: 2,
    });

    // total reflects the FILTERED count (3 criticals), not all 5 findings.
    expect(page2.total).toBe(3);
    // page 2 of a filtered set of 3 with pageSize 2 => exactly 1 row (the 3rd
    // critical), proving the slice indexes into the filtered set, not the full 5.
    expect(page2.findings).toHaveLength(1);
    expect(page2.findings[0].severity).toBe("CRITICAL");
    expect(page2.findings[0].checkId).toBe("crit-c");
  });

  it("composes multiple filters with AND semantics", async () => {
    const shop = await seedShop("scan-api-findings-combined-filters.myshopify.com");
    const scan = await seedScan(shop.id);

    // Only this row matches BOTH severity=CRITICAL AND search "hoodie".
    await seedFinding(scan.id, shop.id, {
      checkId: "match-both",
      severity: "CRITICAL",
      productTitle: "Vintage Hoodie",
    });
    // Right severity, wrong search term.
    await seedFinding(scan.id, shop.id, {
      checkId: "crit-no-search",
      severity: "CRITICAL",
      productTitle: "Plain Tee",
    });
    // Right search term, wrong severity.
    await seedFinding(scan.id, shop.id, {
      checkId: "warn-with-search",
      severity: "WARNING",
      productTitle: "Deluxe Hoodie",
    });

    const page = await getScanFindings(shop.shopDomain, scan.id, {
      severity: "CRITICAL",
      search: "hoodie",
    });

    expect(page.findings.map((f) => f.checkId)).toEqual(["match-both"]);
    expect(page.total).toBe(1);
  });

  it("computes server-side margin fields when both price and unitCost are present, and null otherwise", async () => {
    const shop = await seedShop("scan-api-findings-margin.myshopify.com");
    const scan = await seedScan(shop.id);

    await seedFinding(scan.id, shop.id, {
      checkId: "check-with-margin",
      price: "20.00",
      unitCost: "8.00",
    });
    await seedFinding(scan.id, shop.id, {
      checkId: "check-no-cost",
      price: "20.00",
      unitCost: null,
    });

    const page = await getScanFindings(shop.shopDomain, scan.id);

    const withMargin = page.findings.find(
      (f) => f.checkId === "check-with-margin",
    );
    expect(withMargin?.marginAmount).toBe("12.00");
    expect(withMargin?.marginPercent).toBeCloseTo(60, 5);

    const noCost = page.findings.find((f) => f.checkId === "check-no-cost");
    expect(noCost?.marginAmount).toBeNull();
    expect(noCost?.marginPercent).toBeNull();
  });
});

describe("getAllFindingsForExport", () => {
  it("returns the scan summary and every finding for the owner, unpaginated and sorted", async () => {
    const shop = await seedShop("scan-api-export.myshopify.com");
    const scan = await seedScan(shop.id);

    for (let i = 0; i < 120; i++) {
      await seedFinding(scan.id, shop.id, {
        checkId: `check-${String(i).padStart(3, "0")}`,
        severity: "WARNING",
      });
    }
    await seedFinding(scan.id, shop.id, {
      checkId: "a-critical-check",
      severity: "CRITICAL",
    });

    const result = await getAllFindingsForExport(shop.shopDomain, scan.id);

    expect(result.summary.id).toBe(scan.id);
    expect(result.findings).toHaveLength(121);
    expect(result.findings[0].severity).toBe("CRITICAL");
    expect(result.findings[0].checkId).toBe("a-critical-check");
    expect(result.findings[1].severity).toBe("WARNING");
    expect(result.findings[1].checkId).toBe("check-000");
  });

  it("throws ScanNotFoundError when a different shop requests the export", async () => {
    const shopA = await seedShop("scan-api-export-authz-a.myshopify.com");
    const shopB = await seedShop("scan-api-export-authz-b.myshopify.com");
    const scan = await seedScan(shopA.id);
    await seedFinding(scan.id, shopA.id);

    await expect(
      getAllFindingsForExport(shopB.shopDomain, scan.id),
    ).rejects.toThrow(ScanNotFoundError);
  });

  it("throws ScanNotFoundError for a nonexistent scan id", async () => {
    const shop = await seedShop("scan-api-export-missing.myshopify.com");

    await expect(
      getAllFindingsForExport(shop.shopDomain, "does-not-exist"),
    ).rejects.toThrow(ScanNotFoundError);
  });
});
