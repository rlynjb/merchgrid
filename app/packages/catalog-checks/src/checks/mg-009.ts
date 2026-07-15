import type { Money } from "@merchgrid/catalog-core";
import type { CatalogCheck } from "../contract.js";
import { eq } from "../money.js";
import { findingFor, groupBy, normalizeSku } from "./_helpers.js";

const CHECK_ID = "mg-009";

function differs(a: Money | null, b: Money | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return !eq(a, b);
}

export const mg009: CatalogCheck = {
  id: CHECK_ID,
  name: "Duplicate SKU has conflicting price or cost",
  description: "Flags variants sharing a SKU whose price or unit cost disagree.",
  run(ctx) {
    const groups = groupBy(ctx.variants, (v) => normalizeSku(v.sku));

    const findings = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;

      const [first, ...rest] = group;
      const conflicts = rest.some(
        (v) => differs(v.price, first!.price) || differs(v.unitCost, first!.unitCost),
      );
      if (!conflicts) continue;

      for (const v of group) {
        findings.push(
          findingFor(v, ctx, {
            checkId: CHECK_ID,
            severity: "WARNING",
            title: "Duplicate SKU has conflicting price or cost",
            explanation:
              "Variants sharing this SKU have different price or cost values. Verify whether they represent the same inventory item or should use separate SKUs.",
            evidence: { sku: v.sku, price: v.price, unitCost: v.unitCost },
          }),
        );
      }
    }

    return findings;
  },
};
