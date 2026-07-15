import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import {
  InvalidMarginError,
  getMinimumMargin,
  updateMinimumMargin,
} from "../app/models/settings.server";

async function createShop(shopDomain: string) {
  return prisma.shop.create({
    data: {
      shopDomain,
      settings: { create: {} },
    },
    include: { settings: true },
  });
}

describe("updateMinimumMargin", () => {
  it("updates the stored threshold and returns the saved value", async () => {
    const shop = await createShop("update-me.myshopify.com");

    const saved = await updateMinimumMargin("update-me.myshopify.com", 35);

    expect(saved).toBe(35);

    const settings = await prisma.shopSettings.findUnique({
      where: { shopId: shop.id },
    });
    expect(settings?.minimumMarginPercent).toBe(35);
  });

  it.each([-1, 91, 20.5, NaN])(
    "rejects an invalid percent (%s) and leaves the stored value unchanged",
    async (invalid) => {
      const shop = await createShop(`invalid-${String(invalid)}.myshopify.com`);

      await expect(
        updateMinimumMargin(`invalid-${String(invalid)}.myshopify.com`, invalid),
      ).rejects.toBeInstanceOf(InvalidMarginError);

      const settings = await prisma.shopSettings.findUnique({
        where: { shopId: shop.id },
      });
      expect(settings?.minimumMarginPercent).toBe(20);
    },
  );

  it("does not modify existing Scan.minimumMarginPercentUsed rows", async () => {
    const shop = await createShop("scan-untouched.myshopify.com");
    const scan = await prisma.scan.create({
      data: {
        shopId: shop.id,
        apiVersion: "2026-07",
        minimumMarginPercentUsed: 20,
      },
    });

    await updateMinimumMargin("scan-untouched.myshopify.com", 40);

    const reloaded = await prisma.scan.findUniqueOrThrow({
      where: { id: scan.id },
    });
    expect(reloaded.minimumMarginPercentUsed).toBe(20);
  });

  it("throws if the shop does not exist", async () => {
    await expect(
      updateMinimumMargin("missing.myshopify.com", 30),
    ).rejects.toThrow();
  });
});

describe("getMinimumMargin", () => {
  it("returns the current minimum margin percent", async () => {
    await createShop("get-me.myshopify.com");
    await updateMinimumMargin("get-me.myshopify.com", 42);

    const value = await getMinimumMargin("get-me.myshopify.com");

    expect(value).toBe(42);
  });

  it("throws if the shop does not exist", async () => {
    await expect(getMinimumMargin("missing.myshopify.com")).rejects.toThrow();
  });
});
