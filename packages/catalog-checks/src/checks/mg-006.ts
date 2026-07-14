import type { NormalizedVariant } from "@merchgrid/catalog-core";
import type { CatalogCheck } from "../contract.js";
import { findingFor, normalizeBarcode } from "./_helpers.js";

const CHECK_ID = "mg-006";

export const mg006: CatalogCheck = {
  id: CHECK_ID,
  name: "Duplicate barcode",
  description: "Flags variants that share a normalized barcode with other variants.",
  run(ctx) {
    const groups = new Map<string, NormalizedVariant[]>();

    for (const v of ctx.variants) {
      const normalizedBarcode = normalizeBarcode(v.barcode);
      if (normalizedBarcode === null) continue;

      const group = groups.get(normalizedBarcode) ?? [];
      group.push(v);
      groups.set(normalizedBarcode, group);
    }

    const findings = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;

      for (const v of group) {
        findings.push(
          findingFor(v, ctx, {
            checkId: CHECK_ID,
            severity: "WARNING",
            title: "Duplicate barcode",
            explanation:
              "This barcode is assigned to more than one variant. Duplicate barcodes can cause scanning, marketplace, or fulfillment problems. This may be intentional for equivalent products, but review it.",
            evidence: { barcode: v.barcode, duplicateCount: group.length },
          }),
        );
      }
    }

    return findings;
  },
};
