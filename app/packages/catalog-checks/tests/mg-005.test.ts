import { describe, expect, it } from "vitest";
import { mg005 } from "../src/checks/mg-005.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-005: duplicate non-empty SKU", () => {
  it("flags both variants when SKUs match case-insensitively after trimming", () => {
    const v1 = makeVariant({ variantId: "1", sku: "AB1" });
    const v2 = makeVariant({ variantId: "2", sku: " ab1 " });
    const findings = mg005.run(makeCtx([v1, v2]));

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.checkId === "mg-005")).toBe(true);
    expect(findings.every((f) => f.severity === "WARNING")).toBe(true);
    expect(findings[0]?.evidence).toEqual({
      sku: "AB1",
      normalizedSku: "ab1",
      duplicateCount: 2,
    });
    expect(findings[1]?.evidence).toEqual({
      sku: " ab1 ",
      normalizedSku: "ab1",
      duplicateCount: 2,
    });
  });

  it("does not flag a single occurrence of a SKU", () => {
    const variant = makeVariant({ sku: "X" });
    expect(mg005.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag variants with null or empty SKU", () => {
    const v1 = makeVariant({ variantId: "1", sku: null });
    const v2 = makeVariant({ variantId: "2", sku: "" });
    const v3 = makeVariant({ variantId: "3", sku: "   " });
    expect(mg005.run(makeCtx([v1, v2, v3]))).toHaveLength(0);
  });
});
