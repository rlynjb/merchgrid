import { describe, expect, it } from "vitest";
import { mg004 } from "../src/checks/mg-004.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-004: invalid compare-at price", () => {
  it("does not flag when compareAtPrice is zero (not on sale)", () => {
    const variant = makeVariant({ price: "10.00", compareAtPrice: "0" });
    expect(mg004.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag when compareAtPrice is null", () => {
    const variant = makeVariant({ price: "10.00", compareAtPrice: null });
    expect(mg004.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("flags CRITICAL when compareAtPrice is below price", () => {
    const variant = makeVariant({ price: "10.00", compareAtPrice: "9.99" });
    const findings = mg004.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("CRITICAL");
    expect(findings[0]?.checkId).toBe("mg-004");
  });

  it("flags WARNING when compareAtPrice equals price", () => {
    const variant = makeVariant({ price: "10.00", compareAtPrice: "10.00" });
    const findings = mg004.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("WARNING");
  });

  it("does not flag when compareAtPrice is above price", () => {
    const variant = makeVariant({ price: "10.00", compareAtPrice: "15.00" });
    expect(mg004.run(makeCtx([variant]))).toHaveLength(0);
  });
});
