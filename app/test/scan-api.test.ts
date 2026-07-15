import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { CATALOG_API_VERSION } from "../app/config";
import { ActiveScanError } from "../app/services/scan/queue.server";
import {
  ScanNotFoundError,
  startScan,
  getScanSummary,
  getScanFindings,
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
});
