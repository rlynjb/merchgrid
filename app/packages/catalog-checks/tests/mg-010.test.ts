import { describe, expect, it } from "vitest";
import { mg010 } from "../src/checks/mg-010.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-010: unit cost missing", () => {
  it("flags a variant with unitCost null as UNAVAILABLE", () => {
    const variant = makeVariant({ unitCost: null });
    const findings = mg010.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("UNAVAILABLE");
    expect(findings[0]?.checkId).toBe("mg-010");
    expect(findings[0]?.id).toBe("mg-010:1");
    expect(findings[0]?.title).toBe("Unit cost missing");
    expect(findings[0]?.evidence).toEqual({});
  });

  it("does not flag a variant with a unit cost present", () => {
    const variant = makeVariant({ unitCost: "5.00" });
    expect(mg010.run(makeCtx([variant]))).toHaveLength(0);
  });
});
