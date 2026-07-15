# Sampling Parameters

**Sampling parameters (temperature, top-p, top-k) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where a sampling decision would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app.settings.tsx: minimumMarginPercent (0-90) — a merchant-  │
│  configurable NUMBER, but not a sampling knob — see below     │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  runner.server.ts builds a CatalogCheckContext and calls        │
│  runChecks(ALL_CHECKS, ctx) — ONE deterministic call, no         │
│  probability distribution anywhere in this call chain            │
│                                                                    │
│         ★ a sampling decision would live in a future model call ★ │
│         — does not exist; nothing here samples from anything      │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks/src/checks/mg-*.ts ─────┐
│  each check is `if/else` over decimal.js comparisons — a boolean, │
│  never a probability                                              │
└───────────────────────────────────────────────────────────────┘
```

`01-what-an-llm-is.md` left "sample one token from the distribution" as a black box. This file opens it: given a probability distribution over 50,000+ candidate tokens, how do you actually pick one, and why does that choice matter enough to expose as a request parameter?

## Structure pass

**Layers:** same four bands. The concept lives entirely inside the "engine layer" band of an LLM-based system — it's a per-token decision made during generation, invisible to the UI and service layers above it (they just see the final text).

**Axis: guarantees — what's promised, deterministic vs best-effort?** Trace it across MerchGrid's real engine: `mg-001.ts` through `mg-010.ts` each promise an *exact*, reproducible boolean per variant — same input, same output, always (verified by the unit tests listed in the product spec's §22.1: "Every check with passing, failing, null, and boundary cases"). A sampling-based system promises the opposite by default: even at a fixed prompt, a `temperature > 0` call can return a different token, and therefore a different final answer, on two identical requests.

**Seam:** the seam that matters here is temperature itself — it's a dial between two regimes (deterministic argmax at `temperature = 0` vs. increasingly random sampling above it), and which side of that dial you're on is a load-bearing product decision, not a tuning nicety. MerchGrid's real engine sits permanently and structurally on the "deterministic" side — there's no dial in this repo to turn, because there's no sampling step to attach one to.

## How it works

### Move 1 — the mental model

You've called `Math.random()` and used it to pick a weighted outcome — maybe a randomized A/B assignment, or a loot-table roll in a game. Sampling from an LLM's output distribution is exactly that: you have a list of candidates, each with a probability, and you roll a weighted die to pick one. The knobs (`temperature`, `top-p`, `top-k`) don't change *what* the model thinks is likely — they change how the weighted die is shaped before you roll it.

```
Pattern — reshaping a fixed distribution before sampling

  raw distribution over next token (fixed, from the model's forward pass):
    "cat"   0.42   "dog"   0.31   "car"   0.11   "cats"  0.09   [...long tail]

  temperature < 1  →  sharpens the distribution (favors the top candidates more)
  temperature > 1  →  flattens it (long-tail tokens become more likely)
  temperature = 0  →  collapses to argmax: always pick "cat", no randomness

  top-k = 2        →  throw away everything but {"cat", "dog"}, renormalize, sample
  top-p = 0.9      →  keep the smallest set of top candidates whose probabilities
                       sum to ≥ 0.9, throw away the rest, renormalize, sample
```

### Move 2 — the step-by-step walkthrough

**Part 1 — temperature reshapes the distribution before you sample, it doesn't pick anything itself.** The model's raw output (called "logits") gets divided by the temperature value before the final softmax turns them into probabilities. Divide by a number less than 1 and the gap between the top candidate and everything else widens — the model becomes more confident-looking. Divide by a number greater than 1 and the gap narrows — low-probability tokens get a real shot. At `temperature = 0`, the softmax step is skipped entirely and you just take the single highest-probability token every time — the generation loop becomes pure argmax, and if nothing else in the pipeline introduces randomness, the same prompt produces the same output every call.

```
function applyTemperature(logits, temperature):
  if temperature == 0:
    return argmax(logits)               // always pick the single best token
  scaled = logits / temperature          // one operation per element
  return softmax(scaled)                 // now a probability distribution
```

**Part 2 — top-k and top-p are truncation, not reshaping.** Where temperature stretches or squashes the whole curve, top-k and top-p just delete the tail before you sample from what's left. Top-k keeps a fixed count ("only the 40 most likely tokens survive"); top-p (a.k.a. nucleus sampling) keeps a variable count chosen so the *combined* probability of survivors passes a threshold ("keep however many tokens it takes to cover 90% of the probability mass"). Both exist to solve the same failure mode: even with a well-shaped distribution, the long tail of a 50,000-token vocabulary can occasionally hand you a bizarre, low-probability token purely by bad luck. Truncating the tail before sampling makes that rarer without needing `temperature = 0`'s total loss of variety.

```
Pattern — top-k vs top-p, same goal (cut the tail), different rule

  sorted candidates:  cat(.42)  dog(.31)  car(.11)  cats(.09)  ...tail(.07)

  top-k = 3   → survivors = { cat, dog, car }                (fixed COUNT)
  top-p = 0.8 → survivors = { cat, dog }         (.42+.31=.73, +car=.84 ≥ .8)
                                                   (fixed MASS, variable count)
```

**Part 3 — why anyone wants randomness at all.** If determinism were strictly better, every provider would ship `temperature = 0` as the only option. The reason it isn't: for open-ended generation (brainstorming, varied phrasing, creative writing) always taking the single most likely token produces flat, repetitive, sometimes looping text — the model gets stuck restating the "safest" continuation. A little controlled randomness (`temperature` around 0.5-0.8, commonly paired with `top-p` around 0.9) produces output that reads as more natural without going fully random. This is a genuine, deliberate tradeoff: you're trading reproducibility for variety, and the right setting depends entirely on the task — code generation and structured extraction usually want `temperature` near 0; creative or conversational tasks usually don't.

**In this codebase:** not yet implemented — there is no sampling call, no logits, no temperature parameter anywhere in this repo, because there's no model producing a probability distribution in the first place. The closest thing MerchGrid has to a "configurable decision threshold" is `ShopSettings.minimumMarginPercent` (`app/app/models/settings.server.ts` lines 39-42, validated 0-90 by `assertValidMargin`), which a merchant tunes to control how sensitive `mg-003` is. It's worth being precise about why that's *not* a sampling parameter even though both are "a merchant-configurable number that changes what gets flagged": `minimumMarginPercent` is compared against an exact decimal (`mg-003.ts` line 26: `if (m < ctx.settings.minimumMarginPercent)`) — it changes the *threshold* in a deterministic comparison, it never introduces randomness into which variants get flagged. Run the same catalog through `mg-003` twice with the same threshold and you get the identical finding set both times, which is exactly the guarantee a temperature dial would break.

If MerchGrid ever built the AI-assisted bulk editor, the temperature/top-p decision would attach the moment a proposed changeset is generated (spec §25.4) — and the honest engineering call there is `temperature` at or near 0: a merchant reviewing a proposed bulk price change needs the same prompt to produce the same proposal on retry, for the same reason `mg-003` needs to be reproducible today. High-temperature creative sampling has no place generating a changeset that mutates real store data.

### Move 3 — the principle

Sampling parameters don't change what the model "believes" is likely — they change how you're allowed to roll the dice against a probability distribution the model already computed. `temperature` reshapes the curve; `top-k`/`top-p` truncate its tail. The only way to get true determinism out of an LLM call is `temperature = 0` (pure argmax) — everything above that is a controlled amount of randomness you're choosing to accept in exchange for variety, and the right choice is entirely task-dependent.

## Primary diagram

```
Primary diagram — the sampling step, and its deterministic analog in MerchGrid

  probability distribution ──► temperature (reshape) ──► top-k/top-p (truncate)
  (from the model's forward         │                            │
   pass, see 01-what-an-llm-is)     ▼                            ▼
                              sharper/flatter curve      smaller candidate set
                                                                  │
                                                                  ▼
                                                        weighted random sample
                                                        (or argmax at temp=0)

  MerchGrid: Catalog Audit today  →  no distribution exists to sample from;
                                      mg-003 compares an exact decimal against
                                      ctx.settings.minimumMarginPercent — a
                                      threshold, not a sampling knob
  MerchGrid: Bulk AI (roadmap)    →  a changeset generator would need
                                      temperature near 0 for reproducible
                                      proposed edits
```

## Elaborate

Temperature-scaled softmax sampling predates modern LLMs — it's a standard technique from statistical mechanics (the Boltzmann distribution) borrowed into machine learning wherever you need a tunable "sharpness" knob on a probability distribution, long before GPT-style language models existed. Top-p (nucleus) sampling is newer and LLM-specific, introduced in a 2019 paper ("The Curious Case of Neural Text Degeneration") specifically to fix the repetitive/degenerate text that pure temperature sampling or top-k alone tended to produce. The throughline worth remembering: every sampling strategy you'll encounter is solving the same problem — a distribution over tens of thousands of tokens has a long, noisy tail, and you need a principled way to keep the interesting middle without either collapsing to boring determinism or sampling actual noise.

## Project exercises

### Build a toy weighted-sampler to internalize the mechanism

- **Exercise ID:** EX-1
- **What to build:** A standalone, framework-free TypeScript module (e.g. `app/app/services/ai/sample.ts`, not wired into any route) implementing `applyTemperature(logits: number[], temperature: number): number[]`, `topK(probs: number[], k: number): number[]`, `topP(probs: number[], p: number): number[]`, and `sample(probs: number[]): number` (weighted random draw). Cover them with unit tests using small, hand-picked distributions so you can verify the exact output by hand.
- **Why it earns its place:** This is the closest thing to "build BFS from scratch to trust it" for the sampling mechanism — implementing temperature scaling and nucleus truncation yourself is what makes "reshape then truncate then sample" a mechanism you own, not a phrase you memorized.
- **Files to touch:** New file `app/app/services/ai/sample.ts`; new test `app/app/services/ai/sample.test.ts`.
- **Done when:** A test asserts that `temperature = 0` on a distribution with a clear top candidate always returns that candidate, and that `topP(probs, 0.8)` on the worked example in this file's Move 2 Part 2 returns exactly `{cat, dog}`.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: What's the difference between temperature and top-p, and when would you use one over the other?**
A: Temperature reshapes the *whole* probability curve before you sample — it doesn't remove any candidates, it changes how confident-looking the distribution is. Top-p removes candidates outright, keeping only the smallest set whose combined probability crosses a threshold. In practice you usually tune both together: temperature around 0.7-0.8 with top-p around 0.9 is a common "creative but not degenerate" combination; for anything requiring exact, repeatable output (structured extraction, code generation, a bulk price-change proposal) you'd drop temperature to 0 and top-p becomes irrelevant, because argmax never looks at the tail at all.

```
  temperature: reshapes the curve (sharper/flatter)
  top-p/top-k: truncates the tail (fixed mass / fixed count)
  used together: reshape, THEN truncate, THEN sample
```

**Q: Why does MerchGrid: Catalog Audit never need to think about temperature at all?**
A: Because nothing in its pipeline ever produces a probability distribution to sample from. `runChecks` (`app/packages/catalog-checks/src/run.ts` lines 26-28) is a synchronous `flatMap` over pure functions — every check does an exact decimal comparison (`money.ts`'s `lt`/`lte`/`marginPercent`, all `decimal.js`) and returns a fixed boolean per variant. The nearest thing to a "tunable knob" is `ShopSettings.minimumMarginPercent`, and it changes a comparison threshold, not the odds of an outcome — the same catalog and the same threshold always produce the same findings, which is exactly the property a sampling step would put at risk.

**Q: If you had to add an LLM-generated proposal step to MerchGrid, what temperature would you pick and why?**
A: Near 0. A merchant reviewing a proposed bulk price change (spec §25.4) needs to trust that re-running the same prompt against the same catalog produces the same proposal — the whole review-and-approve workflow assumes reproducibility. High temperature buys you variety you don't want when the output is about to become a real write to a merchant's store.

## See also

- `01-what-an-llm-is.md` — the generation loop this file's "sample" step is one part of.
- `02-tokenization.md` — the vocabulary the probability distribution is defined over.
- `04-structured-outputs.md` — how you constrain sampling further so the output parses as valid JSON/schema, not just plausible text.
- `app/packages/catalog-checks/src/checks/mg-003.ts` — the real, deterministic threshold comparison used as the contrast case throughout this file.
