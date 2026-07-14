import type { CatalogCheck, FindingSeverity } from "../contract.js";
import { eq, gt, lt } from "../money.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-004";

export const mg004: CatalogCheck = {
  id: CHECK_ID,
  name: "Invalid compare-at price",
  description: "Flags variants whose compare-at price is not a valid discount configuration.",
  run(ctx) {
    const findings = [];

    for (const v of ctx.variants) {
      if (v.price === null || v.compareAtPrice === null) continue;

      const price = v.price;
      const compareAtPrice = v.compareAtPrice;

      // A compare-at of "0" (or null, filtered above) means "not on sale" in Shopify; must not be flagged.
      if (!gt(compareAtPrice, "0")) continue;

      let severity: FindingSeverity | null = null;
      let explanation: string | null = null;

      if (lt(compareAtPrice, price)) {
        severity = "CRITICAL";
        explanation =
          "The compare-at price should normally be higher than the selling price. This sale configuration may display incorrectly or fail to communicate a valid discount.";
      } else if (eq(compareAtPrice, price)) {
        severity = "WARNING";
        explanation =
          "The compare-at price equals the selling price, so no discount is shown. This may be unintentional.";
      }

      if (severity === null || explanation === null) continue;

      findings.push(
        findingFor(v, ctx, {
          checkId: CHECK_ID,
          severity,
          title: "Invalid compare-at price",
          explanation,
          evidence: { price, compareAtPrice },
        }),
      );
    }

    return findings;
  },
};
