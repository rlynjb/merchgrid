import { describe, expect, it } from "vitest";
import { eq, gt, lt, lte, marginPercent, sub } from "../src/money.js";

describe("money helpers", () => {
  it("lt compares decimal strings correctly", () => {
    expect(lt("9.99", "10.00")).toBe(true);
    expect(lt("10.00", "9.99")).toBe(false);
  });

  it("lte compares decimal strings correctly", () => {
    expect(lte("10.00", "10.00")).toBe(true);
    expect(lte("10.00", "9.99")).toBe(false);
  });

  it("eq treats differently-formatted equal decimals as equal", () => {
    expect(eq("10.00", "10.0")).toBe(true);
    expect(eq("10.00", "10.01")).toBe(false);
  });

  it("gt compares decimal strings correctly", () => {
    expect(gt("10.01", "10.00")).toBe(true);
    expect(gt("10.00", "10.01")).toBe(false);
  });

  it("sub subtracts decimal strings without float drift", () => {
    expect(eq(sub("10.00", "8.00"), "2")).toBe(true);
    expect(eq(sub("0.30", "0.10"), "0.20")).toBe(true);
  });

  it("marginPercent computes (price - cost) / price * 100", () => {
    expect(marginPercent("10.00", "8.00")).toBeCloseTo(20, 5);
    expect(marginPercent("10.00", "12.00")).toBeCloseTo(-20, 5);
  });

  it("marginPercent returns null when cost is null", () => {
    expect(marginPercent("10.00", null)).toBeNull();
  });

  it("marginPercent returns null when price is zero", () => {
    expect(marginPercent("0", "5.00")).toBeNull();
  });
});
