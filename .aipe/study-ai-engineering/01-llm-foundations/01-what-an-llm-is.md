# What an LLM Is

**Large language model (LLM) — Industry standard**

## Zoom out, then zoom in

Here's the whole MerchGrid stack, top to bottom:

```
Zoom out — where an LLM would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions       │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  queue.server.ts → runner.server.ts → catalog-reader.server.ts │
│  (fixed pipeline: QUEUED → READING_CATALOG → RUNNING_CHECKS    │
│   → PREPARING_RESULTS → COMPLETED, enforced by state.ts)       │
│                                                                 │
│              ★ an LLM call does not exist anywhere here ★      │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-core, packages/catalog-checks ┐
│  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)              │
│  10 hand-written rules, decimal.js arithmetic, zero ML           │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ───────────────────────────────┐
│  Shop, ShopSettings, Scan, Finding tables                        │
└───────────────────────────────────────────────────────────────┘
```

You already know the shape of an LLM before you've opened a single doc on it: you type into ChatGPT, text comes back. What's actually happening is closer to autocomplete than to a database lookup — the model has no stored answers, it has a frozen set of numbers (weights) and a procedure for turning "the tokens I've seen so far" into "a probability distribution over the next token." Run that procedure once per token, in a loop, and you get a sentence. That's the whole trick. Everything else — chat formatting, tool calls, "reasoning" — is scaffolding built on top of that one repeated operation.

MerchGrid: Catalog Audit does not have that scaffolding, or the operation underneath it, anywhere in its codebase. This file teaches the mechanism properly, then tells you exactly where it isn't, and where it would attach if MerchGrid ever grows the LLM-assisted bulk editor described in its own product spec.

## Structure pass

**Layers:** UI (Remix routes) → service (scan pipeline, `app/app/services/scan/`) → engine (pure packages: `catalog-core`, `catalog-checks`) → storage (Prisma/SQLite).

**Axis: control — who decides what happens next?** Trace it top to bottom. UI: the merchant decides *when* (click "Start scan"). Service: the code decides *what* — `runScan` in `runner.server.ts` walks a hardcoded sequence, and `assertTransition` in `app/app/services/scan/state.ts` (lines 40-56) throws if anything tries to skip a step. Engine: `runChecks` (`app/packages/catalog-checks/src/run.ts` lines 26-28) is a pure `flatMap` — given the same `CatalogCheckContext`, it always returns the same `CatalogFinding[]`. Storage: passive, just holds rows.

**Seam: none of these layers ever hand control to a model that "decides" anything.** An LLM's job, if MerchGrid grew one, would be to occupy a *fifth* answer to "who decides" — not code executing a fixed branch, not a merchant clicking a button, but a model choosing the next token based on a learned probability distribution. That seam — code that hands a decision to a model instead of making it directly — does not exist anywhere in this repo today. Naming that absence precisely is the whole point of this file.

## How it works

### Move 1 — the mental model

You've used `Array.prototype.reduce()` — you start with an accumulator, apply a function once per element, and the accumulator carries forward. An LLM's generation loop is the same shape, except the "array" is the sequence of tokens generated so far, and the "function" is a giant matrix of frozen numbers (the weights) that takes the sequence and returns a probability for every possible next token. You pick one (more on *how* in `03-sampling-parameters.md`), append it, and feed the whole thing back in.

```
Pattern — the autoregressive loop

  tokens so far: [ The, cat, sat, on, the ]
                        │
                        ▼
              ┌───────────────────┐
              │  model (frozen    │   one forward pass
              │  weights, fixed   │──────────────────────► probability
              │  function)        │                        distribution
              └───────────────────┘                        over every
                        ▲                                   token in the
                        │                                   vocabulary
                        │        pick one token (sampling)
                        └──────────────── mat ◄── argmax / top-p / temp
                                           │
                        append "mat" to the sequence, repeat
                        stop when a stop-token or length limit hits
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the model is a fixed function, not a lookup table.** "Training" happens once, offline, over weeks, on a fixed dataset — the output is a large set of numeric weights (billions of them) baked into files. "Inference" — the thing that happens when you send a prompt — never changes those weights. Every request runs the *same* function; the only thing that varies request to request is the input tokens and, if you enable it, the random seed used for sampling. This is the load-bearing fact that everything else in this guide builds on: an LLM at inference time is deterministic *math* wrapped in an optional layer of randomness you control (`03-sampling-parameters.md`).

**Part 2 — text goes in as numbers, not characters.** The model's matrices operate on integers (token IDs), not strings. "The" isn't fed in as four characters; it's looked up in a fixed vocabulary and replaced with an ID like `464`. The full mechanics of that step — why it's not one-ID-per-character and not one-ID-per-word either — is `02-tokenization.md`. For this file, the only thing that matters is that the "sequence" in the diagram above is a sequence of integers, and the "probability distribution over every token" is a distribution over every entry in that fixed vocabulary (tens of thousands of entries, typically).

**Part 3 — the loop terminates on a stop condition, not when the model "decides it's done."** Pseudocode for the whole generation loop:

```
function generate(prompt, model, maxTokens):
  tokens = tokenize(prompt)                 // Move 2 Part 2
  output = []

  for step in 1..maxTokens:
    distribution = model.forward(tokens + output)   // one matrix pass
    nextToken = sample(distribution)                // 03-sampling-parameters.md
    if nextToken == STOP_TOKEN:
      break                                          // model learned to emit this
    output.append(nextToken)

  return detokenize(output)
```

Two boundary conditions matter here, because they're the ones people gloss over: (1) if `maxTokens` is hit before a stop token, generation is truncated mid-thought — that's a real failure mode in production systems, not a hypothetical; (2) the `model.forward` call is *stateless per call* — nothing about "conversation history" is stored inside the model between requests. Every multi-turn chat re-sends the entire prior transcript as input tokens on every call. That fact is why token budgets (`06-token-economics.md`) and context windows are a hard architectural constraint, not a tuning knob.

**In this codebase:** not yet implemented — MerchGrid: Catalog Audit has no LLM integration anywhere. Grep the repo and you won't find an API key for an inference provider, a prompt string, or a token-counting utility. That's not an oversight; the product spec is explicit about it. Section 2.1 lists "Deterministic: Findings come from explicit validation rules rather than an LLM" as one of the reasons this product was chosen to ship *first*, and section 17.6 tells the team not to lead marketing copy with "Powered by AI" for this app. The 10 checks in `app/packages/catalog-checks/src/checks/mg-001.ts` through `mg-010.ts` do the entire job MerchGrid does today — see `07-heuristic-before-llm.md` for the full teaching on why a heuristic system, not an LLM, is the right tool here.

If MerchGrid ever ships the roadmapped "MerchGrid: Bulk AI" product (spec §25.4), an LLM call would attach in a **new** layer — speculatively `app/app/services/ai/`, sitting *before* the existing check engine in the pipeline, not instead of it. The future flow the spec describes (§25.4) is:

```
Future flow — where an LLM would attach (speculative, not built)

  Merchant prompt or CSV
          │
          ▼
  ┌─ new: services/ai/ ───────────┐   an LLM call would live here —
  │  LLM proposes a changeset      │   does not exist in this repo yet
  └───────────────┬────────────────┘
                  │  proposed changeset (same NormalizedVariant shape)
                  ▼
  ┌─ existing: packages/catalog-checks ─────────────────────────┐
  │  runChecks(ALL_CHECKS, ctx)  →  preflight the LLM's output   │ ← real code today
  └───────────────┬───────────────────────────────────────────────┘
                  │  CRITICAL blocks, WARNING requires review
                  ▼
          Merchant approval → Shopify write → post-write verification
```

The important thing that diagram tells you: the LLM, when it arrives, is not replacing the deterministic engine — it's sitting *upstream* of it, generating proposals that the existing `CatalogCheck`/`CatalogFinding` contract (`app/packages/catalog-checks/src/contract.ts` lines 1-32) would validate exactly the way it validates a merchant's real catalog today. That's the product decision in spec §27: "Design the check engine as a reusable package for the future MerchGrid: Bulk AI product."

### Move 3 — the principle

An LLM is a fixed, frozen function from "sequence of tokens so far" to "probability distribution over the next token," run in a loop until a stop condition. Nothing about that function is stateful, learned-at-request-time, or aware of your specific application — every bit of "intelligence" your product gets out of it comes from what you feed into the sequence (prompting, retrieval, tool results) and how you sample from the distribution it hands back. That's the entire surface area you, as the engineer building around it, actually control.

## Primary diagram

```
Primary diagram — the LLM as a component, and where it isn't in MerchGrid

  ┌────────────────────────────────────────────────────────────┐
  │  INFERENCE (the only thing that happens per-request)        │
  │                                                              │
  │   tokens in ──► [ frozen weights, one forward pass ] ──►    │
  │                                    probability distribution  │
  │                                          │                   │
  │                                          ▼                   │
  │                              sample → append → loop          │
  │                              until stop token / max length   │
  └────────────────────────────────────────────────────────────┘

  MerchGrid: Catalog Audit today  →  no box like this exists in the repo
  MerchGrid: Bulk AI (roadmap)    →  would sit in a new services/ai/ layer,
                                      upstream of packages/catalog-checks
```

## Elaborate

The autoregressive next-token loop isn't new to transformers — it's the same idea n-gram language models and RNN/LSTM language models used for decades, just with a much better function approximator underneath. What changed with "Attention Is All You Need" (2017) and the GPT line that followed is *what* the function is (a stack of self-attention blocks that can be trained in parallel across an entire sequence, instead of the sequential-by-nature RNN) and how far scaling that function keeps improving results. The mechanism you just learned — tokens in, distribution out, sample, loop — is unchanged since 2017; what's evolved on top of it is prompting technique, sampling strategy, and post-training (RLHF/instruction-tuning) that shapes the distribution toward "helpful assistant" behavior instead of raw next-word prediction. The next two files in this guide build on this foundation directly: `02-tokenization.md` opens up the "tokens in" step, and `03-sampling-parameters.md` opens up the "sample" step.

## Project exercises

### Stub an LLM-shaped seam without a real model

- **Exercise ID:** EX-1
- **What to build:** A new `app/app/services/ai/proposal-generator.server.ts` module exporting a single function, `generateProposedChangeset(prompt: string, catalog: NormalizedVariant[]): NormalizedVariant[]`, that does *not* call a real model — it deterministically mutates one field (e.g., bumps every matching variant's price by a fixed percentage) so you can wire the seam without needing an API key. Document in a comment exactly where a real `model.forward()`-style call would replace the stub.
- **Why it earns its place:** It forces you to design the exact interface boundary the future MerchGrid: Bulk AI integration would need — input shape, output shape, and where in the pipeline it sits relative to `runChecks` — without the cost or nondeterminism of a live model call.
- **Files to touch:** New file `app/app/services/ai/proposal-generator.server.ts`; new test `app/app/services/ai/proposal-generator.test.ts`.
- **Done when:** The stub's output, when passed straight into `runChecks(ALL_CHECKS, ctx)` (`app/packages/catalog-checks/src/run.ts`), produces findings exactly like a real catalog would — proving the check engine can preflight a *proposed* changeset the same way it audits a *live* one.
- **Estimated effort:** 1-2 hours.

### Trace the "control" axis through a real request

- **Exercise ID:** EX-2
- **What to build:** Nothing new — a written trace (a short markdown note, or comments added to `runner.server.ts`) that annotates every function call in `runScan` (`app/app/services/scan/runner.server.ts` lines 59-225) with "who decided this happens": merchant, code, or (hypothetically) model. Use it to confirm there is currently zero "model decided" entries.
- **Why it earns its place:** This is the fastest way to internalize the structure-pass axis (control) well enough to explain it in an interview — you're not reciting a definition, you traced a real pipeline and found the answer was "code, every single time."
- **Files to touch:** No production files; a scratch note is enough (or inline comments in a local branch you don't commit).
- **Done when:** You can list, from memory, the five stages in `state.ts`'s `LEGAL_FORWARD_TRANSITIONS` (`app/app/services/scan/state.ts` lines 23-28) and say who/what decides each transition.
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: Walk me through what actually happens when you call an LLM API.**
A: Your prompt gets tokenized into integers, fed through a fixed stack of matrix multiplications (the frozen weights) in one forward pass, which produces a probability distribution over every token in the vocabulary. You sample one token from that distribution, append it to the sequence, and run the whole forward pass again — the model has no memory of the previous step except what's literally in the token sequence you resend. Loop until a stop token or a length cap.

```
  tokens ──► [forward pass] ──► distribution ──► sample ──► append ──► loop
```

**Q: Why doesn't MerchGrid: Catalog Audit use an LLM for any of its 10 checks?**
A: Because the checks are financial correctness assertions — "is this price non-negative," "is margin below threshold" — where the acceptance criteria (spec §21.3) require the *same catalog in, the same findings out*, every time. An LLM's core mechanism is a sampling step; even at temperature 0 you're trusting a black box's learned approximation over decimal.js exact arithmetic for something like margin percent. The product spec calls this out directly in §2.1 ("Deterministic: Findings come from explicit validation rules rather than an LLM") and in §27 ("Use deterministic checks rather than AI"). The one-line anchor: determinism was a requirement, not an oversight, so the mechanism you just learned (a stochastic sampling loop) was the wrong tool for this specific job.

**Q: If MerchGrid did add an LLM later, where would it go, and would it replace the check engine?**
A: No — it would sit upstream of it. Per spec §25.4, the future MerchGrid: Bulk AI flow has an LLM (or a merchant's CSV) propose a changeset, and the *existing* `runChecks(ALL_CHECKS, ctx)` engine (`app/packages/catalog-checks/src/run.ts`) preflights that proposal exactly the way it audits a live catalog today — CRITICAL findings block the write, WARNING findings require review. The deterministic engine becomes a verification layer *over* the LLM's output, not a replacement for it.

## See also

- `02-tokenization.md` — opens up the "tokens in" step this file treats as a black box.
- `03-sampling-parameters.md` — opens up the "sample one token" step.
- `07-heuristic-before-llm.md` — the fullest "in this codebase" grounding in this sub-section; walks the real, standalone heuristic engine (`ALL_CHECKS` + `runChecks`) that exists *instead of* an LLM today.
- `08-provider-abstraction.md` — the seam pattern a future LLM call would be wrapped in, taught against this repo's existing `AdminGraphqlClient` interface.
- `app/packages/catalog-checks/src/contract.ts` — the typed contract (`CatalogCheckContext`/`CatalogFinding`) a future LLM-proposed-changeset validator would target.
