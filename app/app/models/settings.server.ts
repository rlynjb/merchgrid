import prisma from "../db.server";
import { MARGIN_MAX, MARGIN_MIN } from "./settings.shared";

export { MARGIN_MIN, MARGIN_MAX };

export class InvalidMarginError extends Error {}

function assertValidMargin(percent: number): void {
  if (
    typeof percent !== "number" ||
    Number.isNaN(percent) ||
    !Number.isInteger(percent) ||
    percent < MARGIN_MIN ||
    percent > MARGIN_MAX
  ) {
    throw new InvalidMarginError(
      `Enter a whole number between ${MARGIN_MIN} and ${MARGIN_MAX}.`,
    );
  }
}

async function getSettingsOrThrow(shopDomain: string) {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });

  if (shop == null || shop.settings == null) {
    throw new Error(`No settings found for shop "${shopDomain}".`);
  }

  return shop.settings;
}

/**
 * Returns the shop's current minimum gross margin screening threshold
 * (percent, 0-90). Throws if the shop or its settings row is missing.
 */
export async function getMinimumMargin(shopDomain: string): Promise<number> {
  const settings = await getSettingsOrThrow(shopDomain);
  return settings.minimumMarginPercent;
}

/**
 * Validates and persists a new minimum gross margin screening threshold for
 * the shop. Throws `InvalidMarginError` (user-safe message) if `percent` is
 * not an integer in [MARGIN_MIN, MARGIN_MAX]. Only ShopSettings is updated;
 * existing Scan rows keep the `minimumMarginPercentUsed` they were created
 * with, so past scans are unaffected by later threshold changes.
 */
export async function updateMinimumMargin(
  shopDomain: string,
  percent: number,
): Promise<number> {
  assertValidMargin(percent);

  const settings = await getSettingsOrThrow(shopDomain);

  const updated = await prisma.shopSettings.update({
    where: { id: settings.id },
    data: { minimumMarginPercent: percent },
  });

  return updated.minimumMarginPercent;
}
