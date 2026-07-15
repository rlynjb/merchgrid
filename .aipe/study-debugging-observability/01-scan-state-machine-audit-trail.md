# Persisted state machine as audit trail (`Scan.status`)

**Persisted finite-state machine / status-column audit log** —
Language-agnostic pattern, project-specific implementation
(`Scan.status`, `app/app/services/scan/state.ts`).

## Zoom out, then zoom in

Okay — here's the whole thing. A merchant clicks "run scan." Nothing
about that click is observable again until either the report shows up
or an error banner does. Everything in between — four ordered stages,
a Shopify API call, a check pipeline, a database write — has to leave
some kind of trail, or debugging "why did this scan take forever" / "why
did it fail" becomes pure guesswork.

```
  Zoom out — where the state machine lives

  ┌─ UI layer ────────────────────────────────────────────────────┐
  │  app.scans.$id.tsx — polls every 2500ms, renders status        │
  └───────────────────────────┬───────────────────────────────────┘
                              │  loader → getScanSummary
  ┌─ Service layer ───────────▼───────────────────────────────────┐
  │  runner.server.ts: runScan()                                    │
  │  state.ts: assertTransition() ★ THIS CONCEPT ★                  │
  └───────────────────────────┬───────────────────────────────────┘
                              │  prisma.scan.update
  ┌─ Storage layer ───────────▼───────────────────────────────────┐
  │  SQLite: Scan row — status, failureCode, timestamps, counts     │
  └─────────────────────────────────────────────────────────────────┘
```

This is the same idea as a `fetch()` call's `loading` / `success` /
`error` states, stretched across four intermediate stages instead of
one, and — critically — written to durable storage at every step
instead of held only in a component's local state. That durability is
the whole point: a `fetch()`'s loading state disappears the moment the
tab closes; this scan's state machine survives a process crash, a
redeploy, and a merchant coming back three days later to check on it.

## The structure pass

**Axis: state — who owns it, where does it live, is it mutable?**
Trace this one question through the pipeline:

```
  One axis — "who owns the truth about this scan's progress?" — traced down

  ┌─ runner.server.ts: currentStatus (local variable) ─────────────┐
  │  in-memory, mutable, tracks the caller's INTENT               │
  └─────────────────────────┬───────────────────────────────────────┘
                            │  assertTransition() gates every write
  ┌─ Scan.status (DB column) ▼──────────────────────────────────────┐
  │  durable, the one FACT any other reader (UI, worker, a human    │
  │  querying the DB) can trust                                    │
  └─────────────────────────────────────────────────────────────────┘
```

**Seam: the `try`/`catch` boundary in `runScan`.** Inside the `try`,
`currentStatus` is a local variable that the code trusts and advances
optimistically, stage by stage. The `catch` block
(`app/app/services/scan/runner.server.ts:208-224`) is where that axis
flips: no matter how far `currentStatus` got, or what actually broke,
every failure collapses to exactly one persisted fact — `FAILED`, with
a code and a safe message. That collapse is load-bearing: it's what
makes "a scan is either COMPLETED, FAILED, or still running" a
guarantee you can query for, rather than something you have to infer
from a pile of possibly-inconsistent partial writes.

## How it works

**Move 1 — the mental model.** A scan is a finite-state machine with
exactly one legal forward path and one universal escape hatch. Every
stage transition is written to the database *before* the work for that
stage begins — not after — so a crash mid-stage leaves an accurate
"here's the last stage we know we started" marker, never a guess.

```
  The pattern — one forward path, one universal escape hatch

  QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED
    │                │                  │                   │
    └────────────────┴──────────────────┴───────────────────┴──────► FAILED
                        (from ANY non-terminal state)

  COMPLETED and FAILED are terminal — no outgoing edges at all.
```

**Move 2 — the walkthrough.**

**Part 1 — the legal-transition table is the skeleton.**
`state.ts` (`app/app/services/scan/state.ts:9-56`) defines the whole
machine in about 40 lines: a `TERMINAL_STATUSES` set, a
`LEGAL_FORWARD_TRANSITIONS` map, and `assertTransition(from, to)`,
which throws unless `to` is either the one legal forward step for
`from`, or `FAILED` from any non-terminal state
(`app/app/services/scan/state.ts:40-56`). What breaks if you remove
this and just trust callers to set `status` correctly: a bug in
pipeline ordering — say, a retry path that accidentally calls the
"mark COMPLETED" branch twice — could silently relabel a scan as
further along than it actually got, and nothing would catch it. The
guard is cheap (one function, no I/O) and it's what makes "the status
column is trustworthy" true instead of aspirational.

**Part 2 — `currentStatus` tracks the guard's input, not a hardcoded
literal.** This is the detail worth noticing: `runScan` doesn't call
`assertTransition("QUEUED", "READING_CATALOG")` with a literal — it
tracks `currentStatus` as a local variable and re-reads it before each
transition (`app/app/services/scan/runner.server.ts:83, 95-100, 111-116, 132-137`).

```
  Execution trace — currentStatus across one successful run

  step                          currentStatus (before)   assertTransition call
  ────────────────────────────  ───────────────────────  ─────────────────────
  scan loaded, status=QUEUED    QUEUED                   —
  before reading catalog        QUEUED                   assertTransition(QUEUED, READING_CATALOG)
  after DB write, in-memory     READING_CATALOG           —
  before running checks         READING_CATALOG           assertTransition(READING_CATALOG, RUNNING_CHECKS)
  after DB write, in-memory     RUNNING_CHECKS            —
  before preparing results      RUNNING_CHECKS            assertTransition(RUNNING_CHECKS, PREPARING_RESULTS)
  after DB write, in-memory     PREPARING_RESULTS         —
  before marking complete       PREPARING_RESULTS         assertTransition(PREPARING_RESULTS, COMPLETED)
```

Guarding against the *real* current status (not a literal that would
trivially always pass) is what makes the guard mean something — a
mis-ordered pipeline change would actually fail this assertion instead
of sailing through it.

**Part 3 — the atomic close-out is where a partial write becomes
impossible.** The final step wraps three operations in one
`prisma.$transaction` (`app/app/services/scan/runner.server.ts:187-207`):
delete any findings left over from a prior attempt, insert the fresh
set, and mark the scan `COMPLETED` — all or nothing. What breaks if
this weren't atomic: a crash between "findings inserted" and "status
set to COMPLETED" could leave a scan the UI would never show as done
(so the merchant's poll loop spins forever), or, worse, a crash between
"old findings deleted" and "new ones inserted" could leave a
`COMPLETED` scan with zero findings that looks like a clean catalog
when it's actually a lost write.

**Part 4 — the escape hatch, and why it's cheap.** The `catch` block
(`runner.server.ts:208-224`) doesn't need a transaction — it's a single
row update: `status: "FAILED"`, `failedAt`, `failureCode`,
`failureMessageSafe`. No matter which of the four stages threw, this
is the only write that happens, and it's unconditionally reachable
from every non-terminal status per `assertTransition`'s rule. (What
actually goes into that safe message, and why the real error never
does, is a different concept — see `02-safe-failure-messaging.md`.)

**Part 5 — the same shape, reused one layer up.** Before `runScan` is
even called, `claimAndRunNext` has its own terminal-state write for a
failure class `runScan` never sees: the Shopify admin client itself
failing to construct, typically because a shop uninstalled mid-flight
(`app/app/services/scan/worker-core.server.ts:47-75`). Same shape —
catch, log server-side, write one terminal fact, move on — reused at
the queue-claim layer instead of the pipeline layer. Naming this once
and pointing at both occurrences is the actual insight: this codebase
has one house pattern for "how do we terminate a unit of work we can't
complete," applied consistently at two different altitudes.

**Move 3 — the principle.** When you can't justify a full observability
stack, model failure *inside* your business state machine instead of
bolting monitoring on top of it. A `status` enum with a guarded
transition table and one universal failure edge gives you 80% of what
a job-tracking dashboard would, for the cost of one small file.

## Primary diagram

```
  The full picture — state machine + every write point + layer

  ┌─ UI ──────────────────────────────────────────────────────────┐
  │  polls Scan.status every 2500ms (app.scans.$id.tsx:512-519)     │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ read
  ┌─ Service (runner.server.ts) ▼─────────────────────────────────┐
  │  QUEUED → READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS │
  │     each edge: assertTransition() then prisma.scan.update()     │
  │                                    ↓ on ANY throw                │
  │                              catch → FAILED (single-row write)  │
  │  final edge: $transaction(delete findings, insert findings,     │
  │              mark COMPLETED) — all-or-nothing                   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ write
  ┌─ Storage (SQLite) ────────▼─────────────────────────────────────┐
  │  Scan: status · failureCode · failureMessageSafe · timestamps    │
  │  Finding: evidenceJson + denormalized display fields              │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same primitive every job queue reinvents — Sidekiq's job
statuses, a CI run's pass/fail/pending, a GitHub Actions workflow's
step-by-step status column. It's a lighter-weight cousin of full event
sourcing: this schema keeps only the *current* status plus three
milestone timestamps (`startedAt`, `completedAt`, `failedAt`), not an
append-only log of every transition that ever happened. That's a
deliberate, honest cost, not an oversight — this MVP only needs a
coarse progress bar and a terminal reason, not a compliance-grade
timeline. If a future requirement needed "show me every status change
and exactly when," the move is a `ScanTransition` append-only table
fed by the same `assertTransition` call site — the guard already knows
every transition that happens; it just doesn't currently write one
down anywhere but the parent row.

## Interview defense

**Q: How would you debug a scan that's been stuck in `RUNNING_CHECKS`
for an hour?**
A: Query the `Scan` row directly — `startedAt` tells you when it began
that stage's clock (actually `startedAt` is set once, at
`READING_CATALOG`, not per-stage, so I'd note that limitation too),
cross-reference `fly logs` for `[scan:<id>]` or `[worker]` lines around
that time, and check whether the worker process is even alive (per
`03-process-supervision-and-crash-containment.md`). The state machine
tells you *where* it got stuck; the logs (while they last) tell you
*why*.

```
  stuck scan — where to look, in order

  1. Scan.status         → confirms it's non-terminal, names the stage
  2. Scan.startedAt       → when the pipeline entered READING_CATALOG
  3. fly logs, grep scanId → last thing that happened before it went quiet
  4. is the worker alive? → 03-process-supervision-and-crash-containment.md
```

**Q: Why not just use one boolean `failed` flag instead of four
intermediate stages?**
A: Because the ordered stages buy you two things a boolean can't: the
UI can show real, meaningful progress instead of a spinner
(`ScanProgressCard`, `app.scans.$id.tsx:122-170`), and `assertTransition`
can actually validate that the pipeline advanced in the right order —
a single flag has nothing to validate against.

## See also

- `audit.md` §1 (observability-map) and §6
  (state-snapshots-and-debugging-boundaries)
- `02-safe-failure-messaging.md` — what actually goes into
  `failureMessageSafe`, and why the real error never does
- `03-process-supervision-and-crash-containment.md` — the same
  catch-log-terminate shape, reused at the process and poll-loop
  altitudes
