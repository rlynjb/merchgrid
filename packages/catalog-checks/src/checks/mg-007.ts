import type { CatalogCheck } from "../contract.js";
import { findingFor, normalizeSku } from "./_helpers.js";

const CHECK_ID = "mg-007";

export const mg007: CatalogCheck = {
  id: CHECK_ID,
  name: "Inventory-tracked variant has no SKU",
  description: "Flags inventory-tracked variants that have no SKU.",
  run(ctx) {
    return ctx.variants
      .filter((v) => v.tracksInventory === true)
      .filter((v) => normalizeSku(v.sku) === null)
      .map((v) =>
        findingFor(v, ctx, {
          checkId: CHECK_ID,
          severity: "WARNING",
          title: "Inventory-tracked variant has no SKU",
          explanation:
            "This variant tracks inventory but has no SKU. A missing SKU may make fulfillment, inventory reconciliation, and integrations harder to manage.",
          evidence: {},
        }),
      );
  },
};
