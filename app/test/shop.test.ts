import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { ensureShop } from "../app/models/shop.server";

describe("ensureShop", () => {
  it("creates a shop with default settings", async () => {
    const shop = await ensureShop("acme.myshopify.com");

    expect(shop.shopDomain).toBe("acme.myshopify.com");
    expect(shop.installStatus).toBe("INSTALLED");
    expect(shop.settings?.minimumMarginPercent).toBe(20);
    expect(shop.settings?.catalogVariantLimit).toBe(5000);
  });

  it("is idempotent: repeated calls do not duplicate the shop or its settings", async () => {
    await ensureShop("idempotent.myshopify.com");
    await ensureShop("idempotent.myshopify.com");

    const shopCount = await prisma.shop.count({
      where: { shopDomain: "idempotent.myshopify.com" },
    });
    const settingsCount = await prisma.shopSettings.count({
      where: { shop: { shopDomain: "idempotent.myshopify.com" } },
    });

    expect(shopCount).toBe(1);
    expect(settingsCount).toBe(1);
  });

  it("reinstalls a previously uninstalled shop, clearing uninstalledAt", async () => {
    const created = await ensureShop("reinstall.myshopify.com");

    await prisma.shop.update({
      where: { id: created.id },
      data: {
        installStatus: "UNINSTALLED",
        uninstalledAt: new Date(),
      },
    });

    const reinstalled = await ensureShop("reinstall.myshopify.com");

    expect(reinstalled.installStatus).toBe("INSTALLED");
    expect(reinstalled.uninstalledAt).toBeNull();

    const settingsCount = await prisma.shopSettings.count({
      where: { shop: { shopDomain: "reinstall.myshopify.com" } },
    });
    expect(settingsCount).toBe(1);
  });
});
