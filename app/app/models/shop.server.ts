import type { Shop, ShopSettings } from "@prisma/client";
import prisma from "../db.server";

/**
 * Ensures a Shop row (with its nested ShopSettings) exists for the given
 * shop domain. Intended to be called after OAuth completes (see
 * `afterAuth` in shopify.server.ts), and safe to call repeatedly.
 *
 * - First call for a domain: creates the Shop and its default ShopSettings.
 * - Subsequent calls while installed: no duplication, installStatus/
 *   installedAt are left untouched.
 * - Subsequent calls after an uninstall: installStatus is reset to
 *   "INSTALLED" and uninstalledAt is cleared (reinstall).
 */
export async function ensureShop(
  shopDomain: string,
): Promise<Shop & { settings: ShopSettings | null }> {
  const shop = await prisma.shop.upsert({
    where: { shopDomain },
    create: {
      shopDomain,
      settings: { create: {} },
    },
    update: {
      installStatus: "INSTALLED",
      uninstalledAt: null,
    },
    include: { settings: true },
  });

  if (shop.settings == null) {
    const settings = await prisma.shopSettings.create({
      data: { shopId: shop.id },
    });
    return { ...shop, settings };
  }

  return shop;
}

/**
 * Deletes all data for the given shop domain (GDPR `shop/redact` webhook,
 * fired ~48h after uninstall). Deleting the Shop row cascades to its
 * ShopSettings/Scan/Finding/ScanArtifact rows.
 *
 * Idempotent: if no Shop matches the domain (already redacted, or never
 * existed), this is a no-op and does not throw.
 */
export async function redactShop(shopDomain: string): Promise<void> {
  await prisma.shop.deleteMany({ where: { shopDomain } });
}
