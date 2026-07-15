import { describe, expect, it } from "vitest";
import { ALL_CHECKS, runChecks } from "../src/run.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("engine: all ten checks run together without double-counting", () => {
  // Variants are given distinct productId/variantId so that group-based checks
  // (MG-005/006/008/009, which group by sku/barcode/productId) do not cross-react
  // between scenarios unless a scenario deliberately shares a key (the "DUP" sku pair).
  const vBelowCost = makeVariant({
    productId: "p1",
    variantId: "v-belowcost",
    productStatus: "ACTIVE",
    price: "8.00",
    unitCost: "10.00",
  });

  const vMissingCost = makeVariant({
    productId: "p2",
    variantId: "v-missingcost",
    productStatus: "ACTIVE",
    price: "10.00",
    unitCost: null,
  });

  const vLowMargin = makeVariant({
    productId: "p3",
    variantId: "v-lowmargin",
    productStatus: "ACTIVE",
    price: "10.00",
    unitCost: "8.50",
  });

  const vZero = makeVariant({
    productId: "p4",
    variantId: "v-zero",
    productStatus: "ACTIVE",
    price: "0",
    unitCost: "1.00",
  });

  const vDupA = makeVariant({
    productId: "p5",
    variantId: "v-dup-a",
    productStatus: "ACTIVE",
    price: "20.00",
    unitCost: "10.00",
    sku: "DUP",
  });

  const vDupB = makeVariant({
    productId: "p6",
    variantId: "v-dup-b",
    productStatus: "ACTIVE",
    price: "20.00",
    unitCost: "10.00",
    sku: "DUP",
  });

  const ctx = makeCtx([vBelowCost, vMissingCost, vLowMargin, vZero, vDupA, vDupB], 20);
  const findings = runChecks(ALL_CHECKS, ctx);

  it("flags V-belowcost with exactly MG-002 and suppresses MG-003 and MG-010", () => {
    const forVariant = findings.filter((f) => f.variantId === "v-belowcost");

    expect(forVariant.filter((f) => f.checkId === "mg-002")).toHaveLength(1);
    expect(forVariant.filter((f) => f.checkId === "mg-003")).toHaveLength(0);
    expect(forVariant.filter((f) => f.checkId === "mg-010")).toHaveLength(0);
  });

  it("flags V-missingcost with exactly MG-010 and suppresses MG-002 and MG-003", () => {
    const forVariant = findings.filter((f) => f.variantId === "v-missingcost");

    expect(forVariant.filter((f) => f.checkId === "mg-010")).toHaveLength(1);
    expect(forVariant.filter((f) => f.checkId === "mg-002")).toHaveLength(0);
    expect(forVariant.filter((f) => f.checkId === "mg-003")).toHaveLength(0);
  });

  it("flags V-lowmargin with MG-003 WARNING (margin 15% < 20% threshold)", () => {
    const forVariant = findings.filter((f) => f.variantId === "v-lowmargin");
    const mg003Findings = forVariant.filter((f) => f.checkId === "mg-003");

    expect(mg003Findings).toHaveLength(1);
    expect(mg003Findings[0]?.severity).toBe("WARNING");
  });

  it("flags V-zero with MG-001 CRITICAL (and MG-002, since 0 < 1.00 unit cost)", () => {
    const forVariant = findings.filter((f) => f.variantId === "v-zero");

    expect(forVariant.filter((f) => f.checkId === "mg-001")).toHaveLength(1);
    expect(forVariant.filter((f) => f.checkId === "mg-002")).toHaveLength(1);
    // MG-003 must be suppressed here too: price < unitCost is MG-002's job.
    expect(forVariant.filter((f) => f.checkId === "mg-003")).toHaveLength(0);
  });

  it("flags both DUP-sku variants with MG-005 WARNING", () => {
    const dupFindings = findings.filter(
      (f) => f.checkId === "mg-005" && (f.variantId === "v-dup-a" || f.variantId === "v-dup-b"),
    );
    expect(dupFindings).toHaveLength(2);
    for (const f of dupFindings) {
      expect(f.severity).toBe("WARNING");
    }
    // Identical price/cost between the duplicates must not also trigger MG-009 (conflict check).
    expect(findings.filter((f) => f.checkId === "mg-009")).toHaveLength(0);
  });

  it("matches the hand-computed severity totals for the whole run", () => {
    // Hand-computed expectation:
    //   CRITICAL:    v-zero -> MG-001 (1) + MG-002 (1)
    //                v-belowcost -> MG-002 (1)
    //                = 3
    //   WARNING:     v-lowmargin -> MG-003 (1)
    //                v-dup-a, v-dup-b -> MG-005 (2)
    //                = 3
    //   UNAVAILABLE: v-missingcost -> MG-010 (1)
    //                = 1
    //   TOTAL = 7
    const bySeverity = { CRITICAL: 0, WARNING: 0, UNAVAILABLE: 0 };
    for (const f of findings) {
      bySeverity[f.severity] += 1;
    }

    expect(bySeverity).toEqual({ CRITICAL: 3, WARNING: 3, UNAVAILABLE: 1 });
    expect(findings).toHaveLength(7);
  });

  it("stamps every finding with ctx.now as detectedAt and non-empty identifiers", () => {
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.detectedAt).toBe(ctx.now);
      expect(f.checkId.length).toBeGreaterThan(0);
      expect(f.id.length).toBeGreaterThan(0);
    }
  });
});
