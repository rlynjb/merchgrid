import type { CatalogCheck, CatalogCheckContext, CatalogFinding } from "./contract.js";

export const ALL_CHECKS: CatalogCheck[] = []; // populated in later tasks

export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
