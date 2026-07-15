import { describe, expect, it } from "vitest";
import { mg009 } from "../src/checks/mg-009.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-009: same SKU has conflicting price or cost", () => {
  it("flags both variants when prices differ for the same normalized SKU", () => {
    const v1 = makeVariant({ variantId: "1", sku: "s1", price: "10", unitCost: "5" });
    const v2 = makeVariant({ variantId: "2", sku: "s1", price: "12", unitCost: "5" });
    const findings = mg009.run(makeCtx([v1, v2]));

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.checkId === "mg-009")).toBe(true);
    expect(findings.every((f) => f.severity === "WARNING")).toBe(true);
    expect(findings[0]?.evidence).toEqual({ sku: "s1", price: "10", unitCost: "5" });
    expect(findings[1]?.evidence).toEqual({ sku: "s1", price: "12", unitCost: "5" });
  });

  it("does not flag when price and cost are both identical for the same SKU", () => {
    const v1 = makeVariant({ variantId: "1", sku: "s1", price: "10", unitCost: "5" });
    const v2 = makeVariant({ variantId: "2", sku: "s1", price: "10", unitCost: "5" });
    expect(mg009.run(makeCtx([v1, v2]))).toHaveLength(0);
  });

  it("flags when one variant's cost is null and the other's is not", () => {
    const v1 = makeVariant({ variantId: "1", sku: "s1", price: "10", unitCost: null });
    const v2 = makeVariant({ variantId: "2", sku: "s1", price: "10", unitCost: "5" });
    expect(mg009.run(makeCtx([v1, v2]))).toHaveLength(2);
  });

  it("does not flag a single occurrence of a SKU", () => {
    const variant = makeVariant({ sku: "s1", price: "10", unitCost: "5" });
    expect(mg009.run(makeCtx([variant]))).toHaveLength(0);
  });
});
