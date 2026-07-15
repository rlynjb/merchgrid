# Anatomy of a production prompt

Subtitle: **prompt anatomy / system-user-context decomposition** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where prompt anatomy would live

┌─ Shopify Admin (embedded UI) ────────────────────────────────┐
│  merchant reads finding.title / finding.explanation            │
└──────────────────────────┬─────────────────────────────────┘
                            │
┌─ Engine (app/packages/catalog-checks) ── TODAY, no prompt ───┐
│  mg-0NN.ts: if/filter logic → hand-written title + explanation │
│  ★ closest cousin: CatalogFinding's field-per-concern shape ★  │
└──────────────────────────┬─────────────────────────────────┘
                            │  same shape, reused
┌─ MerchGrid: Bulk AI (planned) ── FUTURE, real prompt ─────────┐
│  ★ THIS CONCEPT ★ — system prompt / context / few-shot / user  │
└────────────────────────────────────────────────────────────┘
```

Every production prompt that survives more than one iteration ends up decomposed into the same four sections: a system prompt (the constant instructions — role, constraints, output contract), context injection (the per-call data the model needs — retrieved docs, a user's record, in MerchGrid's case a catalog snapshot), few-shot examples (the calibration), and the user message (the actual ask). The reason this decomposition matters isn't aesthetic. It's that each section changes on a different clock. The system prompt changes when your product requirements change. The context changes every single call. Mix them in one string and you can't tell, six months later, which part of the prompt caused a regression — you're debugging one blob instead of four independently-versionable pieces.

MerchGrid: Catalog Audit has no prompt to decompose — there's no LLM call anywhere in this repo. This file is honest about that. What it can do is show you the deterministic shape that plays the same structural role, so the decomposition instinct isn't foreign when Bulk AI needs it for real.

## Structure pass

**Axis: who owns which part, and on what clock.** Trace "what changes this value, and how often" across the four prompt sections a system prompt eventually needs, and across the one deterministic analog this codebase has today.

```
One axis — "what changes this, and how often" — two systems

                    system prompt   context      few-shot     user msg
Bulk AI (planned):  product spec    per-call     calibration  end user
                    changes         catalog       set changes  types it
                    (rare)          data          (occasional) (every call)
                                    (every call)

                    checkId/severity/title   evidence
Catalog Audit       (changes when a          (per-variant,
(today):            check's spec changes —    every scan run)
                    rare, reviewed in a PR)
```

**Seam:** the boundary that matters is between "changes with the product" and "changes with the call." In Bulk AI, that seam will be the line between the system prompt (product-owned) and everything injected into the user/context turn (call-owned) — mixing them across that seam is exactly how prompts drift (Move 2 below). In this codebase today, the same seam exists one level down: `checkId`, `severity`, and `title` are check-owned constants (`app/packages/catalog-checks/src/checks/mg-001.ts:8-19`); `evidence` is call-owned, computed fresh per variant per scan (`mg-001.ts:22`). The contract (`app/packages/catalog-checks/src/contract.ts:11-25`) keeps them as separate named fields instead of one interpolated string — which is the decomposition discipline, minus the LLM.

## How it works

### Move 1 — the mental model

You already know this shape from writing a template literal with some parts hard-coded and some parts interpolated — the hard-coded parts are policy, the interpolated parts are data. A production prompt is the same idea scaled up and given names: **system** (policy, constant), **context** (data, per-call), **few-shot** (calibration, semi-constant), **user** (the ask, per-call). The underlying strategy: separate what your product owns from what the caller provides, so each can change independently without the other breaking.

```
Prompt anatomy — the four sections and their clock

┌─ system prompt ──────────────┐  changes: rarely, with product spec
│  role, constraints, contract  │
├─ context injection ──────────┤  changes: every call
│  retrieved docs / user record │
├─ few-shot examples ──────────┤  changes: occasionally, with calibration
│  n worked examples            │
├─ user message ────────────────┤  changes: every call
│  the actual request           │
└───────────────────────────────┘
```

### Move 2 — not yet implemented in this codebase

There is no system prompt, no context injection, no few-shot block, and no user message anywhere in `app/`. Grep confirms it: no call to an LLM SDK exists in `app/app/`, `app/packages/catalog-core/`, or `app/packages/catalog-checks/`. The mixing failure mode this concept warns about — burying per-call data inside the same string as constant instructions, so a change to one silently perturbs the other — cannot happen here because there is no string being built at all.

**The deterministic cousin, precisely stated.** `CatalogFinding` (`app/packages/catalog-checks/src/contract.ts:11-25`) is a flat object with named fields: `checkId`, `severity`, `title`, `explanation` are set once per check definition (policy-owned, changes when the check's spec changes); `evidence`, `productId`, `variantId` are computed per variant, every run (call-owned). `findingFor()` (`app/packages/catalog-checks/src/checks/_helpers.ts:4-30`) is the single place that assembles both halves into one object:

```ts
// app/packages/catalog-checks/src/checks/_helpers.ts:4-14
export function findingFor(
  v: NormalizedVariant,
  ctx: CatalogCheckContext,
  f: {
    checkId: string;      // policy-owned: which check produced this
    severity: FindingSeverity;  // policy-owned
    title: string;        // policy-owned: constant per check
    explanation: string;  // policy-owned: constant per check
    evidence: Record<string, string | number | boolean | null>; // call-owned: per-variant data
  },
): CatalogFinding {
```

Notice what this buys, structurally: a reader can change `mg-003.ts`'s explanation string (policy) without touching how `evidence` gets computed (call data), and vice versa, because they're separate named parameters, never concatenated into one blob. That's the anatomy discipline's actual payoff — not the specific four names, but never letting policy and per-call data merge into a single undifferentiated string.

### Move 2.5 — current state vs future state

```
Phase A (now)                          Phase B (Bulk AI, planned)
────────────────                       ──────────────────────────
no prompt exists                       system prompt: constraints on
CatalogFinding fields play the         what changesets are legal
policy/data split structurally         context: current catalog state,
(contract.ts:11-25)                    the specific variant in question
                                        few-shot: examples of accepted
                                        vs rejected changeset proposals
                                        user: "here's the finding, propose
                                        a fix"

what doesn't have to change:
the check → finding → evidence shape stays the contract; Bulk AI's
prompt would be BUILT ON TOP of the same normalized data this engine
already produces, not a replacement for it.
```

### Move 3 — the principle

The reason this decomposition survives contact with production isn't that four named sections are inherently correct — it's that whatever changes on different clocks needs to live in different places, or you lose the ability to reason about either half alone. That's true of prompts, and it's just as true of a plain object with `checkId` and `evidence` as separate fields instead of one interpolated sentence.

## Primary diagram

```
Anatomy — the full shape, both systems side by side

  Bulk AI (planned prompt)         Catalog Audit (deterministic today)
  ┌──────────────────────┐         ┌──────────────────────────┐
  │ system prompt         │         │ checkId, severity,        │
  │  (policy, rare)       │◄───────►│ title, explanation         │
  ├──────────────────────┤  same    │  (policy, rare — set once  │
  │ context injection     │  split  │  per check definition)     │
  │  (data, every call)   │◄───────►├──────────────────────────┤
  ├──────────────────────┤         │ evidence, productId,       │
  │ few-shot examples     │         │ variantId                  │
  │  (calibration)        │         │  (call-owned, per variant,│
  ├──────────────────────┤         │  every scan run)            │
  │ user message          │         └──────────────────────────┘
  │  (the ask, every call)│         assembled once, by
  └──────────────────────┘         findingFor() (_helpers.ts:4-30)
```

## Elaborate

The four-section decomposition traces back to how chat-completion APIs structure a conversation (system / user / assistant roles), and it hardened into a discipline once teams started shipping prompts that needed to survive edits by people who didn't write the original. Anthropic's and OpenAI's prompt-engineering guides both converge on the same instinct: put what's constant at the top, keep it separate from what's supplied per call. The same instinct is why you don't hardcode a user's name into a SQL query string — you parameterize it. Prompt anatomy is that same discipline, applied to natural language instead of SQL.

## Project exercises

### Exercise: build the system prompt for Bulk AI's changeset proposer

- **What to build:** a versioned system prompt (see `03-prompts-as-code.md`) that states the constraint MerchGrid's spec already implies — Bulk AI proposes changesets, it never applies them directly (mirrors the existing read-only constraint in `.aipe/project/context.md`).
- **Why it earns its place:** this is the first prompt this codebase will ever have; getting the system/context split right from the first line avoids the drift this file warns about.
- **Files to touch:** new — likely `app/packages/catalog-ai/src/prompts/changeset-proposer.md` if Bulk AI follows the packages-as-engine pattern already established by `catalog-checks`.
- **Done when:** the system prompt and the per-call context (the specific finding + variant) are two separate, independently-editable pieces, not one interpolated string.
- **Estimated effort:** half a day, mostly design — the prompt text itself is short.

## Interview defense

**Q: Why does it matter which section a piece of instruction text lives in?**
A: Because sections change on different clocks. Putting a per-call fact in the system prompt means you're now shipping a new system prompt (a reviewed, deployed change) every time the fact changes — instead of just passing new context. In MerchGrid's actual code, the same principle keeps `evidence` (computed fresh every run) out of the `title`/`explanation` strings (reviewed once, in a PR) — see `contract.ts:11-25`.

```
the answer, sketched
┌─ policy (rare change) ──┐   ┌─ data (every call) ──┐
│ title, explanation       │   │ evidence               │
│  (or: system prompt)     │   │  (or: context injection)│
└──────────────────────────┘   └────────────────────────┘
    mix these → you can't tell which one caused the regression
```

**Q: This app has no prompts. What's the honest answer if asked "where would this apply here?"**
A: Name Bulk AI directly, and name the one place the split already exists structurally: `CatalogFinding`'s policy fields versus its per-variant fields. Don't invent a prompt that isn't in the code.

## See also

- `02-structured-outputs.md` — the schema half of the same contract
- `03-prompts-as-code.md` — how the policy half gets versioned once it's a real prompt
