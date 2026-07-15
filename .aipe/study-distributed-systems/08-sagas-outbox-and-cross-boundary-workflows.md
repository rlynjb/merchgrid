# Cross-Boundary Workflows: Sagas and Compensation

Saga pattern / compensating transaction — Industry standard —
**transactional outbox not yet exercised**

## Zoom out, then zoom in

```
  Zoom out — where the workflow sits

  ┌─ Service layer ─────────────────────────────────────────────┐
  │  ★ THE SCAN WORKFLOW ★ — runScan(): a multi-step operation   │ ← we are here
  │  crossing the Shopify boundary, unwindable if any step fails  │
  └───────────────────────┬────────────────────────────────────────┘
                          │ step 3 crosses out to Shopify, steps 1/2/4/5 are local
  ┌─ Storage + Provider ───▼──────────────────────────────────────┐
  │  local: Scan state machine, Finding writes (atomic)             │
  │  external: Shopify Admin API (read-only, no compensation needed)│
  └────────────────────────────────────────────────────────────────────┘
```

A saga exists because a single ACID transaction can't span two independent
systems — you can't wrap "call Shopify's API" and "write to SQLite" in one
database transaction, because Shopify has no idea your transaction exists.
`runScan` is a small, honest example of exactly this shape: a sequence of
steps, one of which crosses out to an external system, with the local
steps rolled forward through an explicit state machine and a clear,
compensating "undo" path for when any step fails. It's simpler than a
textbook saga specifically because the external step here is a read, which
removes the hardest part of saga design (compensating actions for external
writes) entirely.

## Structure pass — layers, axis, seams

**Layers:** the state machine (`state.ts`) → the orchestrator (`runScan`)
→ the one external call (`readCatalog`) → the local persistence step (the
`$transaction`).

**The axis: failure — where can this workflow break, and what happens to
already-completed steps when it does?**

```
  Failure axis across the workflow's steps

  step 1 (mark READING_CATALOG)  →  fails → scan stuck at prior status,
                                     caught by outer try/catch → FAILED
  step 2 (readCatalog, EXTERNAL) →  fails → nothing written yet locally,
                                     caught → FAILED, no compensation needed
  step 3 (normalize + runChecks) →  pure functions, can't partially fail
  step 4 (persist findings)      →  all-or-nothing via $transaction
                                     (can't fail "partway")
```

**The seam: the boundary crossing (step 2) needs no compensation, because
it's read-only.** This is the single biggest reason `runScan` doesn't need
real saga machinery (compensating transactions, a saga-orchestrator
service, an event log of completed steps). A classic saga compensates for
committed *writes* on the far side of the boundary (refund a payment,
cancel a shipment). `readCatalog` never writes anything to Shopify — the
whole app is read-only by design (`read_products,read_inventory` scopes
only) — so there's nothing on the far side that ever needs undoing.
Compensation here only has to unwind *local* state, which is what the state
machine plus the atomic transaction actually do.

## How it works

### Move 1 — the mental model

You've built a multi-step form wizard with a `currentStep` piece of state
that only moves forward, and a global error boundary that catches anything
thrown mid-flow and resets to an error screen instead of leaving the UI in
an inconsistent half-completed state. `runScan` is that same shape at the
backend: `currentStatus` only moves forward through a fixed sequence, and
one `try/catch` wraps the entire flow so any failure — at any step —
routes to the same terminal `FAILED` state rather than leaving the `Scan`
row stuck showing a status it never actually reached.

```
  Pattern: forward-only pipeline, one compensating path

  status = QUEUED
  try:
    for each step in [READING_CATALOG, RUNNING_CHECKS, PREPARING_RESULTS, COMPLETED]:
      assertTransition(status, step)     // guards against skipping/reordering
      perform step's work
      status = step
    commit all local writes atomically   // findings + final COMPLETED, one unit
  except AnyFailure:
    status = FAILED                       // the one compensating action
```

### Move 2 — the state machine, the orchestrator, and the atomic commit

**The state machine as the workflow's contract**
(`app/app/services/scan/state.ts:9-56`):

```ts
export type ScanStatus = "QUEUED" | "READING_CATALOG" | "RUNNING_CHECKS" | "PREPARING_RESULTS" | "COMPLETED" | "FAILED";
const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set(["COMPLETED", "FAILED"]);
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG", READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS", PREPARING_RESULTS: "COMPLETED",
};
export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) throw new Error(`Illegal scan transition: ${from} is terminal...`);
  if (to === "FAILED") return;                        // FAILED reachable from anywhere non-terminal
  if (LEGAL_FORWARD_TRANSITIONS[from] === to) return;
  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
```
This is a saga's "step definition" made explicit and machine-checked: only
one legal next step from any non-terminal status, `FAILED` reachable from
anywhere non-terminal (the universal compensating transition), and terminal
statuses have *no* outgoing transitions at all — once `COMPLETED` or
`FAILED`, the workflow is closed for good. The docstring
(`state.ts:1-8`) names the exact bug this prevents: *"a partial/aborted run
can never be silently relabeled as further along than it actually got."*

**The orchestrator, tracking real status rather than trusting a literal**
(`app/app/services/scan/runner.server.ts:83,95-139`):

```ts
let currentStatus = scan.status as ScanStatus;
...
assertTransition(currentStatus, "READING_CATALOG");
await prisma.scan.update({ where: { id: scanId }, data: { status: "READING_CATALOG", startedAt: new Date() } });
currentStatus = "READING_CATALOG";
const raw = await readCatalog(admin, { variantLimit: settings.catalogVariantLimit, ... });  // ← the boundary crossing
assertTransition(currentStatus, "RUNNING_CHECKS");
...
```
Notice `currentStatus` is a *local variable* tracking what actually
happened in this run, not a hardcoded literal passed to each
`assertTransition` call. The docstring comment at lines 79-82 explains why
that distinction matters: guarding against "the *real* current status
(protecting against a mis-ordered pipeline) rather than a hardcoded literal
that would trivially always pass." A hardcoded literal would make every
`assertTransition` call a tautology; tracking the real value means a bug
that calls these steps out of order gets caught immediately instead of
silently succeeding.

**The one boundary crossing, and why it needs no compensation**
(`app/app/services/scan/runner.server.ts:102-109`): `readCatalog` is called
exactly once, mid-pipeline, and its own retry/failure handling is entirely
self-contained (see `02-partial-failure-timeouts-and-retries.md`) — by the
time control returns to `runScan`, either it succeeded with data, or it
threw and the outer `catch` handles it. There is no partial state on
Shopify's side to compensate, because nothing was ever written there.

**The atomic local commit — the compensating boundary for everything
local** (`app/app/services/scan/runner.server.ts:182-207`):

```ts
await prisma.$transaction([
  prisma.finding.deleteMany({ where: { scanId } }),
  ...(findingRows.length > 0 ? [prisma.finding.createMany({ data: findingRows })] : []),
  prisma.scan.update({ where: { id: scanId }, data: { status: "COMPLETED", ... } }),
]);
```
This is the workflow's actual "commit point." Everything before it —
reading the catalog, normalizing, running checks — is pure computation with
no lasting local side effects until this line. If a crash happens anywhere
before this transaction executes, nothing has changed locally except the
scan's status advancing through non-terminal states, which the outer
`catch` (below) will still reach and mark `FAILED`. If the crash happens
*during* the transaction, SQLite's own transaction atomicity guarantees
either all three operations land or none do — there's no world where
findings exist without a `COMPLETED` scan to anchor them, or a `COMPLETED`
scan with stale/duplicate findings from a half-applied write.

**The universal compensating action**
(`app/app/services/scan/runner.server.ts:208-224`):

```ts
} catch (err) {
  console.error(`[scan:${scanId}] scan run failed`, err);
  await prisma.scan.update({
    where: { id: scanId },
    data: { status: "FAILED", failedAt: new Date(), failureCode: "SCAN_FAILED", failureMessageSafe: GENERIC_FAILURE_MESSAGE },
  });
}
```
One `catch` wraps the entire pipeline (`runner.server.ts:85` opens the
`try`), so a failure at *any* step — a missing `ShopSettings` row, a
throttled-out Shopify call, a bug in `runChecks` — converges on the same
compensating write. This is the saga's compensating transaction in its
simplest possible form: there's only one compensating action because there
are no partially-completed *external* writes to unwind individually, only
a local status to flip.

```
  Layers-and-hops — the full workflow, boundary marked

  ┌─ local: Scan state machine ────┐  hop: readCatalog()  ┌─ Shopify (read-only) ─┐
  │ QUEUED → READING_CATALOG        │ ───────────────────► │  Admin GraphQL API     │
  └─────────────┬────────────────────┘  hop: catalog data ◄─└────────────────────────┘
                │ (no compensation needed on this hop — nothing written there)
                ▼
  ┌─ local: normalize + runChecks (pure) ─┐
  └─────────────┬───────────────────────────┘
                ▼
  ┌─ local: $transaction(delete findings, insert findings, mark COMPLETED) ─┐
  │  atomic — all local state changes commit together, or none do            │
  └───────────────────────────────────────────────────────────────────────────┘
                │
      ANY step above throws
                ▼
  ┌─ local: mark FAILED (the one compensating action) ─┐
  └───────────────────────────────────────────────────────┘
```

### Move 3 — the principle

A saga's hard problem is compensating for a *write* that already succeeded
on the far side of a boundary you don't control — refunding a charge,
releasing an inventory hold. This workflow sidesteps that hard problem
entirely by construction: the one boundary crossing is read-only, so there
is nothing external to compensate, ever. What's left is the easier half of
saga design — a clean local state machine and an atomic local commit — done
correctly. The lesson worth carrying to a system that *does* write across a
boundary: identify which steps are reversible locally (wrap them in a
transaction) versus which touch an external system (those need an explicit
compensating action, because no database transaction can undo them for
you).

## Primary diagram

```
  The scan workflow as a (simplified) saga

  QUEUED
    │ assertTransition
    ▼
  READING_CATALOG ──► readCatalog() ──► Shopify Admin API (READ-ONLY,
    │                                    no compensation ever needed)
    │ assertTransition
    ▼
  RUNNING_CHECKS ──► normalizeCatalog() + runChecks()  (pure, local)
    │ assertTransition
    ▼
  PREPARING_RESULTS
    │ assertTransition
    ▼
  $transaction[ deleteMany(findings), createMany(fresh), update(COMPLETED) ]
    │                                          ▲
    │  any exception anywhere above             │
    ▼                                          │
  FAILED  ◄─────────── universal compensation ─┘
  (terminal — no further transitions, ever)
```

## Elaborate

The transactional-outbox pattern — writing an event to an "outbox" table in
the same local transaction as your business data, then a separate process
publishes it to an external system, guaranteeing the local write and the
eventual external side effect never diverge — is genuinely **not yet
exercised** here, and for a clean reason: this app never needs to publish
anything to an external system as a side effect of a local write. There's
no "tell Shopify a scan finished" step, no downstream event consumer, no
message that needs guaranteed eventual delivery. If a future version of
this product needed to, say, notify an external analytics system whenever a
scan completes, that's exactly when an outbox table would become
necessary — writing the "scan completed" event into the same
`$transaction` block at `runner.server.ts:187-207` rather than firing it as
a separate, non-transactional call that could succeed or fail independently
of the scan's own commit.

## Interview defense

**Q: "Is this a saga? It doesn't look like the textbook diagram."**
A: It's a saga in the structural sense — a multi-step workflow crossing a
system boundary, with a defined compensating action for failure — but a
deliberately simple one, because the one boundary crossing is a read.
Textbook sagas earn their complexity compensating for committed *writes* on
the far side (a payment that already went through, an inventory hold
already placed); this workflow never writes anything externally, so there's
nothing to compensate for out there — only local state needs unwinding, and
one `FAILED` transition handles all of it.
```
  saga with external writes:  compensate EACH committed external write
  this workflow:              ONE compensating action (mark FAILED) —
                               because the external step never writes
```
One-line anchor: *read-only boundary crossings don't need per-step
compensation, only a clean local rollback.*

**Q: "What guarantees the findings and the COMPLETED status never get out
of sync?"**
A: They're written in the same `$transaction` call — `deleteMany` (clear
stale findings from a prior attempt), `createMany` (the fresh set), and
`update(status=COMPLETED)` all commit as one atomic unit. There's no
intermediate state where findings exist without a `COMPLETED` scan, or a
`COMPLETED` scan with a partial/stale finding set.
One-line anchor: *the "commit point" of the whole workflow is one
transaction, not a sequence of independent writes.*

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the retry
  behavior this same transaction enables (delete-then-recreate).
- `02-partial-failure-timeouts-and-retries.md` — how the one boundary
  crossing (`readCatalog`) survives transient failure on its own.
- `.aipe/study-software-design/` — the state-machine design pattern itself,
  independent of the distributed-coordination lens this file applies to it.
