import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import type { AdminGraphqlClient } from "../app/services/shopify/catalog-reader.server";
import { runScan } from "../app/services/scan/runner.server";

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

// Fixture designed to trigger exactly one finding per targeted check and
// nothing else (verified against every one of the 10 checks):
//
//   Product A / a1: price 8.00 < unitCost 10.00  -> MG-002 CRITICAL
//                                                    (MG-003 explicitly
//                                                    suppresses below-cost
//                                                    variants, so it does
//                                                    NOT also fire here)
//   Product A / a2: unitCost null                -> MG-010 UNAVAILABLE
//   Product B / b1, b2: both SKU "DUP" (same      -> MG-005 WARNING x2
//     price/cost, so MG-009's "conflicting
//     price/cost" variant does NOT also fire)
//
// Expected totals: 1 CRITICAL, 2 WARNING, 1 UNAVAILABLE = 4 findings,
// across 4 variants processed.
const PRODUCTS_PAGE = {
  data: {
    products: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        product("A", [
          variant("a1", {
            price: "8.00",
            sku: "SKU-A1",
            inventoryItem: {
              tracked: true,
              unitCost: { amount: "10.00", currencyCode: "USD" },
            },
          }),
          variant("a2", {
            price: "10.00",
            sku: "SKU-A2",
            inventoryItem: { tracked: true, unitCost: null },
          }),
        ]),
        product("B", [
          variant("b1", {
            price: "15.00",
            sku: "DUP",
            inventoryItem: {
              tracked: true,
              unitCost: { amount: "9.00", currencyCode: "USD" },
            },
          }),
          variant("b2", {
            price: "15.00",
            sku: "DUP",
            inventoryItem: {
              tracked: true,
              unitCost: { amount: "9.00", currencyCode: "USD" },
            },
          }),
        ]),
      ],
    },
  },
};

function createFakeAdmin(opts: {
  currencyCode?: string;
  failProductsQuery?: boolean;
  productsPage?: unknown;
} = {}): AdminGraphqlClient {
  return {
    async graphql(query: string) {
      // NOTE: the products query itself requests a `currencyCode` field
      // (nested under unitCost), so dispatch on the more specific "shop {"
      // shape first — checking for "currencyCode" first would misroute the
      // products query to the shop-currency branch.
      if (query.includes("shop {") || query.includes("shop{")) {
        return {
          async json() {
            return { data: { shop: { currencyCode: opts.currencyCode ?? "USD" } } };
          },
        };
      }
      if (query.includes("products")) {
        if (opts.failProductsQuery) {
          // Simulate a real upstream failure carrying internal detail that
          // must never reach the persisted scan / end user.
          throw new Error(
            "Shopify GraphQL 500: internal trace id abc-123, table shard 7 unreachable",
          );
        }
        return {
          async json() {
            return opts.productsPage ?? PRODUCTS_PAGE;
          },
        };
      }
      throw new Error(`Unexpected query in fake admin: ${query}`);
    },
  };
}

async function seedShopAndScan(
  opts: { settings?: Record<string, unknown> | null } = {},
) {
  const shop = await prisma.shop.create({
    data: {
      shopDomain: "scan-runner-test.myshopify.com",
      // Default settings: minimumMarginPercent 20, catalogVariantLimit 5000.
      // Pass `settings: null` to seed a shop with NO ShopSettings row.
      ...(opts.settings === null ? {} : { settings: { create: opts.settings ?? {} } }),
    },
    include: { settings: true },
  });

  const scan = await prisma.scan.create({
    data: {
      shopId: shop.id,
      status: "QUEUED",
      apiVersion: "2026-07",
      minimumMarginPercentUsed: 20,
    },
  });

  return { shop, scan };
}

describe("runScan", () => {
  it("reads the catalog, runs checks, and persists findings + scan summary", async () => {
    const { scan } = await seedShopAndScan();
    const admin = createFakeAdmin();

    await runScan(scan.id, admin, { now: () => FIXED_NOW });

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.criticalCount).toBe(1);
    expect(updated.warningCount).toBe(2);
    expect(updated.unavailableCount).toBe(1);
    expect(updated.variantsProcessed).toBe(4);
    expect(updated.productsProcessed).toBe(2);
    expect(updated.partial).toBe(false);
    expect(updated.startedAt).toBeInstanceOf(Date);
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.failedAt).toBeNull();
    expect(updated.failureMessageSafe).toBeNull();

    const findings = await prisma.finding.findMany({ where: { scanId: scan.id } });
    expect(findings.length).toBe(4);

    const mg002 = findings.find((f) => f.checkId === "mg-002");
    expect(mg002).toBeDefined();
    expect(mg002!.severity).toBe("CRITICAL");
    const mg002Evidence = JSON.parse(mg002!.evidenceJson);
    expect(mg002Evidence).toHaveProperty("lossPerUnit");

    // Per-variant fields are denormalized onto the finding (from the fake
    // catalog's below-cost variant a1: price "8.00" < unitCost "10.00").
    // Money fields are stored verbatim as strings — never coerced to float.
    expect(mg002!.price).toBe("8.00");
    expect(typeof mg002!.price).toBe("string");
    expect(mg002!.unitCost).toBe("10.00");
    expect(mg002!.currencyCode).toBe("USD");
    expect(mg002!.sku).toBe("SKU-A1");
    expect(mg002!.compareAtPrice).toBeNull();
    expect(mg002!.barcode).toBeNull();
    expect(mg002!.productStatus).toBe("ACTIVE");

    const dupSkuFindings = findings.filter((f) => f.checkId === "mg-005");
    expect(dupSkuFindings.length).toBe(2);
    for (const f of dupSkuFindings) {
      expect(f.sku).toBe("DUP");
      expect(f.price).toBe("15.00");
      expect(f.unitCost).toBe("9.00");
    }

    for (const f of findings) {
      expect(f.detectedAt.toISOString()).toBe(FIXED_NOW);
    }

    const bySeverity = {
      CRITICAL: findings.filter((f) => f.severity === "CRITICAL").length,
      WARNING: findings.filter((f) => f.severity === "WARNING").length,
      UNAVAILABLE: findings.filter((f) => f.severity === "UNAVAILABLE").length,
    };
    expect(bySeverity).toEqual({ CRITICAL: 1, WARNING: 2, UNAVAILABLE: 1 });
  });

  it("is idempotent: completed scan is a no-op, and a retried (reset) scan does not duplicate findings", async () => {
    const { scan } = await seedShopAndScan();
    const admin = createFakeAdmin();

    await runScan(scan.id, admin, { now: () => FIXED_NOW });
    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(4);

    // Re-running an already-COMPLETED scan is a no-op (returns early).
    await runScan(scan.id, admin, { now: () => FIXED_NOW });
    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(4);

    // Simulate a retry: caller resets the scan back to QUEUED.
    await prisma.scan.update({ where: { id: scan.id }, data: { status: "QUEUED" } });
    await runScan(scan.id, admin, { now: () => FIXED_NOW });

    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(4);
    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("COMPLETED");
  });

  it("marks the scan FAILED with a generic message and leaves no findings when the pipeline throws", async () => {
    const { scan } = await seedShopAndScan();
    const admin = createFakeAdmin({ failProductsQuery: true });

    await runScan(scan.id, admin, { now: () => FIXED_NOW });

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.failureCode).toBe("SCAN_FAILED");
    expect(updated.failureMessageSafe).toBe(
      "The scan could not be completed. Please try again.",
    );
    expect(updated.failureMessageSafe).not.toContain("trace id");
    expect(updated.failureMessageSafe).not.toContain("shard");
    expect(updated.completedAt).toBeNull();
    expect(updated.failedAt).toBeInstanceOf(Date);

    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(0);
  });

  it("routes a post-load precondition failure (missing ShopSettings) to FAILED, not stuck", async () => {
    const { scan } = await seedShopAndScan({ settings: null });
    const admin = createFakeAdmin();

    await runScan(scan.id, admin, { now: () => FIXED_NOW });

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.status).not.toBe("QUEUED");
    expect(updated.failureCode).toBe("SCAN_FAILED");
    expect(updated.failureMessageSafe).toBe(
      "The scan could not be completed. Please try again.",
    );
    expect(updated.failedAt).toBeInstanceOf(Date);
    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(0);
  });

  it("completes but flags partial=true when the catalog read is truncated at the variant limit", async () => {
    // catalogVariantLimit 2 + a products page that reports more pages
    // available (hasNextPage: true) and holds more than 2 variants, so
    // readCatalog stops early and returns partial: true.
    const { scan } = await seedShopAndScan({ settings: { catalogVariantLimit: 2 } });

    const truncatedPage = {
      data: {
        products: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          nodes: [
            product("P1", [variant("p1a"), variant("p1b")]),
            product("P2", [variant("p2a")]),
          ],
        },
      },
    };

    const admin = createFakeAdmin({ productsPage: truncatedPage });

    await runScan(scan.id, admin, { now: () => FIXED_NOW });

    const updated = await prisma.scan.findUniqueOrThrow({ where: { id: scan.id } });
    expect(updated.status).toBe("COMPLETED");
    expect(updated.partial).toBe(true);
    expect(updated.variantsProcessed).toBeGreaterThanOrEqual(2);
  });
});
