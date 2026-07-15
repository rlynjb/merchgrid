import type { CatalogCheck } from "../contract.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-010";

export const mg010: CatalogCheck = {
  id: CHECK_ID,
  name: "Unit cost missing",
  description: "Flags variants with no recorded unit cost, since below-cost and margin checks cannot run without it.",
  run(ctx) {
    return ctx.variants
      .filter((v) => v.unitCost == null)
      .map((v) =>
        findingFor(v, ctx, {
          checkId: CHECK_ID,
          severity: "UNAVAILABLE",
          title: "Unit cost missing",
          explanation:
            "Unit cost is missing or unavailable, so below-cost and margin checks could not be completed for this variant.",
          evidence: {},
        }),
      );
  },
};
