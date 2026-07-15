# Eval-driven prompt iteration

Subtitle: **golden-set evaluation / regression-driven iteration** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where eval-driven iteration lives

┌─ test/eval-fixtures.test.ts ── TODAY ───────────────────────┐
│  ★ THIS CONCEPT, deterministic form ★                         │
│  17 independently-specified fixtures → normalizeCatalog →     │
│  runChecks → assert exact (checkId, severity) match           │
└──────────────────────────┬───────────────────────────────┘
                            │  same discipline, LLM added
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  the same golden-set discipline, but judging changeset          │
│  proposals instead of check classifications — LLM-as-judge      │
│  becomes relevant for open-ended parts of the output              │
└─────────────────────────────────────────────────────────────┘
```

Here's the dividing line I use to tell a junior prompt engineer from a senior one in about thirty seconds: ask how they know a prompt change is an improvement. The junior answer is "the response feels better now." The senior answer is "I ran it against my eval set, the score went up, and nothing in the regression suite broke." Hamel Husain's writing on evals is the canonical reference here, and the reason it matters isn't academic — I've watched a "better" prompt improve the average score on a rubric while quietly regressing a critical edge case nobody happened to be tracking, and it shipped, because there was no regression suite catching it. The discipline is: write the eval before you iterate the prompt, not after, because an eval written to match whatever the current prompt already produces isn't testing anything.

This is the one concept in this guide where MerchGrid: Catalog Audit isn't behind — it's already doing the discipline, just without an LLM to iterate against. `npm run eval` runs a real golden-set-and-regression-suite eval over the deterministic check engine, and the shape of it is worth studying directly, because the shape transfers even though the thing being evaluated (check logic, not model output) doesn't.

## Structure pass

**Axis: is the expected answer independently specified, or derived from the system under test?** This is the single question that determines whether an eval is real or a rubber stamp. Trace it across an LLM eval and this codebase's eval.

```
axis: where did the "expected" answer come from?

LLM eval (proper):        human or LLM-judge writes expected output
                           BEFORE running the prompt against it —
                           never snapshot-and-call-it-golden

Catalog Audit eval-fixtures.test.ts (today):
                           "the expectations below were written by
                           reading each mg-00N.ts check's stated
                           behavior and reasoning about what it
                           SHOULD flag... NOT by running the engine
                           once and snapshotting whatever came out"
                           (test/eval-fixtures.test.ts:10-16)
```

**Seam:** the seam that matters is between "test written from the spec" and "test written from the implementation's current output" — cross it and the eval stops being able to catch a regression, because it's now defined by the thing it's supposed to be checking. `eval-fixtures.test.ts`'s docstring names this seam explicitly and states which side of it the file is on.

## How it works

### Move 1 — the mental model

You already know this from any regression test suite: a bug gets fixed, and instead of trusting it stays fixed, you add the failing case as a permanent test. Eval-driven iteration for prompts is the same instinct scaled to non-deterministic output — a golden set of hand-curated input/expected-output pairs (typically 20–50 cases), checked before every prompt change, plus a growing regression suite of real production failures added back as test cases forever.

```
Eval-driven iteration — the loop

  change prompt (or check logic)
        │
        ▼
  run against golden set + regression suite
        │
        ▼
  diff outputs vs expected ──► score improved, no regressions? ──► keep
        │                                          │
        │                                          └─ regressed a case? ──► revert or fix
        ▼
  (repeat)
```

### Move 2 — the same discipline, in this codebase's deterministic form

**The golden set.** `test/eval-fixtures.test.ts` builds 17 fixture variants across 15 products, each constructed to sit at a specific, deliberate point relative to a check's logic — not sampled from real data, but hand-designed to exercise a boundary. The outlier check is the clearest example:

```ts
// test/eval-fixtures.test.ts:272-293 (excerpted)
const FIXTURES: Array<{ label: string; gid: string; expected: string[] }> = [
  { label: "Below-Cost Tee (BC-001)", gid: belowCostTeeVariant.id, expected: ["mg-002:CRITICAL"] },
  { label: "Thin-Margin Mug (TM-001)", gid: thinMarginMugVariant.id, expected: ["mg-003:WARNING"] },
  // ...
  { label: "Variant-Outlier / Small (VO-S)", gid: voSmallVariant.id, expected: [] },
  { label: "Variant-Outlier / Medium (VO-M)", gid: voMediumVariant.id, expected: [] },
  { label: "Variant-Outlier / Large (VO-L)", gid: voLargeVariant.id, expected: ["mg-008:WARNING"] },
];
```

VO-S, VO-M, and VO-L are three fixtures placed deliberately around `mg-008`'s outlier threshold (0.25x–4x the product's median price, per `app/packages/catalog-checks/src/checks/mg-008.ts:21-22`) — two expected to NOT fire, one expected to fire. That's a golden set doing exactly what a good LLM eval set does: don't just test the obvious case, test the boundary where the logic could plausibly be wrong.

**Independently specified, not snapshotted.** The docstring states the rule the persona's opening story depends on — the expected values were derived by reading each check's spec, not by running the engine once and copying its output:

```ts
// test/eval-fixtures.test.ts:8-16
 * "Independently specified" matters: the expectations below were written
 * by reading each `mg-00N.ts` check's stated behavior and reasoning about
 * what it *should* flag for each fixture — NOT by running the engine once
 * and snapshotting whatever came out. If a future change to a check
 * silently alters behavior, this test is meant to catch it, not rubber
 * -stamp it. Do not "fix" a red run here by copying the engine's actual
 * output into the expected table; that defeats the purpose of the eval.
```

**The assertion — precisely what it checks, and what it doesn't.** The test compares `(checkId, severity)` pairs per fixture, not the `title`/`explanation` copy:

```ts
// test/eval-fixtures.test.ts:333, 355-365 (excerpted)
set.add(`${f.checkId}:${f.severity}`);
// ...
it(`${fixture.label} matches expected findings`, () => {
  const expected = [...fixture.expected].sort();
  // compares actual vs expected checkId:severity pairs
  expect({ actual, missing, unexpected }, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    .toEqual({ actual: expected, missing: [], unexpected: [] });
});
```

Say this plainly, the way a senior engineer would in a design review: this eval catches *classification* regressions — a check firing when it shouldn't, or failing to fire when it should — but it would not catch someone quietly rewording `mg-003`'s explanation string to something misleading, because wording isn't part of what's asserted. That's the correct scope for this codebase, since nothing downstream parses `explanation` programmatically — but it's exactly the gap an LLM-output eval can't afford to leave open, because with a model in the loop, the wording *is* the output being judged, not an unchecked side channel.

### Move 3 — the principle

An eval is only as good as its independence from the thing it tests. The moment "expected" is derived from "what the system currently does," you've built a test that can never fail, which means it can never catch the regression it exists to catch. That's true whether the system under test is ten TypeScript functions or a prompt against a frontier model — the discipline doesn't change, only what counts as "the output" does.

## Primary diagram

```
Eval-driven iteration — both systems, one discipline

  LLM eval (Bulk AI, planned)              eval-fixtures.test.ts (today)
  ┌────────────────────────┐               ┌────────────────────────┐
  │ golden set: 20-50 cases  │◄────────────►│ 17 fixtures, boundary-   │
  │ human/spec-written        │  same rule  │ designed (VO-S/M/L)      │
  ├────────────────────────┤  "expected    ├────────────────────────┤
  │ regression suite: past    │  ≠ current   │ independently-specified │
  │ failures, kept forever    │  output"     │ from each check's spec   │
  ├────────────────────────┤               ├────────────────────────┤
  │ LLM-as-judge for open-     │  ✗ n/a —     │ exact (checkId,severity) │
  │ ended output quality       │  no open-    │ match; explanation copy   │
  │                            │  ended text  │ NOT asserted              │
  └────────────────────────┘               └────────────────────────┘
```

## Elaborate

Hamel Husain's writing (his blog and the "Your AI Product Needs Evals" line of posts) is the field's clearest statement of why eval-driven iteration is non-negotiable for LLM products specifically — because unlike deterministic code, you can't reason your way to correctness by reading the prompt, you have to measure it. LLM-as-judge (using a second model call to score the first model's output against a rubric) becomes relevant exactly where this codebase's eval structurally can't reach: judging open-ended, natural-language output quality, which `eval-fixtures.test.ts` never has to do because `checkId`/`severity` are closed, checkable values, not prose.

## Project exercises

### Exercise: extend the golden-set discipline to Bulk AI's changeset proposals

- **What to build:** a golden set of catalog scenarios with independently-specified *expected changeset shapes* (which finding should produce which kind of proposed fix), following `eval-fixtures.test.ts`'s exact discipline — write expectations from the product spec, never from a first run of the model.
- **Why it earns its place:** this codebase already proves the team knows how to do this correctly; the risk in Bulk AI isn't ignorance of the discipline, it's forgetting that open-ended proposal text (unlike `checkId`/`severity`) needs an LLM-as-judge pass, because `toEqual` won't work on prose.
- **Files to touch:** new, likely `app/test/eval-fixtures-bulk-ai.test.ts`, using the same fixture-construction helpers (`variant()`, `product()`) already defined in `eval-fixtures.test.ts:45-83`.
- **Done when:** a deliberately "worse" changeset prompt regresses at least one golden case and the suite catches it before merge.
- **Estimated effort:** a day to port the fixture-construction pattern; longer to design the LLM-as-judge rubric for proposal quality.

## Interview defense

**Q: What makes an eval trustworthy instead of a rubber stamp?**
A: The expected outputs have to come from somewhere independent of the system under test — the spec, a domain expert, a rubric — never from running the system once and keeping whatever it produced. `eval-fixtures.test.ts`'s own docstring states this as an explicit rule and explains why: "if a future change to a check silently alters behavior, this test is meant to catch it, not rubber-stamp it."

```
the answer, sketched
┌─ expected from the SPEC ──┐        ┌─ expected from a SNAPSHOT ──┐
│ can catch a regression      │        │ can never fail — it's just   │
│                              │        │ testing "does it still do    │
│                              │        │ what it did last time"        │
└──────────────────────────┘        └──────────────────────────┘
        only the left side is a real eval
```

**Q: This codebase's eval never touches an LLM. What's the honest limit of the analogy?**
A: It asserts exact `(checkId, severity)` matches, which works because those are closed, deterministic values. It deliberately does not assert on `explanation` copy wording, because nothing consumes that programmatically here — but that's precisely the part an LLM eval can't skip, since with a model in the loop the wording often *is* the output quality being measured, and `toEqual` can't judge prose. Naming that limit precisely is the stronger answer than claiming the analogy is total.

## See also

- `03-prompts-as-code.md` — versioning is what makes "which change caused this eval regression" answerable
- `10-self-critique.md` — the LLM-as-judge pattern this codebase's eval doesn't need yet
