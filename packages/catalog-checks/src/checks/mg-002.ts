import type { CatalogCheck } from "../contract.js";
import { lt, marginPercent, sub } from "../money.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-002";

export const mg002: CatalogCheck = {
  id: CHECK_ID,
  name: "Selling price below unit cost",
  description: "Flags variants priced below their recorded unit cost.",
  run(ctx) {
    return ctx.variants
      .filter((v) => v.price !== null && v.unitCost !== null)
      .filter((v) => lt(v.price as string, v.unitCost as string))
      .map((v) => {
        const price = v.price as string;
        const unitCost = v.unitCost as string;
        return findingFor(v, ctx, {
          checkId: CHECK_ID,
          severity: "CRITICAL",
          title: "Selling price is below recorded unit cost",
          explanation:
            "This variant is priced below its recorded unit cost. It may lose money before payment, shipping, and operating expenses.",
          evidence: {
            price,
            unitCost,
            lossPerUnit: sub(unitCost, price),
            marginPercent: marginPercent(price, unitCost),
          },
        });
      });
  },
};
