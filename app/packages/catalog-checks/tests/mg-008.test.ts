import { describe, expect, it } from "vitest";
import { mg008 } from "../src/checks/mg-008.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-008: variant price outlier within product", () => {
  it("flags the high outlier when prices are 10, 10, 100", () => {
    const v1 = makeVariant({ productId: "p1", variantId: "1", price: "10" });
    const v2 = makeVariant({ productId: "p1", variantId: "2", price: "10" });
    const v3 = makeVariant({ productId: "p1", variantId: "3", price: "100" });
    const findings = mg008.run(makeCtx([v1, v2, v3]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.variantId).toBe("3");
    expect(findings[0]?.checkId).toBe("mg-008");
    expect(findings[0]?.severity).toBe("WARNING");
    expect(findings[0]?.evidence).toEqual({
      price: "100",
      median: "10",
      positiveVariantCount: 3,
    });
  });

  it("flags the low outlier when prices are 1, 20, 20", () => {
    const v1 = makeVariant({ productId: "p1", variantId: "1", price: "1" });
    const v2 = makeVariant({ productId: "p1", variantId: "2", price: "20" });
    const v3 = makeVariant({ productId: "p1", variantId: "3", price: "20" });
    const findings = mg008.run(makeCtx([v1, v2, v3]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.variantId).toBe("1");
  });

  it("does not flag when prices are close together", () => {
    const v1 = makeVariant({ productId: "p1", variantId: "1", price: "10" });
    const v2 = makeVariant({ productId: "p1", variantId: "2", price: "11" });
    const v3 = makeVariant({ productId: "p1", variantId: "3", price: "12" });
    expect(mg008.run(makeCtx([v1, v2, v3]))).toHaveLength(0);
  });

  it("does not flag a product with only two positive-priced variants", () => {
    const v1 = makeVariant({ productId: "p1", variantId: "1", price: "10" });
    const v2 = makeVariant({ productId: "p1", variantId: "2", price: "1000" });
    expect(mg008.run(makeCtx([v1, v2]))).toHaveLength(0);
  });

  it("ignores non-positive or null prices when counting and computing the median", () => {
    const v1 = makeVariant({ productId: "p1", variantId: "1", price: "10" });
    const v2 = makeVariant({ productId: "p1", variantId: "2", price: "11" });
    const v3 = makeVariant({ productId: "p1", variantId: "3", price: "12" });
    const v4 = makeVariant({ productId: "p1", variantId: "4", price: "0" });
    const v5 = makeVariant({ productId: "p1", variantId: "5", price: null });
    expect(mg008.run(makeCtx([v1, v2, v3, v4, v5]))).toHaveLength(0);
  });
});
