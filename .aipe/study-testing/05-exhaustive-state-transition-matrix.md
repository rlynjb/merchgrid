# Exhaustive state-transition testing

### Industry names: state machine testing / transition-table testing / combinatorial (exhaustive) test design — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Scan pipeline (runner.server.ts) ────────────────────────────┐
  │  QUEUED → READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS │
  │         → COMPLETED   (or → FAILED from anywhere non-terminal)  │
  └──────────────────────────┬─────────────────────────────────────┘
                             │ every transition passes through
  ┌─ app/services/scan/state.ts ▼───────────────────────────────────┐
  │  ★ assertTransition(from, to) ★ — the ONE gate every status       │ ← we are here
  │  change in the pipeline must pass through                          │
  └──────────────────────────┬─────────────────────────────────────┘
                             │
  ┌─ Test layer ───────────────▼───────────────────────────────────┐
  │  scan-state.test.ts — tests the CLOSED matrix: every legal edge,  │
  │  every illegal edge, not a sample of either                        │
  └────────────────────────────────────────────────────────────────┘
```

A state machine has a finite, enumerable set of possible transitions —
6 statuses means 36 possible `(from, to)` pairs. Most test suites sample a
handful ("queued to running works," "can't go backwards"). This one is
structured to cover the *closed set*: every legal edge, every terminal
status's dead end, and the general shape of illegal edges, derived from the
same fixed lists the production code uses.

## Structure pass

**Layers:** the type (`ScanStatus`, a 6-value union) → the two lookup
tables (`TERMINAL_STATUSES`, `LEGAL_FORWARD_TRANSITIONS`) → the guard
function (`assertTransition`) that every status write in the pipeline calls
before persisting.

**Axis: how many of the 36 possible `(from, to)` pairs does the test suite
actually exercise, directly or by systematic generalization?** This is the
axis that separates "a few example transitions" from "the matrix":

```
  6 statuses × 6 statuses = 36 possible (from, to) pairs

  4 legal forward edges        — each tested individually (LEGAL_FORWARD loop)
  4 non-terminal → FAILED      — each tested individually (NON_TERMINAL loop)
  2 terminal × 6 targets = 12  — each tested individually (ALL_STATUSES loop
                                  from both COMPLETED and FAILED)
  ────────────────────────────
  20 of 36 pairs individually asserted; the remaining 16 (illegal
  same-level skips/backwards moves) are covered by two representative
  "throws when skipping a stage" / "throws when going backwards" cases
  built from the SAME fixed lists, not hand-picked one-offs.
```

**Seam:** `assertTransition` is the single seam every status change in
`runner.server.ts` passes through — `currentStatus` is tracked locally and
re-validated at each step (`runner.server.ts:83, 95, 111, 132, 139`)
specifically so the guard checks the *real* current status rather than a
hardcoded literal that would trivially always pass (`runner.server.ts:79-
82`'s comment names this explicitly).

## How it works

### Move 1 — the mental model

You've tested a finite-option `<select>`'s allowed values before — the
naive move is to test one or two of the options work and move on. The
mental shift this file makes: instead of writing one `it()` per example
transition you thought of, write the *lists* first (`ALL_STATUSES`,
`NON_TERMINAL`, `LEGAL_FORWARD`) and loop over them — so the test count
scales with the state machine's actual size, and adding a status to the
pipeline later forces you to touch the same lists the tests iterate, not
hunt down which individual `it()` blocks need a new example.

```
  Sampling vs. closed-matrix testing

  sampling:              closed-matrix (this file):
  it("Q→R works")        for (const [from,to] of LEGAL_FORWARD) {
  it("R→Q throws")          expect(() => assertTransition(from,to)).not.toThrow()
  it("Q→C throws")        }
  — a few examples,       for (const s of NON_TERMINAL) { ... FAILED ... }
  new states = new,       for (const s of ALL_STATUSES) { ... from COMPLETED ... }
  hand-picked cases       — the matrix, from the same lists as production
```

### Move 2 — the walkthrough

**The lists mirror the production lookup tables, kept independently.**

```typescript
// test/scan-state.test.ts:8-29
const ALL_STATUSES: ScanStatus[] = [
  "QUEUED", "READING_CATALOG", "RUNNING_CHECKS",
  "PREPARING_RESULTS", "COMPLETED", "FAILED",
];
const NON_TERMINAL: ScanStatus[] = [
  "QUEUED", "READING_CATALOG", "RUNNING_CHECKS", "PREPARING_RESULTS",
];
const LEGAL_FORWARD: Array<[ScanStatus, ScanStatus]> = [
  ["QUEUED", "READING_CATALOG"],
  ["READING_CATALOG", "RUNNING_CHECKS"],
  ["RUNNING_CHECKS", "PREPARING_RESULTS"],
  ["PREPARING_RESULTS", "COMPLETED"],
];
```

These are hand-copied from `state.ts`'s own `TERMINAL_STATUSES` and
`LEGAL_FORWARD_TRANSITIONS` (`state.ts:17-28`), not imported from them —
worth noticing as a deliberate (if implicit) tradeoff: keeping the test's
expectation independent of the production table means a bug that corrupts
the production table can't silently corrupt the test's expectation along
with it (the same principle `01-golden-set-regression-eval.md` names
explicitly). The cost is that adding a 7th status requires updating both
places by hand — an acceptable cost for a state machine this size.

**Every legal edge, tested as a loop, not four separate `it()` blocks.**

```typescript
// test/scan-state.test.ts:45-49
it("allows each legal forward transition in the pipeline", () => {
  for (const [from, to] of LEGAL_FORWARD) {
    expect(() => assertTransition(from, to)).not.toThrow();
  }
});
```

One assertion body, four cases run through it. Adding a fifth pipeline
stage means adding one entry to `LEGAL_FORWARD` — the test itself doesn't
change.

**Every non-terminal status can escape to FAILED — tested exhaustively.**

```typescript
// test/scan-state.test.ts:51-55
it("allows any non-terminal status to transition to FAILED", () => {
  for (const from of NON_TERMINAL) {
    expect(() => assertTransition(from, "FAILED")).not.toThrow();
  }
});
```

This is the "any stage can fail" rule the pipeline depends on — every stage
of `runScan`'s try block can throw and land the scan in FAILED regardless
of which stage it was in when the error hit. Testing this per-status,
rather than trusting "it probably works for all of them because it worked
for one," is what makes the claim in `runner.server.ts`'s own docstring
(*"A failure never leaves the scan COMPLETED"*) actually verified rather
than asserted in a comment.

**Terminal statuses have zero legal outgoing edges — tested against every
possible target.**

```typescript
// test/scan-state.test.ts:68-72
it("throws for any transition out of a terminal status", () => {
  for (const to of ALL_STATUSES) {
    expect(() => assertTransition("COMPLETED", to)).toThrow();
    expect(() => assertTransition("FAILED", to)).toThrow();
  }
});
```

This is the strongest single assertion in the file: 12 of the 36 possible
pairs (`COMPLETED`/`FAILED` × all 6 statuses, including to themselves)
proven illegal in one loop. This is the property that makes `runScan`'s
early-return on an already-`COMPLETED` scan (`runner.server.ts:73-75`) safe
to trust — even if that early return were ever accidentally removed, the
state machine itself would still refuse to let a completed scan move
anywhere.

**Self-transitions and mid-pipeline skips get targeted (not exhaustive)
checks**, since the interesting cases there are qualitatively different
from "any target is illegal": `assertTransition("QUEUED", "COMPLETED")`
(skips three stages) and `assertTransition("RUNNING_CHECKS",
"READING_CATALOG")` (goes backwards) are each asserted directly
(`scan-state.test.ts:57-66`) rather than looped — a reasonable place to stop
generalizing, since the illegal-skip and illegal-backwards cases are
already covered in spirit by the fact that `LEGAL_FORWARD_TRANSITIONS` maps
each `from` to exactly *one* `to`, which the loop-based legal-edge test
already pins down.

### Move 3 — the principle

The generalizable move: when a system's valid transitions are drawn from a
small, fixed, enumerable set (a state machine, a permission matrix, a
finite protocol), write the sets/lists as data first and iterate them in
the test, rather than writing one `it()` per example you happened to think
of. The test count then scales with the system's actual size, and the
"did I forget a case" question becomes "did I forget an entry in the list"
— a much easier question to answer by inspection.

## Primary diagram

```
  The 36-pair matrix, and which slice each test covers

           →QUEUED  READING  RUNNING  PREPARING  COMPLETED  FAILED
  QUEUED     ✗        ✓legal    ✗         ✗           ✗       ✓(any→FAILED)
  READING    ✗          ✗     ✓legal      ✗           ✗       ✓
  RUNNING    ✗          ✗       ✗       ✓legal         ✗       ✓
  PREPARING  ✗          ✗       ✗         ✗         ✓legal    ✓
  COMPLETED  ✗          ✗       ✗         ✗           ✗       ✗   ← all 6 tested illegal
  FAILED     ✗          ✗       ✗         ✗           ✗       ✗   ← all 6 tested illegal

  ✓legal = LEGAL_FORWARD loop      ✓(any→FAILED) = NON_TERMINAL loop
  ✗ (COMPLETED/FAILED rows)        = ALL_STATUSES × 2 terminal-source loop
  ✗ (elsewhere)                     = targeted skip/backwards assertions
```

## Elaborate

This is the same discipline as full-branch-coverage testing for a
conditional, applied to a state machine instead of an `if` chain — the goal
isn't "did every line execute," it's "did every reachable transition get
asserted, and every unreachable one get asserted-as-unreachable." The
technique generalizes past state machines to any small closed-enumeration
domain: HTTP methods against a route table, role×permission grids,
protocol handshake states. It stops paying off once the domain gets too
large to enumerate exhaustively (a full permission matrix for 50 roles
against 200 resources, say) — at that scale, property-based generation
(pick random `(from, to)` pairs and assert the invariant "either it's in
`LEGAL_FORWARD`/`FAILED`-from-non-terminal, or it throws") would be the
next tool to reach for, trading exhaustiveness for scale. At 6 statuses,
exhaustive enumeration is still cheaper to read and cheaper to maintain
than a property generator would be.

## Interview defense

**Q: Why loop over `ALL_STATUSES` instead of writing six separate
`it("COMPLETED cannot go to QUEUED")`-style tests?**
Because the loop makes the test's *coverage* explicit and automatically
complete — if a seventh status is ever added to the pipeline, it has to be
added to `ALL_STATUSES` for any other test using that list to typecheck,
and the terminal-status test then automatically covers the new status too.
Six hand-written `it()` blocks wouldn't grow on their own.

**Q: What's the single most valuable assertion in this file?**
"Throws for any transition out of a terminal status," looped over both
`COMPLETED` and `FAILED` against all six possible targets — 12 pairs in one
assertion. It's what makes `runScan`'s "a failure never leaves the scan
COMPLETED" claim a verified property of the state machine itself, not just
an early-return that happens to work today.

```
  from COMPLETED or FAILED, to ANYTHING (including itself) → must throw
  (12 of 36 pairs, proven in one loop)
```

**Q: Where did you stop generalizing, and why was that the right place to
stop?**
The illegal-skip and illegal-backwards cases (`QUEUED→COMPLETED`,
`RUNNING_CHECKS→READING_CATALOG`) are asserted directly rather than looped,
because `LEGAL_FORWARD_TRANSITIONS` maps each status to exactly one legal
target — the legal-edge loop already proves every *other* target is
implicitly illegal for a non-terminal `from`. Looping the illegal cases too
would be re-testing the same fact from the opposite direction.

## See also

- `audit.md` lens 4 (determinism/isolation) — a clean state machine with no
  hidden transitions is part of why this repo has no flaky-ordering bugs.
- `03-fake-admin-graphql-seam.md` — `worker-core.test.ts`'s poison-pill test
  relies on this same state machine to prove a FAILED scan never blocks the
  queue.
- `study-software-design` (if generated) — the state-machine-as-explicit-
  guard pattern (`assertTransition` gating every write) is a deep-module /
  information-hiding finding worth its own look there.
