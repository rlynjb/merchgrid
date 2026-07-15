# LLM-as-Judge Bias

Position bias / verbosity bias / self-preference bias — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Worker layer ──────────────────────────────────────────────┐
│  app/services/scan/runner.server.ts                          │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌─ Engine seam ────────────▼────────────────────────────────────┐
│  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)              │
│  10 deterministic checks — no model anywhere in this path       │
└───────────────────────────┬───────────────────────────────────┘
                            │
┌─ Eval layer ────────────────▼─────────────────────────────────┐
│  app/test/eval-fixtures.test.ts — exact-match against a         │
│  golden set (see 01, 02)                                         │
│                                                                  │
│  ★ THIS CONCEPT lives one rung up the eval-methods ladder ★     │
│  (02-eval-methods.md) — a rung this repo has never needed to     │
│  climb to, because there is no LLM output anywhere for a judge   │
│  to read                                                          │
└─────────────────────────────────────────────────────────────┘
```

LLM-as-judge means using a model to grade another model's output — instead of a human reading every response, you point a (usually stronger, or differently-configured) model at the output plus a rubric or reference answer, and it returns a score or verdict. The immediate appeal is obvious: it scales the way a human reader never could. The catch is that the judge model isn't a neutral referee — it carries specific, well-documented biases that skew its verdicts in predictable directions, and any team relying on LLM-as-judge has to actively correct for them or the scores are just noise wearing a number.

This repo has no LLM output anywhere, so there's no judge to audit — `not yet exercised`. That doesn't make the concept skippable: it's the correctness-critical mechanism the moment any part of this product line (or any other) starts generating free text a human doesn't personally read before it ships.

## Structure pass

**Layers:** LLM-as-judge is a two-model interaction, not a single-model call — a generator model produces the output under test, and a separate judge model (or the same model in a separate call, which is its own bias source — see self-preference below) scores it. Neither model exists in this repo's engine seam; both would be new layers if MerchGrid ever added them.

**Axis to trace: whose incentive shapes the score?**

```
One axis — "what's the judge actually optimizing for?" — across bias types

┌─ position bias ─────┐   optimizes for: whichever slot is easier to
│                      │   default to (usually "first"), not quality
├─ verbosity bias ─────┤   optimizes for: apparent thoroughness (length),
│                      │   not correctness
├─ self-preference ────┤   optimizes for: outputs that match the judge's
│                      │   own generation style, not objective quality
└──────────────────────┘
```

**Seam:** the boundary that matters is between "what the judge is asked to score" (quality, correctness, helpfulness — whatever the rubric names) and "what the judge actually keys off of" (position in the prompt, output length, stylistic similarity to itself). That gap is the whole reason this concept exists — a judge whose actual behavior matched its stated rubric wouldn't need bias-correction at all.

## How it works

### Move 1 — the mental model

You've debugged an A/B test where the winner turned out to be "whichever variant loaded first," not the one users actually preferred — a measurement artifact masquerading as a real signal. LLM-as-judge bias is the same failure mode: the judge's verdict looks like it's measuring quality, but part of what it's actually measuring is an artifact of how the comparison was set up (which output came first, how long it is, whether it resembles the judge's own writing).

```
The judge-bias pattern — score = signal + artifact

┌─────────────────────────────────────────────────────────┐
│  judge(output A, output B)  →  "B is better"               │
│                                                              │
│  what you wanted to measure:   true quality difference       │
│  what you actually measured:   quality difference             │
│                               + position artifact              │
│                               + length artifact                │
│                               + style-similarity artifact       │
└─────────────────────────────────────────────────────────────┘
```

### Move 2 — the three biases, one at a time

**Position bias — the judge favors whichever slot an output sits in, independent of content.**

When a judge is asked to compare two outputs presented in a fixed order ("Response A" then "Response B"), it systematically favors one position over the other — most commonly the first slot — regardless of which response is actually better. Swap the exact same two responses into the opposite slots and the verdict can flip, which is the tell that something other than content is driving the score.

```
Position bias — same two outputs, swapped slots, different verdict

  call 1:  judge( A=good, B=bad )  →  "A wins"     (correct)
  call 2:  judge( A=bad,  B=good ) →  "A wins"     (WRONG — bias, not judgment)
                    ▲
                    └── the judge is keying off "position 1", not content
```

The standard mitigation is running the comparison twice with the outputs swapped and only trusting a verdict that agrees both ways — if the judge picks "A" when good-A is first and "A" again when bad-A is first, that's evidence of position bias contaminating the result, and the comparison should be discarded or flagged rather than trusted.

**Verbosity bias — the judge favors longer outputs, treating length as a proxy for thoroughness.**

Judges systematically score longer responses higher even when the extra length adds no new correct information — padding, restating the question, adding caveats nobody asked for. The judge appears to be rewarding thoroughness; it's actually rewarding word count, which is a much cheaper thing for a generator to game than actual correctness.

```
Verbosity bias — same correctness, different length, different score

  output A (correct, 20 words)   →  judge score: 6/10
  output B (correct, 200 words,  →  judge score: 9/10
            same facts, padded)
                    ▲
                    └── the judge rewarded length, not the extra 180 words
                        containing anything true that A lacked
```

The standard mitigation is a rubric that explicitly penalizes unnecessary length or requires the judge to identify specific added value per additional sentence, not just "is this thorough" — and running length-controlled comparisons (truncating to matched lengths) as a periodic sanity check on the judge itself.

**Self-preference bias — a judge favors outputs that resemble its own generation style, especially strong when the judge and generator share a model family.**

When the same model (or a close relative in the same family) is used as both generator and judge, it tends to rate outputs written in its own style more favorably — the same way a writer might rate an essay more highly if it happens to phrase things the way they would have phrased it. This is the least intuitive of the three because it doesn't require any malicious intent from either model; it's a byproduct of the judge's training data and the generator's training data overlapping.

```
Self-preference bias — same content, different phrasing style, different score

  output from model family X  scored by judge = model family X  → 8.5/10
  output from model family Y  scored by judge = model family X  → 6.0/10
     (same underlying correctness in both — style, not substance, moved the score)
```

The standard mitigation is using a judge from a different model family than the generator whenever feasible, and, where budget allows, cross-checking scores from multiple judge families rather than trusting a single one — an evaluation is only as trustworthy as its most avoidable blind spot, and a same-family judge has a blind spot for its own habits.

### Move 3 — the principle

A judge is a measurement instrument, and every measurement instrument has systematic error alongside the signal it's meant to capture. The discipline isn't "never use LLM-as-judge" — it's the same discipline any calibrated instrument needs: know the instrument's specific failure modes, run controls that isolate them (swap positions, control for length, cross-check across model families), and don't trust a raw score until you've ruled out the artifact explaining it instead of the quality it's supposed to measure.

## Primary diagram

```
LLM-as-judge bias — three failure modes, one shared shape

┌───────────────────────────────────────────────────────────┐
│  judge(output)  →  score                                     │
│                                                                │
│  intended:   score = f(quality)                                │
│  actual:     score = f(quality, position, length, self-style)  │
└───────────────────────────────────────────────────────────┘

  position bias        → mitigate: swap slots, require agreement both ways
  verbosity bias        → mitigate: rubric penalizes padding, length-matched controls
  self-preference bias   → mitigate: cross-family judge, multi-judge cross-check

  status in this repo: not yet exercised — no LLM output anywhere for a judge to read
```

## Elaborate

These three biases come out of the RLHF and model-evaluation literature from roughly 2023 onward, once teams started replacing expensive human preference-labeling with cheaper LLM judges and found the judges' verdicts didn't line up with human raters on the same data — the gap traced back to exactly these three confounds. They matter more as LLM-as-judge scales up in an organization's eval pipeline, because a biased judge doesn't just produce one wrong score, it systematically rewards a specific failure mode across every comparison it ever runs (a generator that learns "the judge likes long answers" will keep getting longer regardless of correctness, if the judge's score feeds back into training or selection).

If MerchGrid: Bulk AI (the roadmap item named in the product spec's §2.3 diagram and §25.4) ever generates merchant-facing explanations or suggested catalog fixes with an LLM, evaluating those outputs is where this concept stops being theoretical. The natural move at that point wouldn't be inventing a new eval discipline from scratch — it would be extending the golden-set discipline already proven in `eval-fixtures.test.ts` (independently-specified expectations, checked against the real generation seam) up to whichever rung the new free-text output requires, most likely rubric grading first, with LLM-as-judge reserved for anything a fixed checklist can't capture. That's a real next step worth naming, but it's speculative — nothing in this codebase generates LLM output today.

## Project exercises

LLM-as-judge has no working example in this repo to extend — there's no LLM output to build exercises against. The two exercises in `02-eval-methods.md` (writing a rubric for a hypothetical `mg-002` explanation) are the closest hands-on entry point; treat this file as the concept to have loaded before that rubric would ever need to escalate to a judge model.

## Interview defense

**Q: If you had to add an LLM-as-judge step to an eval pipeline today, what's the first control you'd put in place?**

A: Position-swap testing, because it's the cheapest bias to catch and the easiest to accidentally ship without noticing. Run every pairwise comparison twice with the two outputs swapped, and only trust a verdict where the judge picks the same winner both times. If a comparison flips depending on slot order, that's not a real preference — it's the judge defaulting to a position, and the comparison should be discarded rather than counted.

```
The position-swap control

  call 1: judge(A, B) → "A"
  call 2: judge(B, A) → "A" (same output, swapped slot)  → consistent → trust it
  call 2: judge(B, A) → "B" (position, not content)       → inconsistent → discard
```

**One-line anchor:** don't trust a verdict until you've swapped the slots and it held.

**Q: Why is self-preference bias worse than the other two when generator and judge are the same model family?**

A: Because it's invisible from a single comparison — position bias and verbosity bias show up as soon as you vary slot order or length, but self-preference only shows up when you compare judgments *across* model families on the exact same output, which most teams don't do by default. A same-family judge will confidently and consistently prefer its own family's phrasing every time, and without a second, differently-sourced judge as a control, there's no signal inside the pipeline telling you the score is skewed at all.

**One-line anchor:** self-preference bias hides until you bring in a judge from a different family to disagree with it.

## See also

- `02-eval-methods.md` — where LLM-as-judge sits on the broader methods ladder, and why exact match is what this repo actually uses instead.
- `01-eval-set-types.md` — the golden-set discipline this repo already proves out, which is what a rubric or judge-based eval would need to inherit if this product line ever adds LLM-generated output.
- `04-llm-observability.md` — the tracing discipline that would let you audit a real judge's verdicts after the fact, if one existed here.
