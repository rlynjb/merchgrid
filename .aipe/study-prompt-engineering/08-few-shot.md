# Few-shot prompting

Subtitle: **few-shot prompting / in-context examples** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where few-shot examples would live

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  no examples needed — checks are exact comparisons           │
│  (lte, lt, eq on decimal.js values), not pattern-matching     │
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — if Bulk AI ever classifies free-text       │
│  merchant notes or product descriptions, examples calibrate     │
│  the model's judgment the way a threshold calibrates a check     │
└─────────────────────────────────────────────────────────────┘
```

Few-shot prompting means showing the model 3–5 worked examples of the input/output pattern you want, instead of (or alongside) describing the pattern in instructions — because examples constrain output more precisely than instructions do. Tell a model "classify sentiment as positive or negative" and it'll improvise at the margins; show it five labeled examples spanning the ambiguous cases you actually care about, and it converges on your specific notion of the boundary instead of a generic one. The tradeoff is token cost: every example burns context on every single call, which is why 3–5 well-chosen examples reliably beats 20 mediocre ones — the marginal example past the first handful teaches the model less than it costs you.

## Structure pass

**Axis: is the decision boundary exact or fuzzy?** This is the question that tells you whether few-shot applies at all. Trace it across a typical few-shot use case and this codebase's checks.

```
axis: how is the decision boundary defined?

few-shot classifier (the pattern):   boundary is FUZZY — "is this
                                       support ticket urgent" has no
                                       formula; examples calibrate
                                       the model's implicit judgment

Catalog Audit checks (today):        boundary is EXACT — mg-008's
                                       outlier check is "price < 0.25x
                                       median OR > 4x median"
                                       (mg-008.ts:21-22), a formula,
                                       not a judgment call
```

**Seam:** few-shot only earns its cost where the boundary can't be written as a rule — the moment you can state the decision as `if (condition)`, examples are strictly worse than the rule itself, because the rule is cheaper (zero tokens) and exactly reproducible. This codebase sits entirely on the "exact rule" side of that seam, which is precisely why none of its checks show or need examples.

## How it works

### Move 1 — the mental model

You already know this from teaching by example versus teaching by description — showing someone three graded essays with margin notes calibrates their sense of "what counts as a B+" faster than a paragraph defining one. Few-shot prompting is that same instinct: instead of trying to fully specify a fuzzy boundary in words, show worked examples that sit near the boundary you care about, and let the model's in-context pattern-matching do the calibration instructions alone can't.

```
Few-shot — examples do the calibrating

  system prompt: "classify request urgency"
        │
        ▼
  example 1: "server is down" → URGENT
  example 2: "can I get a discount code" → NOT URGENT
  example 3: "billed twice, need refund" → URGENT      ← the boundary
        │                                                  cases are
        ▼                                                  the ones
  user's actual request → classify                          worth
                                                              showing
```

### Move 2 — not yet implemented in this codebase

None of the ten checks in `app/packages/catalog-checks/src/checks/` face a fuzzy boundary — every one is an exact comparison on decimal values (`lte`, `lt`, `eq`, `marginPercent` from `app/packages/catalog-checks/src/money.ts`) or an exact structural condition (duplicate SKU via `groupBy`, missing SKU via `normalizeSku(v.sku) === null`). There is nothing here that needs calibration by example, because there is no implicit judgment being approximated — `mg-008.ts:16-26`'s outlier threshold (0.25x–4x median) is a stated formula, not a model's learned sense of "looks off."

The one place this codebase's language gestures at fuzziness is in the finding *copy itself* — `mg-008.ts:34`'s explanation calls the outlier check "a low-confidence signal," acknowledging that the exact rule is a proxy for a fuzzier real-world judgment ("prices may legitimately differ by size, quantity, material, or options"). That's worth noticing precisely because it shows *where* few-shot-style calibration would first become relevant if this check were ever rebuilt on an LLM instead of a formula: the fuzziness is already named in the copy, it's just currently handled by picking a conservative threshold instead of showing examples.

### Move 2.5 — current state vs future state

```
Phase A (now)                            Phase B (Bulk AI, planned)
──────────────                           ──────────────────────────
all boundaries are exact formulas         if Bulk AI ever classifies
(mg-008.ts:21-22, money.ts comparisons)   free text (a merchant's own
no fuzzy judgment anywhere in the         notes, ambiguous product
engine                                    descriptions) into a category,
                                           3-5 boundary-case examples
                                           calibrate that judgment —
                                           the same role mg-008's
                                           threshold plays today, just
                                           for a boundary that can't be
                                           written as a formula

what doesn't have to change: prefer the exact rule wherever one
exists. Few-shot is for the residual cases a rule genuinely can't
capture, not a default reached for out of habit.
```

### Move 3 — the principle

Few-shot prompting is a tool for exactly one situation: a decision boundary that resists being written as a rule. The moment you can state the rule, write the rule — it's cheaper, deterministic, and testable without an eval set. This codebase's checks are a clean illustration of the opposite case: every boundary here was exact enough to be a formula, so none of them needed an example.

## Primary diagram

```
Few-shot — where it would apply, and where it doesn't

  fuzzy boundary (few-shot earns its cost)   exact boundary (a rule is strictly better)
  ┌────────────────────────────┐             ┌────────────────────────────┐
  │ "is this note concerning?"    │             │ price < 0.25x median          │
  │  → needs calibration by        │             │  → mg-008.ts:21-22, a formula, │
  │  worked example                 │             │  zero tokens, exact              │
  └────────────────────────────┘             └────────────────────────────┘
```

## Elaborate

The "3–5 good examples beats 20 mediocre ones" rule comes from how in-context learning actually degrades — past a handful of examples, additional ones mostly add noise and token cost rather than sharpening the boundary, unless each new example targets a genuinely distinct edge case the earlier ones didn't cover. Few-shot also interacts directly with `02-structured-outputs.md`: a well-chosen example can *be* the structured output form itself, showing the model not just the classification but the exact JSON shape expected in response.

## Project exercises

### Exercise: identify Bulk AI's first genuinely fuzzy boundary

- **What to build:** before writing any few-shot prompt, audit Bulk AI's planned classification points and sort each into "this is a formula" (use a rule, like this codebase's checks) versus "this requires judgment" (a real few-shot candidate) — resist the default of reaching for examples before checking whether a rule already covers it.
- **Why it earns its place:** this codebase's engine is ten data points of evidence that most catalog-audit judgment turns out to be an exact rule in disguise; Bulk AI's first fuzzy boundary is probably rarer than it initially looks.
- **Files to touch:** none yet — this is a design audit, not an implementation.
- **Done when:** every planned classification point has an explicit "rule" or "judgment" label and a one-line justification.
- **Estimated effort:** a few hours of design review.

## Interview defense

**Q: When should you reach for few-shot instead of a plain rule?**
A: Only when the boundary genuinely can't be written as a condition — when it depends on nuance a formula can't capture. If you can write `if (x < threshold)`, write that instead; it's cheaper, deterministic, and doesn't need an eval set to trust.

```
the answer, sketched
┌─ can state it as a rule? ──┐
│         YES                 │  → write the rule (zero tokens, exact)
│         NO                  │  → few-shot: 3-5 boundary-case examples
└──────────────────────────┘
```

**Q: This codebase has no few-shot prompting. What's the honest reason?**
A: Every check's decision boundary is an exact formula on decimal values or exact structural conditions — there's no fuzzy judgment anywhere in the engine for examples to calibrate. The one place fuzziness is acknowledged at all is in the finding copy itself (`mg-008.ts:34`'s "low-confidence signal"), which names where the approximation lives without needing an LLM to handle it.

## See also

- `01-anatomy.md` — where few-shot examples slot into the four-section prompt
- `02-structured-outputs.md` — an example can double as the structured-output form itself
