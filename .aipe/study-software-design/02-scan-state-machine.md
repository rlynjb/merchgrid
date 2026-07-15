# Scan state machine (`state.ts` + `assertTransition`)

### Finite state machine / guard clause — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the state machine lives

  ┌─ Queue layer ───────────────────────────────────────────────┐
  │  enqueueScan()  →  Scan row created at QUEUED                │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ Worker layer ──────────▼─────────────────────────────────┐
  │  claimAndRunNext()  →  runScan(scanId, admin)               │
  │                            │                                │
  │                    ★ THIS CONCEPT ★                          │
  │              assertTransition(from, to) at each step         │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ Storage layer ─────────▼─────────────────────────────────┐
  │  Scan.status column (QUEUED→READING_CATALOG→RUNNING_CHECKS │
  │  →PREPARING_RESULTS→COMPLETED | FAILED)                     │
  └──────────────────────────────────────────────────────────┘
```

A scan is a record that moves through five ordered stages and can fail out
of any of them, but must never move backward, skip a stage, or leave a
terminal stage. `state.ts` is 56 lines that make that guarantee true
regardless of what `runScan` does — the state machine is enforced, not just
followed.

## Structure pass

**Axis: who decides whether a transition is legal?**

```
  One system, the "who decides" axis traced across two files

  runner.server.ts   →  DECIDES to move forward (calls assertTransition)
  state.ts            →  DECIDES whether that move is ALLOWED (the guard)

  runner.server.ts owns the sequence; state.ts owns the rule.
  Neither file could enforce correctness alone.
```

**Seam:** the call `assertTransition(currentStatus, "READING_CATALOG")`
(`runner.server.ts:95`) is the boundary. `runScan` tracks
`currentStatus` as a local variable (line 83, with a comment explaining
why: so each assertion "guards the *real* current status... rather than a
hardcoded literal that would trivially always pass") and hands it to the
guard before every single write. That's the load-bearing detail: the guard
is worthless if the caller feeds it a status it assumes is true instead of
the one it just re-read.

**Layered decomposition — "what happens on failure" traced down:**

```
  "what does FAILED mean at each altitude?"

  ┌─────────────────────────────────┐
  │ state.ts        → FAILED is legal from ANY non-terminal state │
  └─────────────────────────────────┘
      ┌───────────────────────────────┐
      │ runner.server.ts → catches ANY exception, always → FAILED │
      └───────────────────────────────┘
          ┌───────────────────────────┐
          │ worker-core.server.ts → catches admin-factory failure, │
          │                          also → FAILED, before runScan │
          │                          even starts                   │
          └───────────────────────────┘
```
The same answer — "FAILED is always reachable, from anywhere, and it's
terminal" — holds at all three altitudes. That consistency is what makes
the machine trustworthy: there's no code path in the repo where a scan can
get stuck in a non-terminal state forever.

## How it works

### Move 1 — the mental model

You've built a `fetch()` wrapper with `idle` → `loading` → `success` /
`error` states before — same shape, one more stage in the middle, and a
harder rule: once you're in `success` or `error`, no more transitions,
ever. `state.ts` is a lookup table plus one guard function; it holds no
mutable state itself (the actual state lives on the `Scan` row in
Postgres/SQLite) — it's purely the rulebook other code consults.

### Move 2 variant — the load-bearing skeleton

**1. Isolate the kernel.**

```typescript
// app/app/services/scan/state.ts:9-28
export type ScanStatus =
  | "QUEUED" | "READING_CATALOG" | "RUNNING_CHECKS"
  | "PREPARING_RESULTS" | "COMPLETED" | "FAILED";

const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set(["COMPLETED", "FAILED"]);

const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```
The kernel is: one enum, one terminal-set, one forward-transition table.
Nothing else is required for this to be a state machine.

**2. Name each part by what breaks when it's missing.**

```typescript
// app/app/services/scan/state.ts:40-56
export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) {
    throw new Error(
      `Illegal scan transition: ${from} is terminal and cannot transition to ${to}.`,
    );
  }
  if (to === "FAILED") {
    return;                                    // FAILED reachable from anywhere non-terminal
  }
  if (LEGAL_FORWARD_TRANSITIONS[from] === to) {
    return;                                    // the one legal forward step
  }
  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
```
- Drop the `isTerminal(from)` check (lines 41-45) and a crashed worker that
  retries a `COMPLETED` scan could silently push it back to
  `READING_CATALOG` — re-running checks against a scan a merchant already
  viewed results for, corrupting a record that should never change again.
- Drop the `to === "FAILED"` early return (lines 47-49) and every one of
  the four call sites in `runScan` that needs to fail out mid-pipeline
  would need its own bespoke "is this a legal failure transition" check —
  exactly the special-case sprawl lens 6 of `audit.md` looks for.
- Drop the `LEGAL_FORWARD_TRANSITIONS[from] === to` check (lines 51-53)
  and nothing stops `runScan` from calling
  `assertTransition("QUEUED", "COMPLETED")` — skipping straight past
  reading the catalog and running checks, silently marking an empty scan
  done.

**3. Skeleton vs. hardening.** The kernel is the enum + the two lookup
structures + the guard function. There is no hardening layered on top in
this repo — no retry-on-illegal-transition, no transition history log. If
this machine grows an audit trail ("show me every status this scan passed
through and when"), that's the natural next layer to add without touching
the kernel.

### Move 3 — the principle

A state machine's value isn't the happy path — any code can call
`update({ status: "COMPLETED" })`. Its value is that the *illegal* paths
throw loudly, at the exact call site that would have caused them, before
a bad write reaches storage. `assertTransition` is 17 lines, but it's the
difference between "the scan pipeline usually behaves" and "the scan
pipeline cannot misbehave without an exception telling you exactly where."

## Primary diagram

```
  The scan state machine — legal forward path, FAILED reachable from any node

  ┌─────────┐    ┌──────────────────┐    ┌────────────────┐
  │ QUEUED  │───►│ READING_CATALOG  │───►│ RUNNING_CHECKS │
  └────┬────┘    └────────┬─────────┘    └───────┬────────┘
       │                  │                       │
       │                  ▼                       ▼
       │         ┌─────────────────────┐  ┌──────────────────┐
       └────────►│      FAILED         │◄─┤ PREPARING_RESULTS│
                 │  (terminal, no      │  └────────┬─────────┘
                 │   outgoing edges)   │           │
                 └─────────────────────┘           ▼
                                            ┌──────────────┐
                                            │  COMPLETED   │
                                            │  (terminal)  │
                                            └──────────────┘

  every arrow into FAILED is legal from any non-terminal box;
  no arrow ever points backward or skips a box
```

## Elaborate

Finite state machines are the standard tool anywhere a record has an
ordered lifecycle with a small number of legal transitions — order
statuses, CI pipeline stages, a video encode job. The specific discipline
worth carrying forward from this repo's instance: **track the actual
current state as a local variable re-derived from what you just wrote**
(`runner.server.ts:83`, "protecting against a mis-ordered pipeline"),
rather than trusting a hardcoded literal. A guard clause checked against
an assumption instead of a fact isn't really a guard.

## Interview defense

**Q: "Walk me through what stops a completed scan from being re-run."**
A: `runScan` checks `scan.status === "COMPLETED"` and returns early
(`runner.server.ts:73-75`) before touching the state machine at all — but
even if that early-return were removed, `assertTransition` would still
catch it: `isTerminal("COMPLETED")` is true, so the very first
`assertTransition(currentStatus, "READING_CATALOG")` call throws. Two
layers of defense for the same invariant.

**Q: "What's the part people forget to build?"**
A: FAILED being reachable from every non-terminal state *unconditionally*
— it's tempting to write a transition table that only allows FAILED from
specific "risky" states. That would mean some failure paths in `runScan`
need a different error-handling shape than others. The one-line
`if (to === "FAILED") return;` is what lets `runScan` wrap its *entire*
pipeline in one try/catch (see `audit.md` lens 6) instead of one per stage.

**Q: "Where's this design's real limit?"**
A: It's in-process, in-memory logic guarding a database write — it has no
transition history and can't answer "how long did this scan spend in
RUNNING_CHECKS" without adding timestamps per stage (which the `Scan`
model partially does: `startedAt`, `completedAt`, `failedAt`, but not one
per intermediate stage). Fine for an MVP where the merchant only cares
about the current state; a future ops dashboard wanting stage-by-stage
timing would need to extend the model, not the state machine itself.

## See also

- `audit.md` lens 6 (errors and special cases) — the try/catch this
  machine enables.
- `app/app/services/scan/runner.server.ts` — the only caller.
- `test/scan-state.test.ts` — the transition table's test coverage.
