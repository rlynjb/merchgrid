import type { CatalogCheck } from "../contract.js";
import { lt, marginPercent } from "../money.js";
import { findingFor } from "./_helpers.js";

const CHECK_ID = "mg-003";

export const mg003: CatalogCheck = {
  id: CHECK_ID,
  name: "Margin below threshold",
  description: "Flags variants whose estimated gross margin is below the configured minimum.",
  run(ctx) {
    const findings = [];

    for (const v of ctx.variants) {
      if (v.price === null || v.unitCost === null) continue;

      const price = v.price;
      const unitCost = v.unitCost;

      // Below-cost (negative margin) variants are MG-002's job; skip here to avoid double-flagging.
      if (lt(price, unitCost)) continue;

      const m = marginPercent(price, unitCost);
      if (m === null) continue;

      if (m < ctx.settings.minimumMarginPercent) {
        findings.push(
          findingFor(v, ctx, {
            checkId: CHECK_ID,
            severity: "WARNING",
            title: "Margin is below minimum threshold",
            explanation: `This variant's estimated gross margin is below your selected minimum of ${ctx.settings.minimumMarginPercent}%. This is an adjustable screening threshold, not business advice, and may be intentional.`,
            evidence: {
              price,
              unitCost,
              marginPercent: m,
              threshold: ctx.settings.minimumMarginPercent,
            },
          }),
        );
      }
    }

    return findings;
  },
};
