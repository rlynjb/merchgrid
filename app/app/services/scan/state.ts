/**
 * The scan pipeline's state machine. A scan moves forward through a fixed
 * sequence of stages and can fail out of any non-terminal stage; once it
 * reaches a terminal status (COMPLETED or FAILED) it never transitions
 * again. Enforcing this here (rather than trusting callers to set
 * `status` correctly) means a partial/aborted run can never be silently
 * relabeled as further along than it actually got.
 */
export type ScanStatus =
  | "QUEUED"
  | "READING_CATALOG"
  | "RUNNING_CHECKS"
  | "PREPARING_RESULTS"
  | "COMPLETED"
  | "FAILED";

const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set([
  "COMPLETED",
  "FAILED",
]);

// The single legal forward path through the pipeline.
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};

export function isTerminal(status: ScanStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Throws if `to` is not a legal transition from `from`. Legal transitions
 * are: the fixed forward pipeline step for `from`, or FAILED from any
 * non-terminal status. Terminal statuses (COMPLETED, FAILED) have no
 * outgoing transitions at all.
 */
export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) {
    throw new Error(
      `Illegal scan transition: ${from} is terminal and cannot transition to ${to}.`,
    );
  }

  if (to === "FAILED") {
    return;
  }

  if (LEGAL_FORWARD_TRANSITIONS[from] === to) {
    return;
  }

  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
