import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { redactShop } from "../app/models/shop.server";

describe("redactShop", () => {
  it("deletes the shop and cascades to its scans and findings", async () => {
    const shop = await prisma.shop.create({
      data: {
        shopDomain: "redact-me.myshopify.com",
        settings: { create: {} },
      },
    });

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
        adminUrl: "https://redact-me.myshopify.com/admin/products/1",
        evidenceJson: "{}",
        explanation: "No image set",
        detectedAt: new Date(),
      },
    });

    await redactShop("redact-me.myshopify.com");

    expect(
      await prisma.shop.count({ where: { shopDomain: "redact-me.myshopify.com" } }),
    ).toBe(0);
    expect(await prisma.scan.count({ where: { id: scan.id } })).toBe(0);
    expect(await prisma.finding.count({ where: { scanId: scan.id } })).toBe(0);
  });

  it("is idempotent and does not throw when the shop does not exist", async () => {
    const other = await prisma.shop.create({
      data: { shopDomain: "untouched.myshopify.com", settings: { create: {} } },
    });

    await expect(
      redactShop("nonexistent.myshopify.com"),
    ).resolves.toBeUndefined();

    const stillExists = await prisma.shop.count({ where: { id: other.id } });
    expect(stillExists).toBe(1);
  });
});
