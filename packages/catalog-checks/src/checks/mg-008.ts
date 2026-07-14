import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { CatalogCheck } from "../contract.js";
import { gt, lt, median, mul } from "../money.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-008";

export const mg008: CatalogCheck = {
  id: CHECK_ID,
  name: "Variant price is an outlier within its product",
  description: "Flags variants priced far away from the median price within their product.",
  run(ctx) {
    const groups = new Map<string, NormalizedVariant[]>();

    for (const v of ctx.variants) {
      const group = groups.get(v.productId) ?? [];
      group.push(v);
      groups.set(v.productId, group);
    }

    const findings = [];
    for (const group of groups.values()) {
      const positive = group.filter((v) => v.price !== null && gt(v.price, "0"));
      if (positive.length < 3) continue;

      const prices = positive.map((v) => v.price as string);
      const m = median(prices);
      const low = mul(m, "0.25");
      const high = mul(m, "4");

      for (const v of positive) {
        const price = v.price as string;
        if (!lt(price, low) && !gt(price, high)) continue;

        findings.push(
          findingFor(v, ctx, {
            checkId: CHECK_ID,
            severity: "WARNING",
            title: "Variant price is an outlier within its product",
            explanation:
              "This variant's price is significantly different from the other variants in the same product. This is a low-confidence signal; prices may legitimately differ by size, quantity, material, or options. Verify the difference is intentional.",
            evidence: { price, median: m, positiveVariantCount: positive.length },
          }),
        );
      }
    }

    return findings;
  },
};
