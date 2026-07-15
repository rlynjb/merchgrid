# Eval Methods

Exact match / fuzzy match / rubric grading / LLM-as-judge / pairwise comparison / human eval — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Worker layer ──────────────────────────────────────────────┐
│  app/services/scan/runner.server.ts — runs the real scan     │
└───────────────────────────┬───────────────────────────────────┘
                            │ same seam
┌─ Engine seam ────────────▼────────────────────────────────────┐
│  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)              │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌─ Eval layer ────────────────▼─────────────────────────────────┐
│  app/test/eval-fixtures.test.ts                                │
│  method used: EXACT MATCH ★ THIS CONCEPT ★                     │
│  actual checkId:severity set  ==  expected checkId:severity set │
└─────────────────────────────────────────────────────────────┘
```

Think of eval methods as a ladder, cheapest and strictest at the bottom, most expensive and most subjective at the top. Every rung answers the same question — "is this output correct?" — but they answer it with a different amount of judgment involved. Exact match needs zero judgment: strings either match or they don't. Human eval needs a person's full attention. Everything in between trades cost for nuance. This repo's one real eval sits on the bottom rung, and it's worth being precise about exactly which rung and why the others aren't exercised here.

## Structure pass

**Layers:** the eval-methods ladder isn't a layer of *this app's* architecture — it's a layer of *judgment cost*, and it sits entirely inside the eval layer from `01-eval-set-types.md`'s diagram. All six rungs could, in principle, sit at that same spot; this repo only ever climbs onto the first one.

**Axis to trace: how much judgment does grading a single output require?**

```
One axis — "how much judgment does grading take?" — up the ladder

┌─ exact match ──┐   string equality, zero judgment, a computer can do it
┌─ fuzzy match ──┐   similarity threshold, still a computer, tunable strictness
┌─ rubric ───────┐   checklist of criteria, still mostly mechanical, some interpretation
┌─ LLM-as-judge ─┐   a model applies judgment, needs its own bias-checking
┌─ pairwise ─────┐   relative judgment ("which is better"), no absolute score needed
┌─ human eval ───┐   full human judgment, most expensive, ground truth for the others
```

**Seam:** the load-bearing boundary is between "grading a mechanical property" (exact/fuzzy match, rubric checklist — all still deterministic once you fix the rule) and "grading a subjective property" (LLM-as-judge, pairwise, human eval — where the grader itself might disagree with another grader on the same output). Below that seam, control belongs to code. Above it, control belongs to a judgment-maker (model or human) whose own reliability now needs to be verified — which is exactly why LLM-as-judge needs its own bias analysis (`03-llm-as-judge-bias.md`).

## How it works

### Move 1 — the mental model

You know the difference between `assert.strictEqual(a, b)` and `assert.closeTo(a, b, tolerance)` — one demands identity, the other demands "close enough." The eval-methods ladder is the same idea generalized: as the thing you're grading gets fuzzier (a free-text LLM response instead of a number), your assertion has to get fuzzier too, and each step up costs more to run and trust.

```
The ladder — cost and judgment increase together, top to bottom

  exact match      ┌───┐  cheapest, strictest — string/set equality
                    └─┬─┘
  fuzzy match        ┌▼──┐  similarity score ≥ threshold
                      └─┬─┘
  rubric grading      ┌▼──┐  checklist scored against criteria
                       └─┬─┘
  LLM-as-judge         ┌▼──┐  a model scores/critiques the output
                        └─┬─┘
  pairwise comparison   ┌▼──┐  "is A or B better" — relative, not absolute
                         └─┬─┘
  human eval             ┌▼──┐  a person reads and judges directly
                          └───┘  most expensive, most trusted
```

### Move 2 — the six rungs, one at a time

**Exact match — string or set equality. This is what `eval-fixtures.test.ts` does, in full.**

Exact match asks the simplest possible question: is the actual output identical to the expected output? No tolerance, no similarity score, no partial credit. It's the right tool exactly when the system under test is deterministic — which MerchGrid's ten checks are, by design (product spec §27: "Use deterministic checks rather than AI").

Walk the actual code. `eval-fixtures.test.ts` builds a `Set<string>` of `"${checkId}:${severity}"` strings per variant (lines 329–335: `findingsByVariantId`), then for each fixture computes two diffs against the expected array:

```ts
// app/test/eval-fixtures.test.ts, lines 354-367
for (const fixture of FIXTURES) {
  it(`${fixture.label} matches expected findings`, () => {
    const actual = actualFor(fixture.gid);
    const expected = [...fixture.expected].sort();

    const missing = expected.filter((e) => !actual.includes(e));      // expected but absent
    const unexpected = actual.filter((a) => !expected.includes(a));   // present but not expected

    expect(
      { actual, missing, unexpected },
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    ).toEqual({ actual: expected, missing: [], unexpected: [] });
  });
}
```

Annotate this line by line. `actual` is what the real engine produced for this one variant, read back out of the `findingsByVariantId` map built from the real `runChecks` call (line 323). `expected` is the independently-derived array from the fixture table (see `01-eval-set-types.md` for how those values were chosen). `missing` catches false negatives — a check that should have fired but didn't. `unexpected` catches false positives — a check firing when it shouldn't, or firing at the wrong severity (because the string is `checkId:severity`, not just `checkId` — a `WARNING` where you expected `CRITICAL` shows up as both a missing entry and an unexpected one). The final `toEqual` isn't comparing `actual === expected` directly — it's asserting the *diff itself* is empty, which is what makes the custom failure message (`expected [...], got [...]`) show you exactly which check misfired instead of just "assertion failed."

There's a second exact-match assertion worth naming: the orphan check at lines 369–375. It walks every variant that produced *any* finding and confirms each one is a variant the fixture table actually knows about. This closes the other direction of the loop — the per-fixture loop only checks variants you already expect findings for; this check catches a finding appearing on a variant nobody wrote an expectation for at all (which would otherwise pass silently, since no test asserts on that variant).

```
Exact-match assertion — the missing/unexpected diff shape

  expected = ["mg-002:CRITICAL"]          actual = ["mg-002:CRITICAL"]

  missing    = expected − actual   = []     ← nothing expected went unfired
  unexpected = actual − expected   = []     ← nothing unfired went unexpected

  assert { actual, missing, unexpected } == { actual: expected, missing: [], unexpected: [] }
```

Exact match is the right rung here for a structural reason, not a convenience one: `checkId:severity` is a finite, enumerable string — there's no "almost correct" version of `mg-002:CRITICAL`. Either the check fired at that severity for that variant, or it didn't. Fuzzy matching would be solving a problem that doesn't exist in this domain.

**Fuzzy match — similarity above a threshold, not identity. Not exercised here.**

Fuzzy match answers "close enough" instead of "identical" — useful the moment the correct output isn't a single string but a family of acceptable phrasings. Think of grading a free-text summary against a reference summary using an edit-distance or embedding-similarity score, and passing if the score clears some threshold (say, cosine similarity ≥ 0.85). This repo has no output shaped like that — findings are structured `{checkId, severity}` pairs, not prose a merchant reads that could be phrased ten different correct ways — so there's no natural need for it. `not yet exercised`, and for good structural reason: nothing here produces free text that would need a similarity score instead of an equality check.

**Rubric grading — a checklist of criteria, scored (often 0/1 or a small scale) per criterion. Not exercised here.**

A rubric breaks "is this output good" into several concrete, checkable sub-questions — "does it mention the price," "does it explain why this matters," "is the tone appropriate" — and scores each independently, sometimes summed into a total. It's the natural next rung once outputs get long enough that a single pass/fail collapses too much information. If MerchGrid ever surfaces LLM-written explanations to merchants (see the speculative note under Elaborate), a rubric ("does the explanation name the specific variant," "does it avoid suggesting an automatic fix," "does it stay under N words") would be a natural fit before reaching for a full LLM-as-judge. `not yet exercised` — nothing here generates free text a rubric would grade.

**LLM-as-judge — a model scores or critiques another model's output. Not exercised here; see `03-llm-as-judge-bias.md`.**

LLM-as-judge uses a (typically stronger or differently-tuned) model to read an output and a rubric or reference, then produce a score or verdict — useful when human grading doesn't scale but a fixed rubric is too rigid to capture "is this actually good." It comes with its own reliability problem: the judge model has predictable biases (position, verbosity, self-preference) that themselves need auditing before you trust its scores. `not yet exercised` here, because there is no LLM output anywhere in this codebase for a judge to read. The full mechanics of those biases are taught in `03-llm-as-judge-bias.md`.

**Pairwise comparison — "is A or B better," not "score A on its own." Not exercised here.**

Pairwise comparison sidesteps the hardest part of scoring (calibrating an absolute number) by asking a relative question instead: given two candidate outputs for the same input, which one is better? This is how most production model-comparison and RLHF preference data gets collected — it's much easier for a judge (human or model) to say "B is more helpful than A" than to assign A a 7.2/10. Nothing in this repo produces two candidate outputs to compare — the engine either fires a check or it doesn't, there's no "version A vs version B" of a finding. `not yet exercised`.

**Human eval — a person reads the output directly and judges it. Present only as manual QA, not as an eval method for AI output.**

Human eval is the ceiling every other rung is trying to approximate cheaply — a person actually reading the output and deciding if it's right. The product spec's §22.4 Manual QA section describes exactly this discipline for the *product as a whole* (install/uninstall, run a scan, verify CSV export, check accessibility) — but that's a human validating end-to-end app behavior, not a human grading a model's free-text output against a rubric. `not yet exercised` in the AI-eval sense, because there's no AI output to read.

### Move 3 — the principle

The ladder isn't a ranking of "better methods" — it's a menu, and the right rung is whichever one matches how fuzzy the correct answer actually is. Reaching for LLM-as-judge on an output that has one correct answer (a `checkId:severity` pair) would be strictly worse than exact match: slower, non-deterministic, and expensive, for no gain in accuracy. The skill isn't "always use the fanciest eval method" — it's recognizing when the correct answer is a fixed string (use exact match) versus when it's a fuzzy family of acceptable answers (climb the ladder only as far as the fuzziness requires).

## Primary diagram

```
The eval-methods ladder, mapped against this repo

                                              exercised here?
  human eval          ─ full human judgment ──────  no (manual QA exists,
                                                       but for app behavior,
                                                       not AI output)
  pairwise comparison ─ "which is better" ────────  no — no candidate pairs
  LLM-as-judge        ─ model scores model ───────  no — no LLM output
  rubric grading       ─ checklist, scored ────────  no — no free text
  fuzzy match           ─ similarity threshold ────  no — no fuzzy outputs
  exact match           ─ set equality ────────────  YES ★
                                                      eval-fixtures.test.ts
                                                      lines 354-367
                                                      checkId:severity sets
                                                      missing/unexpected diff
```

## Elaborate

The ladder exists because grading cost and grading nuance trade off against each other, and production eval suites usually mix rungs — exact match for structured fields, LLM-as-judge for prose, human eval as a periodic audit of the judge itself. MerchGrid never needs to climb past the first rung today because its outputs are, by design, a finite enumerable set of `{checkId, severity}` pairs — the product spec's insistence on determinism (§2.1, §17.6, §27) is exactly what keeps this eval on the cheapest, strictest rung. If MerchGrid: Bulk AI (referenced in the product spec's §25.4 and §2.3's roadmap diagram) ever generates merchant-facing explanations with an LLM, that's the moment this app would need to climb the ladder — probably landing on rubric grading first (a handful of checkable criteria about tone and content) before reaching for LLM-as-judge, with the golden-set discipline from `01-eval-set-types.md` carried forward as the backbone either way.

## Project exercises

### Write the exact-match assertion from scratch, blind

- **Exercise ID:** EX-1
- **What to build:** Without looking at lines 354–367 of `eval-fixtures.test.ts`, write your own version of the per-fixture assertion: given an `actual: string[]` and `expected: string[]`, compute `missing` and `unexpected` and assert both are empty, with a failure message that prints both arrays. Then diff your version against the real one.
- **Why it earns its place:** The missing/unexpected diff pattern is more useful than a plain `toEqual(actual, expected)` because it tells you *which direction* the mismatch went (false negative vs false positive) without re-running the debugger. Reproducing it from a blank file is the fastest way to internalize why that shape beats a naive equality check.
- **Files to touch:** a scratch file, then `app/test/eval-fixtures.test.ts` to compare.
- **Done when:** Your version produces the same `missing`/`unexpected` output as the real assertion for at least three fixtures you pick by hand, and you can explain out loud why `toEqual({ actual, missing, unexpected }, { actual: expected, missing: [], unexpected: [] })` is more diagnostic than `expect(actual).toEqual(expected)`.
- **Estimated effort:** 20-30 minutes.

### Add a rubric-shaped assertion to a hypothetical LLM output

- **Exercise ID:** EX-2
- **What to build:** As a design exercise (no LLM call needed), write a rubric object for a hypothetical merchant-facing explanation of an `mg-002` finding — 3-4 boolean criteria such as `mentionsVariantTitle`, `mentionsPriceAndCost`, `doesNotSuggestAutomaticFix`, `under50Words` — and a scoring function that returns pass/fail per criterion plus a total. Test it against three hand-written example explanations (one that should pass everything, one that fails one criterion, one that fails all).
- **Why it earns its place:** This is the natural next rung up from exact match, and building it against a hypothetical (rather than real) LLM output forces you to think through what a rubric actually checks before you have a model in the loop to distract you with real, messy output.
- **Files to touch:** a new scratch file (this doesn't touch production code — no LLM output exists yet to grade for real); reference `packages/catalog-checks/src/checks/mg-002.ts` for what a real finding's `title`/`explanation`/`evidence` fields look like today, since a rubric would grade an LLM rewrite of exactly those fields.
- **Done when:** The rubric function correctly scores all three hand-written examples the way you predicted before running it.
- **Estimated effort:** 30-45 minutes.

## Interview defense

**Q: Is a deterministic golden-set eval still "AI engineering," even with an exact-match assertion and zero model calls?**

A: Yes — the eval discipline is what's transferable, not the presence of a model. What makes `eval-fixtures.test.ts` trustworthy — independently-specified ground truth, checked against the real production seam, structurally resistant to "copy the actual output into expected" drift — is exactly the bar an LLM eval has to clear to be trustworthy too. The only thing that changes when you swap in an LLM is which rung of the methods ladder you need (exact match stops working the moment outputs are free text), not whether the underlying discipline holds.

```
What's transferable vs what's incidental

┌─ transferable (the eval discipline) ──────────┐
│ independent ground truth                       │
│ checked against the real seam                  │
│ resistant to snapshot-and-rubber-stamp drift    │
└─────────────────────────────────────────────────┘
┌─ incidental (this repo's specifics) ───────────┐
│ 10 deterministic checks, not an LLM             │
│ exact-match rung, because outputs are enumerable│
└─────────────────────────────────────────────────┘
```

**One-line anchor:** the model behind the seam is incidental; the eval discipline is the transferable skill.

**Q: Why not just use `toEqual(actual, expected)` directly instead of computing `missing`/`unexpected` first?**

A: `toEqual` would tell you the test failed; it wouldn't tell you *which* check misfired without you re-running the debugger by hand. Computing the diff up front means the failure message (`expected [...], got [...]`) already shows you the exact false positive or false negative — the eval is doing diagnostic work, not just pass/fail work. That's a small design choice, but it's the difference between an eval that helps you fix the regression in ten seconds and one that makes you go digging.

**One-line anchor:** a good assertion tells you what broke, not just that something broke.

## See also

- `01-eval-set-types.md` — the golden set this exact-match method is grading against, and why its expectations are independently specified.
- `03-llm-as-judge-bias.md` — the reliability problem you inherit the moment you climb to the LLM-as-judge rung.
- `04-llm-observability.md` — what it takes to observe a pipeline once its outputs stop being exact-match-checkable.
