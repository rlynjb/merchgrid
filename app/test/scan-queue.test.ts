import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { CATALOG_API_VERSION } from "../app/config";
import {
  ActiveScanError,
  enqueueScan,
  getActiveScan,
} from "../app/services/scan/queue.server";

async function seedShop(settingsOverrides: Record<string, unknown> = {}) {
  return prisma.shop.create({
    data: {
      shopDomain: "scan-queue-test.myshopify.com",
      settings: { create: settingsOverrides },
    },
    include: { settings: true },
  });
}

describe("enqueueScan", () => {
  it("enqueues a QUEUED scan for a fresh shop with apiVersion and margin snapshot from settings", async () => {
    const shop = await seedShop({ minimumMarginPercent: 25 });

    const scan = await enqueueScan(shop.id);

    expect(scan.status).toBe("QUEUED");
    expect(scan.shopId).toBe(shop.id);
    expect(scan.apiVersion).toBe(CATALOG_API_VERSION);
    expect(scan.minimumMarginPercentUsed).toBe(25);
  });

  it("throws ActiveScanError when an active (non-terminal) scan already exists for the shop", async () => {
    const shop = await seedShop();
    await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "READING_CATALOG",
        apiVersion: CATALOG_API_VERSION,
        minimumMarginPercentUsed: 20,
      },
    });

    await expect(enqueueScan(shop.id)).rejects.toThrow(ActiveScanError);
  });

  it("succeeds again once the prior scan reached a terminal status (COMPLETED)", async () => {
    const shop = await seedShop();
    await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "COMPLETED",
        apiVersion: CATALOG_API_VERSION,
        minimumMarginPercentUsed: 20,
      },
    });

    const scan = await enqueueScan(shop.id);
    expect(scan.status).toBe("QUEUED");
  });

  it("throws a plain Error (not ActiveScanError) when the shop or its settings are missing", async () => {
    await expect(enqueueScan("does-not-exist")).rejects.toThrow();
    await expect(enqueueScan("does-not-exist")).rejects.not.toThrow(
      ActiveScanError,
    );
  });
});

describe("getActiveScan", () => {
  it("returns null when only terminal scans exist for the shop", async () => {
    const shop = await seedShop();
    await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "COMPLETED",
        apiVersion: CATALOG_API_VERSION,
        minimumMarginPercentUsed: 20,
      },
    });
    await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "FAILED",
        apiVersion: CATALOG_API_VERSION,
        minimumMarginPercentUsed: 20,
      },
    });

    expect(await getActiveScan(shop.id)).toBeNull();
  });

  it("returns the most recent non-terminal scan when one exists", async () => {
    const shop = await seedShop();
    const active = await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "RUNNING_CHECKS",
        apiVersion: CATALOG_API_VERSION,
        minimumMarginPercentUsed: 20,
      },
    });

    const found = await getActiveScan(shop.id);
    expect(found?.id).toBe(active.id);
  });
});
