import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import type { AdminGraphqlClient } from "../app/services/shopify/catalog-reader.server";
import {
  claimAndRunNext,
  type AdminFactory,
} from "../app/services/scan/worker-core.server";

const FIXED_NOW = "2026-07-14T00:00:00.000Z";

function variant(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: "Default Title",
    price: "10.00",
    compareAtPrice: null,
    sku: `SKU-${id}`,
    barcode: null,
    inventoryPolicy: "DENY",
    inventoryQuantity: 5,
    inventoryItem: {
      tracked: true,
      unitCost: { amount: "5.00", currencyCode: "USD" },
    },
    ...overrides,
  };
}

function product(id: string, variants: unknown[]) {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    status: "ACTIVE",
    handle: `product-${id}`,
    variants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: variants,
    },
  };
}

const PRODUCTS_PAGE = {
  data: {
    products: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        product("A", [
          // Priced below unit cost -> guarantees at least one finding
          // (mg-002, CRITICAL) so the test can assert findings were
          // actually persisted, not just that the scan completed.
          variant("a1", {
            price: "4.00",
            inventoryItem: {
              tracked: true,
              unitCost: { amount: "10.00", currencyCode: "USD" },
            },
          }),
          variant("a2"),
        ]),
      ],
    },
  },
};

function createFakeAdmin(): AdminGraphqlClient {
  return {
    async graphql(query: string) {
      if (query.includes("shop {") || query.includes("shop{")) {
        return {
          async json() {
            return { data: { shop: { currencyCode: "USD" } } };
          },
        };
      }
      if (query.includes("products")) {
        return {
          async json() {
            return PRODUCTS_PAGE;
          },
        };
      }
      throw new Error(`Unexpected query in fake admin: ${query}`);
    },
  };
}

async function seedShop(shopDomain: string) {
  return prisma.shop.create({
    data: {
      shopDomain,
      settings: { create: {} },
    },
    include: { settings: true },
  });
}

describe("claimAndRunNext", () => {
  it("returns null when there are no QUEUED scans", async () => {
    const factory: AdminFactory = async () => createFakeAdmin();
    expect(await claimAndRunNext(factory)).toBeNull();
  });

  it("claims the oldest QUEUED scan, runs it to COMPLETED, and returns its id", async () => {
    const shop = await seedShop("worker-core-test.myshopify.com");
    const scan = await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
      },
    });

    const seenDomains: string[] = [];
    const factory: AdminFactory = async (shopDomain) => {
      seenDomains.push(shopDomain);
      return createFakeAdmin();
    };

    const result = await claimAndRunNext(factory, { now: () => FIXED_NOW });

    expect(result).toBe(scan.id);
    expect(seenDomains).toEqual(["worker-core-test.myshopify.com"]);

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("COMPLETED");

    const findings = await prisma.finding.findMany({ where: { scanId: scan.id } });
    expect(findings.length).toBeGreaterThan(0);
  });

  it("fails a scan whose admin factory throws, returning its id and leaving no findings", async () => {
    const shop = await seedShop("worker-core-poison-test.myshopify.com");
    const scan = await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
      },
    });

    const factory: AdminFactory = async () => {
      // Simulates unauthenticated.admin(shopDomain) throwing because the
      // shop uninstalled and its Session row was deleted.
      throw new Error("no offline session for shop; internal detail xyz");
    };

    const result = await claimAndRunNext(factory, { now: () => FIXED_NOW });

    expect(result).toBe(scan.id);

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.failureCode).toBe("ADMIN_UNAVAILABLE");
    expect(updated.failureMessageSafe).toBe(
      "The scan could not be completed. Please try again.",
    );
    // Generic message must not leak the underlying error detail.
    expect(updated.failureMessageSafe).not.toContain("xyz");
    expect(updated.failedAt).toBeInstanceOf(Date);

    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(0);
  });

  it("advances past a poison-pill scan: fails the older broken one, then completes the newer working one (no livelock)", async () => {
    const brokenShop = await seedShop("worker-core-broken.myshopify.com");
    const workingShop = await seedShop("worker-core-working.myshopify.com");

    const older = await prisma.scan.create({
      data: {
        shopId: brokenShop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const newer = await prisma.scan.create({
      data: {
        shopId: workingShop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    });

    // Factory throws for the broken shop, works for the working shop —
    // exactly the mixed-fleet scenario where a livelock would starve the
    // healthy shop.
    const factory: AdminFactory = async (shopDomain) => {
      if (shopDomain === "worker-core-broken.myshopify.com") {
        throw new Error("no offline session for uninstalled shop");
      }
      return createFakeAdmin();
    };

    // First claim: the OLDER (broken) scan is selected and FAILED.
    const firstResult = await claimAndRunNext(factory, { now: () => FIXED_NOW });
    expect(firstResult).toBe(older.id);
    const olderUpdated = await prisma.scan.findUniqueOrThrow({ where: { id: older.id } });
    expect(olderUpdated.status).toBe("FAILED");

    // Second claim: with the broken scan no longer QUEUED, the newer scan
    // is now the oldest QUEUED and runs to COMPLETED — proving the broken
    // scan did not permanently block the queue.
    const secondResult = await claimAndRunNext(factory, { now: () => FIXED_NOW });
    expect(secondResult).toBe(newer.id);
    const newerUpdated = await prisma.scan.findUniqueOrThrow({ where: { id: newer.id } });
    expect(newerUpdated.status).toBe("COMPLETED");
    expect(
      await prisma.finding.count({ where: { scanId: newer.id } }),
    ).toBeGreaterThan(0);
  });

  it("picks the OLDER of two QUEUED scans first", async () => {
    const shop = await seedShop("worker-core-order-test.myshopify.com");

    const older = await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const newer = await prisma.scan.create({
      data: {
        shopId: shop.id,
        status: "QUEUED",
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    });

    const factory: AdminFactory = async () => createFakeAdmin();

    const result = await claimAndRunNext(factory, { now: () => FIXED_NOW });

    expect(result).toBe(older.id);

    const olderUpdated = await prisma.scan.findUniqueOrThrow({ where: { id: older.id } });
    const newerUpdated = await prisma.scan.findUniqueOrThrow({ where: { id: newer.id } });
    expect(olderUpdated.status).toBe("COMPLETED");
    expect(newerUpdated.status).toBe("QUEUED");
  });
});
