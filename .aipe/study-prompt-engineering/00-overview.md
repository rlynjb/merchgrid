# Prompt engineering — study guide overview

Prompt engineering is the discipline of designing the contract between a program and a language model: what goes in the system prompt versus the user message, how the output is constrained so a parser doesn't break, how you know a change made things better instead of just different, and how you keep any of that stable when the underlying model gets upgraded out from under you. It's an engineering discipline with its own failure modes — schema drift, token budget blowouts, eval regressions — not a set of phrasing tricks.

**MerchGrid: Catalog Audit has none of this today.** Read the product spec and the code both agree: this is a deterministic app. Ten checks (`mg-001` through `mg-010` in `app/packages/catalog-checks/src/checks/`) run hand-written TypeScript logic — comparisons, groupings, threshold math on `decimal.js` values — over a normalized Shopify catalog snapshot. There is no LLM call anywhere in `app/app/`, `app/packages/catalog-checks/`, or `app/packages/catalog-core/`. No system prompt, no completion, no token in or out. `.aipe/project/context.md` states the constraint directly: *"Deterministic, not AI. The MVP is deterministic checks; do not add LLM/AI to the first app (that's the future 'MerchGrid: Bulk AI')."*

So this guide is honest about what it's for: almost every concept below is `not yet exercised` in this codebase, and the file for that concept says so plainly instead of inventing a prompt that doesn't exist. Where a concept is marked `not yet exercised`, the file still teaches the concept in full — it just can't point at your code for it, and it says that instead of faking it. **MerchGrid: Bulk AI**, the planned changeset-preflight product built on the same `catalog-core`/`catalog-checks` engine, is named in the product spec as the place these concepts activate for real: an LLM proposing catalog edits needs a system prompt, needs structured output so a proposed price change parses as a price change and not a paragraph, needs an eval set before anyone trusts its suggestions, needs injection defenses the moment merchant-supplied text (a product title, a variant name) flows into a prompt.

One piece of this codebase is a genuine, if partial, exception, and it's the reason this guide isn't just thirteen pages of "not yet exercised." Every finding a check produces carries a hand-written `title` and `explanation` string — plain-language copy a merchant reads to understand why their catalog got flagged (`app/packages/catalog-checks/src/checks/mg-003.ts:32`, for one: *"This is an adjustable screening threshold, not business advice, and may be intentional."*). That copy is deterministic — no model generated it, no model will ever see it — but it was engineered against the same pressures that make prompt and response design hard: say enough to be useful, don't overclaim certainty you don't have, hedge exactly where the finding could be a false positive and nowhere else. A few files below teach the transferable half of prompt engineering — output design, schema-first construction, single-purpose composition, eval-before-iteration — against that real copy and its surrounding code, because the *pattern* the concept teaches shows up here even though the *mechanism* (an LLM) doesn't.

```
Where prompt engineering would live — MerchGrid today vs Bulk AI

┌─ Shopify Admin (embedded UI) ───────────────────────────────┐
│  app.scans.$id.tsx renders finding.title / finding.explanation│
└──────────────────────────┬────────────────────────────────┘
                            │  Remix loader/action
┌─ Scan pipeline (app/app/services/scan/) ────────────────────┐
│  read → normalize → runChecks → persist                      │
└──────────────────────────┬────────────────────────────────┘
                            │  ctx.variants, ctx.settings
┌─ Engine (app/packages/catalog-checks) ──── TODAY ───────────┐
│  mg-001..mg-010: hand-written TS logic + hand-written copy    │
│  ★ the one real anchor: title/explanation strings ★           │
│  NO LLM CALL ANYWHERE IN THIS BAND                             │
└──────────────────────────┬────────────────────────────────┘
                            │  same engine, reused
┌─ MerchGrid: Bulk AI (planned, not built) ──── FUTURE ────────┐
│  system prompt + schema-constrained changeset proposals        │
│  ★ every concept in this guide activates here ★                │
└──────────────────────────────────────────────────────────────┘
```

## Reading order

Operational discipline first, then specific techniques — same order as the file names.

**Operational discipline (01–05)**
- `01-anatomy.md` — anatomy of a production prompt
- `02-structured-outputs.md` — structured outputs via tool calling and schemas
- `03-prompts-as-code.md` — prompts as code: versioning and observability
- `04-token-budgeting.md` — token budgeting and context window management
- `05-eval-driven-iteration.md` — eval-driven prompt iteration

**Specific techniques (06–13)**
- `06-single-purpose-chains.md` — single-purpose chains
- `07-output-mode-mismatch.md` — output mode mismatch
- `08-few-shot.md` — few-shot prompting
- `09-chain-of-thought.md` — chain-of-thought (CoT)
- `10-self-critique.md` — self-critique and self-consistency
- `11-meta-prompting.md` — meta-prompting
- `12-prompt-injection-defense.md` — prompt injection defenses (author side)
- `13-forbidden-patterns.md` — forbidden patterns and rotating formulas

## What each concept gets wrong when a codebase skips it

- **01 anatomy** — mixing constant instructions with per-call data in one blob is how prompts drift silently; not yet exercised here, but the check contract's field-per-concern shape (`checkId`, `severity`, `title`, `explanation`, `evidence`) is the deterministic cousin of "one job per section."
- **02 structured outputs** — "respond only in JSON" in prompt text breaks the moment the model adds a courteous markdown fence; not yet exercised for an LLM, but `CatalogFinding` + `findingFor()` show the schema-first, boundary-validated shape the pattern is named after.
- **03 prompts as code** — un-versioned prompt edits mean nobody can say which prompt produced which output in production; not yet exercised, since there's no prompt, but the checks themselves are versioned, reviewed source with a regression suite behind them — the discipline without the model.
- **04 token budgeting** — context stuffing until truncation happens silently at scale; not yet exercised — there is no context window in this app.
- **05 eval-driven iteration** — iterating "by vibes" instead of against a golden set means you can't tell improvement from noise; genuinely exercised here — `npm run eval` runs 17 independently-specified fixtures through the real `normalizeCatalog → runChecks` seam, which is eval-driven iteration for a deterministic engine.
- **06 single-purpose chains** — one multi-job chain means one failure takes down everything it was doing; genuinely exercised — 10 checks, each one job, composed by `runChecks(ALL_CHECKS, ctx)`.
- **07 output mode mismatch** — chain A emits JSON, chain B expects markdown, parser breaks; largely prevented here by TypeScript enforcing `CatalogFinding`'s shape at compile time, which is worth understanding as a contrast to how this bug happens with an LLM in the loop.
- **08 few-shot** — too many mediocre examples burn context for no accuracy gain; not yet exercised, no LLM to show examples to.
- **09 chain-of-thought** — forcing a reasoning trace out of a simple classifier wastes tokens for nothing; not yet exercised.
- **10 self-critique** — trusting a model's first answer on a high-stakes edit without a second pass; not yet exercised.
- **11 meta-prompting** — a prompt used to draft another prompt drifting into LLM-sounding prose instead of an engineering spec; not yet exercised.
- **12 prompt injection defense** — user-controlled text carrying instructions the model follows; not yet exercised for an LLM, and the closest deterministic sibling — merchant-supplied text flowing unescaped into the CSV export — has a real, checkable gap worth naming honestly.
- **13 forbidden patterns** — a generative chain converging on the same phrasing for every user until it reads like a template; not yet exercised, no generative chain exists.
