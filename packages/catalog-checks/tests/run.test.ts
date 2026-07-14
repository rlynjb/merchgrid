import { describe, expect, it } from "vitest";
import { runChecks } from "../src/run.js";
import type { CatalogCheckContext } from "../src/contract.js";

describe("runChecks", () => {
  it("returns an empty array when there are no checks", () => {
    const ctx: CatalogCheckContext = {
      variants: [],
      settings: { minimumMarginPercent: 10 },
      now: "2026-07-14T00:00:00.000Z",
    };

    expect(runChecks([], ctx)).toEqual([]);
  });
});
