import type { CatalogCheck, CatalogCheckContext, CatalogFinding } from "./contract.js";
import { mg001 } from "./checks/mg-001.js";
import { mg002 } from "./checks/mg-002.js";
import { mg003 } from "./checks/mg-003.js";
import { mg004 } from "./checks/mg-004.js";
import { mg005 } from "./checks/mg-005.js";
import { mg006 } from "./checks/mg-006.js";
import { mg007 } from "./checks/mg-007.js";
import { mg008 } from "./checks/mg-008.js";
import { mg009 } from "./checks/mg-009.js";
import { mg010 } from "./checks/mg-010.js";

export const ALL_CHECKS: CatalogCheck[] = [
  mg001,
  mg002,
  mg003,
  mg004,
  mg005,
  mg006,
  mg007,
  mg008,
  mg009,
  mg010,
];

export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
