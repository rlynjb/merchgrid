import { describe, expect, it } from "vitest";
import { mg002 } from "../src/checks/mg-002.js";
import { eq } from "../src/money.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-002: selling price below unit cost", () => {
  it("flags a variant priced below its unit cost as CRITICAL", () => {
    const variant = makeVariant({ price: "8.00", unitCost: "10.00" });
    const findings = mg002.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("CRITICAL");
    expect(findings[0]?.checkId).toBe("mg-002");
    expect(eq(String(findings[0]?.evidence.lossPerUnit), "2")).toBe(true);
    expect(findings[0]?.evidence.marginPercent).toBeCloseTo(-25, 5);
  });

  it("does not flag a variant priced above its unit cost", () => {
    const variant = makeVariant({ price: "12.00", unitCost: "10.00" });
    expect(mg002.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag when unit cost is null", () => {
    const variant = makeVariant({ price: "8.00", unitCost: null });
    expect(mg002.run(makeCtx([variant]))).toHaveLength(0);
  });
});
