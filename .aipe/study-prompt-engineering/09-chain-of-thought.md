# Chain-of-thought (CoT)

Subtitle: **chain-of-thought prompting / explicit reasoning traces** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where chain-of-thought would apply

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  reasoning is already explicit — it's just TypeScript control │
│  flow, not a model narrating its steps                        │
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — a multi-step decision ("should this        │
│  changeset be proposed, given margin, price, and inventory       │
│  status together") benefits from a reasoning trace the way        │
│  mg-003's multi-step math benefits from being written out          │
└─────────────────────────────────────────────────────────────┘
```

Chain-of-thought is asking a model to reason step by step before giving a final answer, instead of jumping straight to the answer — and it measurably helps on multi-step problems (arithmetic chains, multi-hop logic) while wasting tokens on simple lookups or already-structured classification, where there's no reasoning to show. The caveat worth knowing in 2026: frontier models increasingly do CoT internally now, as part of how they're trained to respond, so explicitly asking for it is less necessary than it was in 2023 — it still helps meaningfully on cheaper or smaller models that don't reason as well by default. And the modern interaction with structured output matters: if you want both a reasoning trace *and* a clean structured answer, the reasoning goes in a dedicated `"thinking"` field of the schema, not mixed into free-form prose ahead of the JSON — otherwise you're back to `07-output-mode-mismatch.md`'s problem, a parser expecting one shape getting handed prose-then-JSON instead.

## Structure pass

**Axis: is the multi-step reasoning explicit or is it happening invisibly?** Trace it across a CoT prompt and this codebase's multi-step checks.

```
axis: where does the "show your work" step live?

CoT prompt:               reasoning trace is TEXT the model writes,
                           before the final answer, so a human or a
                           downstream step can inspect the intermediate
                           logic — the trace IS the work being shown

Catalog Audit mg-002/003:  reasoning trace is CODE — every intermediate
(today)                     value is a named variable, computed by a
                            named function, in a fixed order; "the
                            work" is the source code itself, always
                            inspectable, never narrated
```

**Seam:** the seam is between "the intermediate steps are inspectable because someone wrote a trace" and "the intermediate steps are inspectable because the code itself names each one." This codebase sits entirely on the second side — nothing here needs to be asked to show its work, because the work already has names.

## How it works

### Move 1 — the mental model

You already know this from debugging by adding intermediate `console.log`s instead of trusting a one-line calculation blindly — breaking `finalPrice = basePrice * (1 - discount) + tax` into three named steps makes an error easier to spot than one dense expression. Chain-of-thought is that same instinct applied to a model's reasoning: instead of one leap from question to answer, force (or let) the model narrate `step 1 → step 2 → step 3 → answer`, so an error in step 2 is visible instead of buried inside a single opaque inference.

```
Chain-of-thought — the shape

  question ──► "let's think step by step"
                      │
                      ▼
              step 1: [intermediate reasoning]
              step 2: [intermediate reasoning]
              step 3: [intermediate reasoning]
                      │
                      ▼
                 final answer
```

### Move 2 — the same instinct, already satisfied without a model

`mg-002` (selling price below unit cost) computes a multi-step result — loss per unit and margin percent both derive from price and unit cost — and every intermediate value is a named variable, computed in a fixed, readable order:

```ts
// app/packages/catalog-checks/src/checks/mg-002.ts:15-31 (excerpted)
const price = v.price as string;
const unitCost = v.unitCost as string;
return findingFor(v, ctx, {
  // ...
  evidence: {
    price,
    unitCost,
    lossPerUnit: sub(unitCost, price),          // step 1, named
    marginPercent: marginPercent(price, unitCost), // step 2, named
  },
});
```

This is functionally what a chain-of-thought trace is for: making an intermediate step inspectable instead of buried inside one opaque computation. The difference is that here the "trace" is compiled, typed source code — `sub()` and `marginPercent()` (`app/packages/catalog-checks/src/money.ts`) are named functions a reader can open, not a narration a model generates fresh every call and might get subtly wrong. A model asked to compute this same result without CoT would do the arithmetic silently and might make an error nobody can see; asked with CoT, it writes out the steps, which is strictly worse than what this codebase already has — the steps here are guaranteed correct by the type system and the decimal library, not just narrated plausibly.

### Move 3 — the principle

Chain-of-thought exists to make an opaque single-shot inference inspectable by breaking it into named, ordered steps — which is exactly what writing code already does, for free, every time. The concept only earns its keep where the "code" is a model's forward pass and there's no other way to see the intermediate steps; wherever the logic can be actual source code instead, you get inspectability without needing to ask for it, and without the risk of the narration itself being wrong.

## Primary diagram

```
Chain-of-thought — same instinct, two mechanisms

  CoT prompt (narrated reasoning)          mg-002.ts (compiled reasoning)
  ┌────────────────────────────┐          ┌────────────────────────────┐
  │ "step 1: compute loss..."     │          │ lossPerUnit: sub(unitCost,   │
  │  (model-generated text,        │◄───────►│   price)  — named, typed      │
  │  may be subtly wrong)           │  same    │  (money.ts, mg-002.ts:27)     │
  ├────────────────────────────┤  goal:   ├────────────────────────────┤
  │ "step 2: compute margin..."   │  inspect  │ marginPercent: marginPercent  │
  │                                 │  the      │  (price, unitCost)             │
  │                                 │  steps    │  (money.ts, mg-002.ts:28)     │
  └────────────────────────────┘          └────────────────────────────┘
```

## Elaborate

The original chain-of-thought result (Wei et al., 2022) showed it helping specifically on arithmetic and multi-hop reasoning benchmarks — tasks where the model's default behavior was to jump straight to a plausible-looking wrong answer. As models have been post-trained with reasoning built in (the shift toward "thinking" models around 2024–2025), the gap between "asked for CoT explicitly" and "reasons by default" has narrowed for frontier models, though it remains meaningful for smaller or cheaper models used for cost reasons in a pipeline.

## Project exercises

### Exercise: decide, per Bulk AI decision point, whether CoT is worth asking for

- **What to build:** for each place Bulk AI makes a multi-step judgment (e.g., "should I propose fixing this margin, given the check's threshold, the merchant's settings, and inventory status together"), test the target model with and without an explicit CoT instruction and measure whether the eval score changes — don't assume CoT helps without checking, since frontier models often reason internally already.
- **Why it earns its place:** the token cost of an unnecessary reasoning trace is real and this codebase's own multi-step checks (mg-002, mg-003) are proof that named, ordered logic doesn't require narration to be inspectable — the same discipline should make you skeptical of CoT where a rule would do.
- **Files to touch:** none yet — this is an eval-set experiment (see `05-eval-driven-iteration.md`), run before any prompt ships.
- **Done when:** you can state, with an eval score attached, whether CoT measurably changed the outcome for this specific decision point on this specific model.
- **Estimated effort:** a day, mostly eval-running.

## Interview defense

**Q: Does chain-of-thought still matter with frontier models in 2026?**
A: Less than it did in 2023, because post-training increasingly builds reasoning in by default — but it still measurably helps on smaller or cheaper models used for cost reasons, and the interaction with structured output (put the reasoning in a dedicated `"thinking"` schema field, not loose prose before the JSON) still matters regardless of model tier.

```
the answer, sketched
┌─ frontier model, 2026 ──┐        ┌─ smaller/cheaper model ──┐
│ CoT helps less — reasons   │        │ CoT still helps —            │
│ internally by default        │        │ explicit trace compensates    │
└──────────────────────────┘        └──────────────────────────┘
```

**Q: This codebase has no CoT — what's the load-bearing takeaway that still applies?**
A: Inspectability of intermediate steps is the actual goal, and code gets you that for free. `mg-002.ts`'s named, ordered `lossPerUnit`/`marginPercent` computation is what a CoT trace is trying to approximate in natural language — reach for the rule wherever you can, and reserve CoT for the residual case where the "code" really is a model's forward pass.

## See also

- `10-self-critique.md` — the next step past reasoning: having the model check its own trace
- `07-output-mode-mismatch.md` — why reasoning and structured output need separate schema fields
