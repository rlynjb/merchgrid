import type { CatalogCheck } from "../contract.js";
import { lte } from "../money.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-001";

export const mg001: CatalogCheck = {
  id: CHECK_ID,
  name: "Active variant zero/negative price",
  description: "Flags active variants priced at zero or below.",
  run(ctx) {
    return ctx.variants
      .filter((v) => v.productStatus === "ACTIVE" && v.price !== null)
      .filter((v) => lte(v.price as string, "0"))
      .map((v) =>
        findingFor(v, ctx, {
          checkId: CHECK_ID,
          severity: "CRITICAL",
          title: "Active variant has zero or negative price",
          explanation:
            "This active variant is priced at zero or below. Customers may be able to purchase it at an unintended price.",
          evidence: { price: v.price },
        }),
      );
  },
};
