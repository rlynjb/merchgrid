# Golden-set regression testing

### Industry names: golden-set test / oracle-based regression test / characterization-vs-specification test — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Engine layer (pure, no I/O) ───────────────────────────────┐
  │  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)           │
  │       @merchgrid/catalog-core   @merchgrid/catalog-checks    │
  └───────────────────────────┬───────────────────────────────────┘
                              │ same two calls the worker makes
  ┌─ Test layer ───────────────▼─────────────────────────────────┐
  │  ★ test/eval-fixtures.test.ts ★                               │ ← we are here
  │  17 hand-built fixtures, independently-specified expected     │
  │  findings, run through the real seam above                    │
  └───────────────────────────────────────────────────────────────┘
```

Every other test in this repo checks one check (`mg-002.test.ts` checks
`mg002` in isolation) or one mechanism (retry, pagination). This file does
something different: it builds a whole miniature catalog — 15 products, 17
variants, one of every interesting shape (below-cost, thin-margin, shared
SKU, duplicate barcode, missing cost, draft/archived status, a unicode
stress title) — and asserts that running it through the *entire* engine
produces *exactly* the findings a human, reading the check specs
independently, decided it should. That's a golden-set eval: a fixed input,
a fixed expected output, and the discipline of writing the expected side
without ever looking at what the code actually does first.

## Structure pass

**Layers:** fixture construction → the real production seam
(`normalizeCatalog` → `runChecks`) → assertion against an independently-
authored expectation table. Three layers, and the middle one is not a test
double — it's the actual code path `runner.server.ts` calls in production.

**Axis: who decided the correct answer, and when?** This is the axis that
makes a golden-set eval different from an ordinary regression test:

```
  Two ways to get "expected" — only one of them tests anything

  ordinary snapshot test          golden-set eval (this file)
  ───────────────────────         ───────────────────────────
  RUN the code once          →    READ the check specs
  COPY its output as          →   REASON about what should fire
    "expected"                    WRITE that down first
  future runs compare to      →   future runs compare to YOUR
    what the code already          independent judgment, not
    produced                       the code's own past output
```

**Seam:** the comment block at the top of the file
(`test/eval-fixtures.test.ts:9-17`) states the seam explicitly: *"the
expectations below were written by reading each `mg-00N.ts` check's stated
behavior and reasoning about what it *should* flag... NOT by running the
engine once and snapshotting whatever came out."* The load-bearing property
is that this seam can never be closed by editing the test to match a bug —
doing so is explicitly called out as defeating the purpose
(`eval-fixtures.test.ts:16`).

## How it works

### Move 1 — the mental model

You already know the difference between a snapshot test and a spec-driven
test from any UI work: a snapshot test says "whatever the component renders
today is correct forever" — it catches *changes*, not *bugs*, because
nothing ever independently decided what "correct" means. A golden-set eval
is the opposite: someone read the spec, decided what should happen for 17
different input shapes, wrote that table down, and only *then* ran the
code. The underlying strategy: **decouple "what the code does" from "what
the code should do,"** so a regression shows up as a real mismatch instead
of an intentional-looking diff.

```
  The golden-set shape

  fixture table                 real seam                 expected table
  ┌──────────────┐        ┌─────────────────────┐      ┌───────────────┐
  │ 15 products,  │──────▶│ normalizeCatalog()   │      │ variant → set │
  │ 17 variants,  │        │        │             │      │ of "checkId:  │
  │ one per       │        │        ▼             │      │ severity"     │
  │ interesting   │        │ runChecks(ALL_CHECKS)│─────▶│ pairs, written│
  │ shape         │        └─────────────────────┘      │ independently │
  └──────────────┘                                       └───────┬───────┘
                                                                   │ diff
                                                          ┌────────▼────────┐
                                                          │ missing / extra │
                                                          │ findings surface│
                                                          │ as a named fail │
                                                          └─────────────────┘
```

### Move 2 — the walkthrough

**Fixture construction, one row per interesting shape.** Each fixture is
built with small `variant()`/`product()` helper functions
(`test/eval-fixtures.test.ts:45-83`) rather than raw object literals, so
every row reads as "price X, cost Y, sku Z" instead of a wall of GraphQL-
shaped JSON. Sixteen distinct shapes are covered in one catalog: a
below-cost single-variant product, a thin-margin product, a free sample, a
compare-at-price violation, a shared-SKU pair *across two different
products*, a duplicate-barcode pair, a tracked-no-SKU variant, a
three-variant outlier product (Small/Medium/Large, one wildly mispriced), a
missing-unit-cost variant, a draft zero-price product, an archived
below-cost product (proving MG-002 has no status gate), and a unicode
stress-test title (`test/eval-fixtures.test.ts:85-243`).

**The expected table is the oracle, and it's adversarial toward the code.**
`FIXTURES` (`test/eval-fixtures.test.ts:272-310`) maps each variant's GID to
the exact set of `checkId:severity` pairs it should produce — including the
*negative* cases: the Small and Medium variant-outlier rows expect `[]`
(nothing should fire), and the shared-SKU rows expect `["mg-005:WARNING",
"mg-009:WARNING"]` — both a duplicate-SKU finding *and* a conflicting-price
finding, because the two SKU-matched variants also happen to have different
prices. Getting a two-check interaction like that right by reasoning about
the spec — instead of running the code and copying what came out — is
exactly what makes this an eval and not a snapshot.

**The assertion reports missing vs. unexpected separately.**

```typescript
// test/eval-fixtures.test.ts:359-365
const missing = expected.filter((e) => !actual.includes(e));
const unexpected = actual.filter((a) => !expected.includes(a));

expect(
  { actual, missing, unexpected },
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
).toEqual({ actual: expected, missing: [], unexpected: [] });
```

A plain `toEqual(expected)` would tell you the sets differ; this shape
tells you *which check silently stopped firing* (`missing`) vs. *which
check started firing when it shouldn't* (`unexpected`) — the difference
between "MG-003 broke" and "MG-003 is now over-triggering" in the failure
message itself, without opening a debugger.

**The orphan-finding check closes the loop.** The last test
(`eval-fixtures.test.ts:369-375`) asserts that no variant *outside* the
fixture table produced any finding at all — proving the fixture table is
exhaustive over the catalog, not just correct for the rows someone
remembered to check.

### Move 3 — the principle

The generalizable move: whenever you have a rules engine, a scoring
function, or anything else where "correct" is defined by a spec rather than
by running the code, write the expected output from the spec *first*, keep
it in a separate, readable table, and assert on the diff shape (missing vs.
unexpected) rather than a blind equality. The moment you regenerate
"expected" from the code's own output, the test stops testing anything —
it just certifies today's behavior as tomorrow's requirement, bugs
included.

## Primary diagram

```
  Golden-set eval — full picture

  ┌─ spec (mg-00N.ts check bodies) ───────────────────────────────┐
  │  read independently, reasoned about, never executed first      │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ produces
                    ┌─────────▼─────────┐
                    │  FIXTURES table    │  17 rows: gid → expected
                    │  (hand-written)    │  checkId:severity pairs
                    └─────────┬─────────┘
                              │ compared against
  ┌─ real seam ────────────────▼──────────────────────────────────┐
  │  normalizeCatalog(rawCatalog) → runChecks(ALL_CHECKS, ctx)      │
  │  identical calls to runner.server.ts's production pipeline      │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ grouped by variantId
                    ┌─────────▼─────────┐
                    │ findingsByVariantId│
                    └─────────┬─────────┘
                              │ per fixture: { missing, unexpected }
                    ┌─────────▼─────────┐
                    │  17 assertions +   │  a named check-level
                    │  1 orphan check    │  regression on failure,
                    └────────────────────┘  not a generic diff
```

## Elaborate

Golden-set evals come from the same lineage as "characterization tests" in
legacy-code literature, but with the opposite intent: a characterization
test *locks in* current behavior when you don't yet know what's correct
(useful before a refactor of code with no spec); a golden-set eval *locks in
a spec* independently of current behavior (useful when you do know what's
correct, and want a fast way to catch drift). The naming borrowed here — a
"golden set," "expected findings," a table of fixtures — is the same
vocabulary an ML team would use for an evaluation harness. That's not an
accident: this technique is the deterministic-world sibling of an LLM eval
set. The difference is what "correct" cashes out to. Here, `expect(actual)
.toEqual(expected)` — bit-for-bit equality is achievable because the
system is a pure function. In an LLM eval, "correct" is a judgment call
(a rubric, a judge model, a human rater) because the same input can produce
different valid outputs. See `README.md`'s seam discussion for why this
repo, having no model anywhere, never needs the probabilistic half of that
machinery — but if the planned "MerchGrid: Bulk AI" product adds an LLM
changeset-preflight feature reusing this engine, this exact fixture-table
discipline is the right skeleton to reuse; only the assertion (equality →
rubric) would need to change.

The file's own comments name a real, accepted duplication cost: the
fixtures here are deliberately *not* shared with `scripts/seed-fixtures.ts`
(the separate live-QA seeder), even though many rows are conceptually
similar, specifically so this eval's correctness never depends on changes
made for the seeder (`eval-fixtures.test.ts:25-31`). That's a tradeoff
stated without flinching: some duplicated fixture-authoring effort, bought
in exchange for this eval never breaking for a reason unrelated to the
engine itself.

## Interview defense

**Q: What's the difference between this and a snapshot test?**
A snapshot test runs the code once and freezes whatever it produced as
"correct" — it can freeze a bug in forever. This table was written by
reading the check specs first, before ever running the engine, so a
regression shows up as a real mismatch against independent judgment, not
against the code's own past self.

```
  snapshot test:  code → output → "expected" (frozen)
  golden-set eval: spec → "expected" (written first) → code → compared
```

**Q: Why report `missing` and `unexpected` separately instead of one
`toEqual`?**
Because the failure message is the whole point of writing the test well —
"missing: mg-003:WARNING" tells you a check stopped firing; "unexpected:
mg-009:WARNING" tells you a check started over-firing. A blind `toEqual`
would just say "not equal," and you'd re-derive that distinction by hand
during triage every single time.

**Q: What would you have to change if this repo added an LLM feature?**
Nothing about the fixture-table skeleton — you'd still build known inputs
and independently decide expected behavior. What changes is the assertion:
equality (`toEqual`) only works because the engine is a pure deterministic
function; a model's output isn't guaranteed identical run to run, so you'd
swap the assertion for a rubric or an LLM-as-judge check. That's the exact
determinism seam this guide's `README.md` names up front.

## See also

- `00-overview.md` — where this sits on the coverage map (lens 1: engine
  is the deepest-tested layer).
- `audit.md` lens 1 (what's tested) and lens 6 (testing AI features, `not
  yet exercised` — this file is the closest thing to eval machinery in the
  repo, and it's still on the deterministic side of the seam).
- `06-decimal-money-precision-tests.md` — the fixture table here relies on
  the same decimal-safe money handling that file audits directly.
