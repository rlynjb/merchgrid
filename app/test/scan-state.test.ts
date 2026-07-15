import { describe, expect, it } from "vitest";
import {
  assertTransition,
  isTerminal,
  type ScanStatus,
} from "../app/services/scan/state";

const ALL_STATUSES: ScanStatus[] = [
  "QUEUED",
  "READING_CATALOG",
  "RUNNING_CHECKS",
  "PREPARING_RESULTS",
  "COMPLETED",
  "FAILED",
];

const NON_TERMINAL: ScanStatus[] = [
  "QUEUED",
  "READING_CATALOG",
  "RUNNING_CHECKS",
  "PREPARING_RESULTS",
];

const LEGAL_FORWARD: Array<[ScanStatus, ScanStatus]> = [
  ["QUEUED", "READING_CATALOG"],
  ["READING_CATALOG", "RUNNING_CHECKS"],
  ["RUNNING_CHECKS", "PREPARING_RESULTS"],
  ["PREPARING_RESULTS", "COMPLETED"],
];

describe("isTerminal", () => {
  it("is true for COMPLETED and FAILED", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(true);
  });

  it("is false for every non-terminal status", () => {
    for (const s of NON_TERMINAL) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe("assertTransition", () => {
  it("allows each legal forward transition in the pipeline", () => {
    for (const [from, to] of LEGAL_FORWARD) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("allows any non-terminal status to transition to FAILED", () => {
    for (const from of NON_TERMINAL) {
      expect(() => assertTransition(from, "FAILED")).not.toThrow();
    }
  });

  it("throws when skipping a stage", () => {
    expect(() => assertTransition("QUEUED", "COMPLETED")).toThrow();
    expect(() => assertTransition("READING_CATALOG", "PREPARING_RESULTS")).toThrow();
    expect(() => assertTransition("QUEUED", "RUNNING_CHECKS")).toThrow();
  });

  it("throws when going backwards", () => {
    expect(() => assertTransition("RUNNING_CHECKS", "READING_CATALOG")).toThrow();
    expect(() => assertTransition("PREPARING_RESULTS", "QUEUED")).toThrow();
  });

  it("throws for any transition out of a terminal status", () => {
    for (const to of ALL_STATUSES) {
      expect(() => assertTransition("COMPLETED", to)).toThrow();
      expect(() => assertTransition("FAILED", to)).toThrow();
    }
  });

  it("throws for a status transitioning to itself (except not modeled as legal)", () => {
    expect(() => assertTransition("QUEUED", "QUEUED")).toThrow();
    expect(() => assertTransition("READING_CATALOG", "READING_CATALOG")).toThrow();
  });
});
