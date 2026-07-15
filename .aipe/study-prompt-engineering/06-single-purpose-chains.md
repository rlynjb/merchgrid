# Single-purpose chains

Subtitle: **pipeline composition / single-responsibility chains** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where single-purpose composition lives

┌─ app/packages/catalog-checks/src/run.ts ── TODAY ───────────┐
│  ★ THIS CONCEPT, deterministic form ★                         │
│  ALL_CHECKS: 10 single-job checks, composed by runChecks()     │
└──────────────────────────┬───────────────────────────────┘
                            │  same composition shape, LLM added
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  a changeset pipeline: classify → retrieve context → propose  │
│  → validate, as separate chains, not one multi-job prompt      │
└─────────────────────────────────────────────────────────────┘
```

A single-purpose chain does exactly one job — classify, extract, summarize, route — and gets composed with other single-purpose chains into a longer pipeline, instead of one prompt trying to do all of it in one call. I've shipped multi-step LLM chains built this way (a classifier routing to different downstream handlers is the textbook shape), and the reason it survives production is boring but real: when something fails, you know exactly which chain failed, you can route cheap requests to a small model and expensive ones to a large model per-chain instead of paying frontier-model prices for a classification a smaller model handles fine, and you can iterate on one chain's prompt without touching the eval set for a different one.

MerchGrid: Catalog Audit has no chains — there's no LLM here at all — but it has the *same composition shape*, at the granularity of ten deterministic functions instead of ten prompts, and it's worth studying directly because the architectural discipline (one job per unit, composed by a thin orchestrator) is identical.

## Structure pass

**Axis: what happens to the rest of the pipeline when one unit fails?** Trace failure containment across a multi-purpose prompt, a single-purpose chain pipeline, and this codebase's check composition.

```
axis: does one unit's failure take down the others?

multi-purpose prompt:     one call does classify+extract+respond —
(anti-pattern)             any part failing (bad classification,
                            malformed extraction) corrupts the
                            whole response; you can't tell which
                            part broke from the outside

single-purpose chains:     classifier chain, extractor chain, and
(the pattern)               responder chain are separate calls — one
                            failing is isolated, attributable, and
                            independently retryable

Catalog Audit (today):     mg001..mg010 are separate functions; one
                            check throwing doesn't corrupt another's
                            findings — runChecks() is a flatMap, not
                            a fold, so units don't share failure state
```

**Seam:** the seam is the orchestrator boundary — whatever composes the single-purpose units needs to stay thin (routing and combining results), because the moment it starts doing its own "job," you've smuggled multi-purpose behavior back into what looked like a clean pipeline. `runChecks()` (`app/packages/catalog-checks/src/run.ts:26-28`) sits exactly on this seam: it does nothing but call each check and flatten the results.

## How it works

### Move 1 — the mental model

You already know this from the Unix-pipe instinct — `grep | sort | uniq -c` instead of one program that greps, sorts, and counts internally. Each piece does one thing, and you compose them with a thin connector. A single-purpose chain is the same idea applied to LLM calls: one call classifies intent, a separate call (maybe a different, cheaper model) extracts structured fields, a separate call generates the response — composed by ordinary code, not by asking one prompt to juggle all three jobs at once.

```
Single-purpose chains — the composition shape

  input ──► [ chain A: one job ] ──► [ chain B: one job ] ──► output
                    │                         │
              own eval set                own eval set
              own model choice            own model choice
              own failure mode            own failure mode
```

### Move 2 — the same shape, in this codebase

**Ten single-job units.** Every check in `app/packages/catalog-checks/src/checks/` does exactly one thing — `mg001` only checks for zero/negative active prices, `mg003` only checks margin against a threshold, `mg008` only checks for price outliers within a product. None of them reach into another check's logic or share mutable state:

```ts
// app/packages/catalog-checks/src/run.ts:1-28
import { mg001 } from "./checks/mg-001.js";
// ...
export const ALL_CHECKS: CatalogCheck[] = [
  mg001, mg002, mg003, mg004, mg005, mg006, mg007, mg008, mg009, mg010,
];

export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

`runChecks` is the thin orchestrator — it does not decide *what* to flag, it just calls each check's `run(ctx)` and flattens the arrays together. This is the load-bearing discipline: the orchestrator has no job of its own beyond composition. Compare this to the anti-pattern it avoids — a single `runAllChecks(ctx)` function with ten inline `if` blocks sharing one growing `findings` array and one mutable set of "already flagged" state, where a bug in the third block could plausibly corrupt what the ninth block sees. Nothing here shares state across checks; `mg003.ts:20-21` even documents an explicit boundary decision to *avoid* overlapping responsibility with `mg002` rather than letting one check silently absorb another's job:

```ts
// app/packages/catalog-checks/src/checks/mg-003.ts:20-21
// Below-cost (negative margin) variants are MG-002's job; skip here to avoid double-flagging.
if (lt(price, unitCost)) continue;
```

That's the single-purpose discipline stated explicitly in a comment: mg-003 could technically also catch below-cost variants, and deliberately doesn't, because that's mg-002's job.

**Debugging benefit, concretely.** If `mg-008` (the outlier check) has a bug, `Finding.checkId = "mg-008"` on every affected row (`Finding` model, `app/prisma/schema.prisma`) tells you exactly which unit produced the bad output — you don't have to guess which of ten checks misbehaved, the same way a chain-based LLM pipeline logs which chain produced a bad classification instead of one opaque end-to-end call.

### Move 3 — the principle

The value of single-purpose composition isn't code cleanliness for its own sake — it's that failure, cost, and iteration all become attributable to a specific unit instead of smeared across an undifferentiated blob. That's true whether the units are LLM calls with separate model choices or pure functions with separate `checkId`s; the orchestrator's only job is to stay thin enough that it can't become the eleventh unit with a bug of its own.

## Primary diagram

```
Single-purpose composition — both systems, one shape

  LLM chain pipeline (the pattern)         Catalog Audit (today)
  ┌──────────────────────────┐             ┌──────────────────────────┐
  │ classifier chain (small    │             │ mg001..mg010, each one    │
  │ model)                      │◄──────────►│ job, own checkId           │
  ├──────────────────────────┤   same       ├──────────────────────────┤
  │ extractor chain (own       │  shape      │ ALL_CHECKS array           │
  │ eval, own failure mode)     │             │ (run.ts:13-24)              │
  ├──────────────────────────┤             ├──────────────────────────┤
  │ thin orchestrator: routes,  │◄──────────►│ runChecks(): flatMap,       │
  │ composes, no job of its own │             │ no job of its own            │
  │                              │             │ (run.ts:26-28)               │
  └──────────────────────────┘             └──────────────────────────┘
```

## Elaborate

This pattern is sometimes called "compound AI systems" in more recent framing (the Berkeley "AI Systems" writing on this is worth reading) — the point being that most production LLM value doesn't come from one giant prompt, it comes from composing several small, well-scoped calls the way you'd compose small functions in ordinary software. The failure mode of the multi-purpose alternative is specifically brittleness under change: touch the prompt to fix the classifier's edge case, and you risk regressing the extractor's behavior too, because they were never actually separable once merged into one call.

## Project exercises

### Exercise: keep Bulk AI's pipeline single-purpose from the start

- **What to build:** when Bulk AI's changeset pipeline is designed, resist collapsing "read the finding," "propose a fix," and "validate the fix against the merchant's settings" into one prompt — mirror `ALL_CHECKS`/`runChecks`'s shape: separate units, a thin composing function, one `checkId`-equivalent per unit for traceability.
- **Why it earns its place:** the codebase already has a working example of this discipline at the deterministic layer; the risk is treating Bulk AI's first prompt as a blank slate and reaching for one big prompt because it's faster to write initially.
- **Files to touch:** new — a `run.ts`-shaped orchestrator in whatever package Bulk AI's engine lives in.
- **Done when:** a failure in the "propose a fix" step doesn't corrupt or block the "validate" step's ability to run against a different proposal, and each step's failures are independently loggable.
- **Estimated effort:** a design decision more than an implementation cost — the discipline is free if adopted from the first prompt.

## Interview defense

**Q: Why not just write one comprehensive prompt that handles the whole task?**
A: Because "comprehensive" and "debuggable" trade off directly — one prompt doing three jobs means one failure surface with no way to attribute a bad output to a specific sub-task, no way to route the cheap sub-task to a cheap model, and no way to iterate on one part's eval without re-running the whole thing's eval too.

```
the answer, sketched
┌─ one multi-job prompt ──┐        ┌─ N single-job chains ──┐
│ one failure surface,      │        │ N attributable failure   │
│ one model cost for          │        │ surfaces, per-chain model  │
│ everything                  │        │ choice, per-chain eval      │
└──────────────────────────┘        └──────────────────────────┘
```

**Q: This codebase has no chains — what's the load-bearing part that still applies?**
A: The thin-orchestrator discipline. `runChecks()` composes ten single-job units and does nothing else — no shared mutable state, no cross-check logic. `mg-003.ts:20-21`'s explicit "this is mg-002's job, skip here" comment is the single clearest piece of evidence that responsibility boundaries were a deliberate design choice, not an accident of how the code happened to get organized.

## See also

- `07-output-mode-mismatch.md` — the bug this composition style is prone to when units disagree on shape
- `05-eval-driven-iteration.md` — why per-unit evals are possible only because the units are single-purpose
