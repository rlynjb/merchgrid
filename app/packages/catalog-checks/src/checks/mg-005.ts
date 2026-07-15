import type { CatalogCheck } from "../contract.js";
import { findingFor, groupBy, normalizeSku } from "./_helpers.js";

const CHECK_ID = "mg-005";

export const mg005: CatalogCheck = {
  id: CHECK_ID,
  name: "Duplicate SKU",
  description: "Flags variants that share a normalized SKU with other variants.",
  run(ctx) {
    const groups = groupBy(ctx.variants, (v) => normalizeSku(v.sku));

    const findings = [];
    for (const [normalizedSku, group] of groups) {
      if (group.length < 2) continue;

      for (const v of group) {
        findings.push(
          findingFor(v, ctx, {
            checkId: CHECK_ID,
            severity: "WARNING",
            title: "Duplicate SKU",
            explanation:
              "This SKU is also assigned to other variants. Duplicate SKUs can create confusion in inventory, fulfillment, reporting, or external integrations. This may be intentional, for example bundles or shared inventory.",
            evidence: { sku: v.sku, normalizedSku, duplicateCount: group.length },
          }),
        );
      }
    }

    return findings;
  },
};
