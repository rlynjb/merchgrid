import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { markShopUninstalled } from "../app/models/shop.server";

describe("markShopUninstalled", () => {
  it("marks the shop uninstalled but retains its scans and findings", async () => {
    const shop = await prisma.shop.create({
      data: {
        shopDomain: "uninstall-me.myshopify.com",
        settings: { create: {} },
      },
    });

    expect(shop.installStatus).toBe("INSTALLED");
    expect(shop.uninstalledAt).toBeNull();

    const scan = await prisma.scan.create({
      data: {
        shopId: shop.id,
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
      },
    });

    await prisma.finding.create({
      data: {
        scanId: scan.id,
        shopId: shop.id,
        checkId: "missing-image",
        severity: "WARNING",
        productId: "gid://shopify/Product/1",
        productTitle: "Test Product",
        adminUrl: "https://uninstall-me.myshopify.com/admin/products/1",
        evidenceJson: "{}",
        explanation: "No image set",
        detectedAt: new Date(),
      },
    });

    await markShopUninstalled("uninstall-me.myshopify.com");

    const updated = await prisma.shop.findUniqueOrThrow({
      where: { shopDomain: "uninstall-me.myshopify.com" },
    });

    expect(updated.installStatus).toBe("UNINSTALLED");
    expect(updated.uninstalledAt).toBeInstanceOf(Date);

    expect(
      await prisma.scan.count({ where: { shopId: shop.id } }),
    ).toBe(1);
    expect(
      await prisma.finding.count({ where: { shopId: shop.id } }),
    ).toBe(1);
  });

  it("is idempotent and does not throw when the shop does not exist", async () => {
    await expect(
      markShopUninstalled("nonexistent.myshopify.com"),
    ).resolves.toBeUndefined();
  });
});
