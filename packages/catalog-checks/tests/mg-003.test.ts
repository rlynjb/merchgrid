import { describe, expect, it } from "vitest";
import { mg003 } from "../src/checks/mg-003.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-003: margin below threshold", () => {
  it("flags a variant with margin below the threshold as WARNING", () => {
    const variant = makeVariant({ price: "10.00", unitCost: "8.50" });
    const findings = mg003.run(makeCtx([variant], 20));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("WARNING");
    expect(findings[0]?.checkId).toBe("mg-003");
    expect(findings[0]?.evidence.marginPercent).toBeCloseTo(15, 5);
    expect(findings[0]?.evidence.threshold).toBe(20);
  });

  it("does not flag a variant with margin above the threshold", () => {
    const variant = makeVariant({ price: "10.00", unitCost: "5.00" });
    expect(mg003.run(makeCtx([variant], 20))).toHaveLength(0);
  });

  it("flags a variant with exactly zero margin as WARNING", () => {
    const variant = makeVariant({ price: "10.00", unitCost: "10.00" });
    const findings = mg003.run(makeCtx([variant], 20));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("WARNING");
    expect(findings[0]?.evidence.marginPercent).toBeCloseTo(0, 5);
  });

  it("suppresses when price is below cost (MG-002's job)", () => {
    const variant = makeVariant({ price: "8.00", unitCost: "10.00" });
    expect(mg003.run(makeCtx([variant], 20))).toHaveLength(0);
  });

  it("does not flag when unit cost is null", () => {
    const variant = makeVariant({ price: "10.00", unitCost: null });
    expect(mg003.run(makeCtx([variant], 20))).toHaveLength(0);
  });
});
