import { describe, expect, it } from "vitest";
import { mg007 } from "../src/checks/mg-007.js";
import { makeCtx, makeVariant } from "./_fixtures.js";

describe("mg-007: inventory-tracked variant missing SKU", () => {
  it("flags a tracked variant with a null SKU", () => {
    const variant = makeVariant({ tracksInventory: true, sku: null });
    const findings = mg007.run(makeCtx([variant]));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("mg-007");
    expect(findings[0]?.severity).toBe("WARNING");
    expect(findings[0]?.evidence).toEqual({});
  });

  it("flags a tracked variant with a whitespace-only SKU", () => {
    const variant = makeVariant({ tracksInventory: true, sku: "  " });
    expect(mg007.run(makeCtx([variant]))).toHaveLength(1);
  });

  it("does not flag a tracked variant with a real SKU", () => {
    const variant = makeVariant({ tracksInventory: true, sku: "X" });
    expect(mg007.run(makeCtx([variant]))).toHaveLength(0);
  });

  it("does not flag an untracked variant with a null SKU", () => {
    const variant = makeVariant({ tracksInventory: false, sku: null });
    expect(mg007.run(makeCtx([variant]))).toHaveLength(0);
  });
});
