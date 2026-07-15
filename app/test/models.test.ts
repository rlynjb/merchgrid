import { describe, expect, it } from "vitest";
import prisma from "../app/db.server";

describe("domain models smoke test", () => {
  it("creates a Shop with a nested ShopSettings and reads it back", async () => {
    const shop = await prisma.shop.create({
      data: {
        shopDomain: "smoke-test.myshopify.com",
        settings: { create: {} },
      },
      include: { settings: true },
    });

    expect(shop.installStatus).toBe("INSTALLED");
    expect(shop.settings?.minimumMarginPercent).toBe(20);
    expect(shop.settings?.catalogVariantLimit).toBe(5000);
  });
});
