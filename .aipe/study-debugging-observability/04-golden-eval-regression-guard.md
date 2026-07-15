# Golden dataset regression guard (the golden eval)

**Golden-dataset regression test / characterization test, built to
avoid the golden-master anti-pattern** — Language-agnostic pattern,
project-specific implementation (`app/test/eval-fixtures.test.ts`,
`npm run eval`).

## Zoom out, then zoom in

Here's the whole thing: 17 hand-built products, pushed through the
exact two function calls the production worker makes, checked against
an expected findings table someone wrote by *reading the check specs*
— not by running the code once and snapshotting whatever came out.
This is the closest thing this repo has to a reproduction lab: every
edge case a check is supposed to catch (or deliberately NOT catch) gets
its own fixture row, forever re-verified on every run.

```
  Zoom out — where the eval sits relative to production

  ┌─ Dev workflow layer ──────────────────────────────────────────┐
  │  npm run eval  (test/eval-fixtures.test.ts, no network, no DB)  │
  └───────────────────────────┬───────────────────────────────────┘
                              │  calls the SAME two functions
  ┌─ Engine layer ★ THIS CONCEPT ★ ─▼───────────────────────────────┐
  │  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)                │
  └───────────────────────────┬───────────────────────────────────┘
                              │  identical call shape
  ┌─ Production (worker) ─────▼───────────────────────────────────┐
  │  runner.server.ts runScan(): same normalizeCatalog → runChecks   │
  └─────────────────────────────────────────────────────────────────┘
```

This is like a snapshot test, except it explicitly refuses to be one:
the file's own docstring bans "fixing" a red run by copying the
engine's actual output back into the expected table
(`app/test/eval-fixtures.test.ts:13-16`). That single rule is what
separates a regression guard from a test that only proves the code
didn't change — not that it's right.

## The structure pass

**Axis: guarantees — what's promised, and by what?** The eval's entire
value depends on one seam being exactly right:

```
  Seam: does the eval call the SAME functions production calls?

  eval-fixtures.test.ts:316-327          runner.server.ts:118-130
  ─────────────────────────────          ─────────────────────────
  normalizeCatalog(rawCatalog, {...})    normalizeCatalog(raw, {...})
  runChecks(ALL_CHECKS, ctx)             runChecks(ALL_CHECKS, ctx)

  same two calls, same arguments shape → the eval proves something
  about PRODUCTION behavior, not about a parallel implementation
```

If the eval imported a different code path, or mocked the engine, it
would prove nothing about what actually ships. That's the seam worth
studying before anything else about this pattern: the eval's
credibility lives entirely in that identity.

## How it works

**Move 1 — the mental model.** This is a characterization test with
one crucial twist: normal characterization testing captures whatever
the code currently does and locks it in, which is exactly the
anti-pattern this file's docstring explicitly refuses to be. Instead,
every expectation is derived by *reading* each `mg-00N.ts` check's
documented behavior and reasoning about what it should flag — the
independence from the implementation is the entire point.

```
  Pattern — independently-derived expectations vs. a captured snapshot

  ┌─ golden-master anti-pattern ─────┐   ┌─ this eval's approach ──────┐
  │ run code once → snapshot output   │   │ read the SPEC → derive       │
  │ any future output = "correct"     │   │ expected findings BEFORE      │
  │ (locks in bugs as behavior)       │   │ ever running the code         │
  └────────────────────────────────────┘   └──────────────────────────────┘
```

**Move 2 — the walkthrough.**

**Part 1 — the fixtures are engineered, not random.** 17 rows across
15 products / 17 variants (`app/test/eval-fixtures.test.ts:85-267`),
each one built to hit exactly one documented check behavior:
below-cost pricing, thin margin, a shared SKU with whitespace/case
variance, a duplicate barcode across two products, a variant-price
outlier within one product, a missing unit cost, a draft product at
zero price, an archived product still flagged below-cost (proving
MG-002 has no status gate), and a Unicode-stress-test title. Skeleton:
every fixture targets one named check's stated behavior, not "some
plausible catalog data."

**Part 2 — the assertion shape names exactly what went wrong, not just
that something did.** `actualFor(gid)`
(`app/test/eval-fixtures.test.ts:337-341`) groups findings by
`variantId` into `checkId:severity` tags; each per-fixture test
computes `missing` and `unexpected` sets explicitly instead of a blind
`toEqual` (`app/test/eval-fixtures.test.ts:354-367):

```
  Pseudocode — per-fixture assertion

  for each fixture:
    actual   = findings tagged to this variant (checkId:severity pairs)
    expected = fixture.expected                 // hand-derived from spec
    missing    = expected items NOT in actual    // engine stopped catching this
    unexpected = actual items NOT in expected     // engine started over-firing
    assert missing == [] AND unexpected == []
    // failure message names exactly which check regressed, and how
```

What breaks if this were a plain equality check instead: a failure
would tell you "the arrays don't match," not "MG-005 stopped firing" —
the explicit `missing`/`unexpected` split is what makes a red run
diagnosable in one glance instead of requiring a manual diff.

**Part 3 — the orphan-findings check catches what no single fixture
assertion would even look at.** A global assertion
(`app/test/eval-fixtures.test.ts:369-375`) verifies that NO variant
outside the 17 tracked fixtures produced ANY finding at all. What
breaks if removed: a check could start flagging a previously-clean
variant (say, the `Variant-Outlier / Small` row, which is asserted to
have *zero* findings), and every per-fixture test would still pass
green, because none of them are even looking at that variant's finding
set. This is the load-bearing part people miss — the per-fixture
assertions only prove "the checks I already expected still fire
correctly"; the orphan check is the only thing that would catch an
entirely new, unaccounted-for firing.

**Part 4 — three layers, same question, three different costs.** This
eval sits between two other verification layers doing the same job at
different altitudes: 132 app tests + 83 engine tests
(unit-level, fastest, narrowest scope, per `.aipe/project/context.md`),
this one seam-level eval (integration-shaped but still zero I/O,
`npm run eval`), and `scripts/seed-fixtures.ts` against a real dev
store (true end-to-end, manual, out of scope by the eval file's own
docstring, `app/test/eval-fixtures.test.ts:17-23`). Same question — "is
the engine's behavior correct?" — asked three times, at three
altitudes, at three different costs. Naming that once, instead of
treating them as unrelated test files, is the actual system-level
insight.

**Move 3 — the principle.** A regression guard is only as strong as
its independence from the implementation. Derive expectations from the
spec, never from a prior run of the code — or the "test" only proves
the code hasn't changed, not that it's right, and it will happily lock
in a bug forever.

## Primary diagram

```
  Full picture — the eval, its seam, and its two verification neighbors

  17 hand-built fixtures ──► normalizeCatalog ──► runChecks(ALL_CHECKS, ctx)
  (spec-derived expected)         │  same seam as production      │
                                  ▼                                ▼
                          runner.server.ts:118-130          findings, grouped
                          (production worker path)          by variantId

  actualFor(gid) → {missing, unexpected} per fixture, + one global
  orphan-findings check across ALL variants outside the 17 tracked

  neighbors, same question at different cost:
  132 app tests + 83 engine tests (unit, fastest) ←→ THIS EVAL (seam,
  zero I/O) ←→ scripts/seed-fixtures.ts + real dev store (e2e, manual)
```

## Elaborate

This belongs to the golden-dataset / characterization-testing family,
built deliberately to dodge that family's classic failure mode: locking
in whatever the code currently does instead of what it should do. The
file names a real, accepted duplication cost without apologizing for
it: fixtures here are intentionally NOT shared with
`scripts/seed-fixtures.ts`, even though many rows are conceptually
similar, so this eval never depends on — or gets silently broken by —
changes made for the live-QA seeder (`app/test/eval-fixtures.test.ts:25-31`).
The file itself names the future improvement (a shared fixture source)
and explains why it isn't worth doing yet.

## Interview defense

**Q: How do you know this eval isn't just testing itself — i.e., that
it wouldn't pass even if the engine were wrong?**
A: Because the expected table wasn't generated by running the engine —
it was written by reading each check's stated behavior first, and the
file's own docstring explicitly forbids "fixing" a red run by copying
actual output into the expected table. The independence is a process
rule enforced by comment, not a mechanical guarantee, but it's the
right rule: any test whose expectations come from the code under test
can't detect a bug in that code.

**Q: What's the one class of bug this eval structurally cannot catch?**
A: Anything that only shows up against Shopify's *real* GraphQL
responses and has no equivalent among these 17 hand-built fixtures —
a genuine API integration bug, a field Shopify returns differently than
assumed, or scale-related behavior. That's exactly the gap
`scripts/seed-fixtures.ts` plus a real dev store exists to cover, and
the eval file says so itself.

```
  what the eval CAN vs CANNOT catch

  CAN catch:                        CANNOT catch:
  ──────────────────────────        ──────────────────────────────
  a check silently stops firing     a real Shopify API response shape
  a check starts over-firing        this 17-fixture set never modeled
  a new variant unexpectedly flagged   → covered by scripts/seed-fixtures.ts
```

## See also

- `audit.md` §2 (reproduction-and-evidence)
- `05-deterministic-repro-injectable-clock-and-sleep.md` — the
  companion mechanism that makes retry/backoff and timestamp-dependent
  behavior reproducible the same way this eval makes check behavior
  reproducible
- `study-testing` — coverage and design-quality read of the full test
  suite; this file only covers the eval as a debugging/reproduction
  tool
