import { describe, expect, it } from "vitest";
import { mg006 } from "../src/checks/mg-006.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-006: duplicate non-empty barcode", () => {
  it("flags both variants when barcodes match after trimming", () => {
    const v1 = makeVariant({ variantId: "1", barcode: "123" });
    const v2 = makeVariant({ variantId: "2", barcode: " 123 " });
    const findings = mg006.run(makeCtx([v1, v2]));

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.checkId === "mg-006")).toBe(true);
    expect(findings.every((f) => f.severity === "WARNING")).toBe(true);
    expect(findings[0]?.evidence).toEqual({ barcode: "123", duplicateCount: 2 });
    expect(findings[1]?.evidence).toEqual({ barcode: " 123 ", duplicateCount: 2 });
  });

  it("does not flag a single occurrence of a barcode", () => {
    const variant = makeVariant({ barcode: "999" });
    expect(mg006.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag variants with null or empty barcode", () => {
    const v1 = makeVariant({ variantId: "1", barcode: null });
    const v2 = makeVariant({ variantId: "2", barcode: "" });
    const v3 = makeVariant({ variantId: "3", barcode: "   " });
    expect(mg006.run(makeCtx([v1, v2, v3]))).toHaveLength(0);
  });

  it("treats barcodes as case-sensitive", () => {
    const v1 = makeVariant({ variantId: "1", barcode: "ABC" });
    const v2 = makeVariant({ variantId: "2", barcode: "abc" });
    expect(mg006.run(makeCtx([v1, v2]))).toHaveLength(0);
  });
});
