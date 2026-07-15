import { describe, expect, it } from "vitest";
import {
  eq,
  formatMoney,
  gt,
  lt,
  lte,
  marginAmount,
  marginPercent,
  median,
  mul,
  sub,
} from "../src/money.js";

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

  it("mul multiplies decimal strings without float drift", () => {
    expect(eq(mul("11", "4"), "44")).toBe(true);
  });

  it("median returns the middle value for an odd-length list", () => {
    expect(eq(median(["10", "11", "100"]), "11")).toBe(true);
  });

  it("median averages the two middle values for an even-length list", () => {
    expect(eq(median(["10", "20", "30", "40"]), "25")).toBe(true);
  });

  it("marginAmount subtracts cost from price as a decimal string", () => {
    expect(eq(marginAmount("10.00", "8.00"), "2")).toBe(true);
  });

  it("marginAmount can be negative", () => {
    expect(eq(marginAmount("8.00", "10.00"), "-2")).toBe(true);
  });

  it("formatMoney pads to two decimal places by default", () => {
    expect(formatMoney("2")).toBe("2.00");
    expect(formatMoney("9.9")).toBe("9.90");
  });

  it("formatMoney rounds half-up at the default precision", () => {
    expect(formatMoney("10.005")).toBe("10.01");
  });

  it("formatMoney supports a custom decimal-places count", () => {
    expect(formatMoney("12.3", 0)).toBe("12");
  });
});
