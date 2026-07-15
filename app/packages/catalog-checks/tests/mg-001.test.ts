import { describe, expect, it } from "vitest";
import { mg001 } from "../src/checks/mg-001.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-001: active variant zero/negative price", () => {
  it("flags an active variant priced at zero as CRITICAL", () => {
    const variant = makeVariant({ productStatus: "ACTIVE", price: "0" });
    const findings = mg001.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("CRITICAL");
    expect(findings[0]?.checkId).toBe("mg-001");
    expect(findings[0]?.id).toBe("mg-001:1");
    expect(findings[0]?.evidence.price).toBe("0");
  });

  it("flags an active variant priced negatively as CRITICAL", () => {
    const variant = makeVariant({ productStatus: "ACTIVE", price: "-5" });
    const findings = mg001.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("CRITICAL");
  });

  it("does not flag an active variant priced positively", () => {
    const variant = makeVariant({ productStatus: "ACTIVE", price: "10" });
    expect(mg001.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag a DRAFT variant priced at zero", () => {
    const variant = makeVariant({ productStatus: "DRAFT", price: "0" });
    expect(mg001.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag when price is null", () => {
    const variant = makeVariant({ productStatus: "ACTIVE", price: null });
    expect(mg001.run(makeCtx([variant]))).toHaveLength(0);
  });
});
