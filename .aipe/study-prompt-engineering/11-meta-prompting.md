# Meta-prompting

Subtitle: **meta-prompting / LLM-assisted prompt drafting** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where meta-prompting would apply

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  no prompts exist to draft — checks are hand-written logic,   │
│  reviewed by a human, with no LLM involved in writing them      │
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — drafting Bulk AI's first system prompt      │
│  is a plausible place to use an LLM to draft the initial pass,   │
│  then hand-edit it into an engineering spec                      │
└─────────────────────────────────────────────────────────────┘
```

Meta-prompting means using an LLM to write or improve a prompt for a *different* LLM call — the workflow is: a human states the goal, the LLM drafts a candidate prompt, a human reviews and edits it, and only the human-edited version enters the codebase. It saves real time on the first draft of a complex prompt, where staring at a blank page is the actual bottleneck. It does not save time on small tweaks or on a prompt already under high iteration pressure (mid-incident, mid-eval-regression-chase) — at that point you know exactly what needs to change and a meta-prompting round trip is slower than just changing it. The risk worth naming explicitly: a meta-prompted draft reads like LLM output — hedged, over-explained, generically polite — unless a human actively edits it back into something that reads like an engineering spec. Shipping the LLM's draft unedited is how you end up with a system prompt that sounds like customer support copy instead of a precise contract.

## Structure pass

**Axis: who authored the thing that governs behavior, and was it reviewed?** Trace it across a meta-prompted system and this codebase's actual authorship model.

```
axis: who wrote the artifact that governs behavior?

meta-prompting (the pattern):    LLM drafts → human edits → human
                                   commits — the artifact ends up
                                   human-authored even though an LLM
                                   assisted the first draft

Catalog Audit (today):            human wrote every check directly
                                   (mg-0NN.ts) — no LLM assisted or
                                   drafted any of it; this is the
                                   trivial case of "human-authored,
                                   reviewed" with the drafting step
                                   skipped entirely, not a different
                                   outcome
```

**Seam:** the seam meta-prompting cares about is between "drafted by an LLM" and "reviewed and owned by a human" — the artifact must cross that seam before it enters the codebase, or you've shipped LLM prose as an engineering spec. This codebase has no draft-then-edit step at all; every check went straight from a human's intent to human-written code, which is a degenerate case of the same seam (human-authored from the start) rather than a different one.

## How it works

### Move 1 — the mental model

You already know this from using an LLM to draft a first pass at a tricky email or a design doc outline — it gets you past the blank page faster than starting from nothing, but you don't send it unedited, because it doesn't know your actual context, your actual constraints, or your actual voice. Meta-prompting is that same workflow applied specifically to prompts: use the LLM to accelerate the first draft of a prompt, then edit it the way you'd edit any first draft — for precision, for removing hedged language, for making sure it states a contract instead of a suggestion.

```
Meta-prompting — the workflow

  human states the goal
        │
        ▼
  LLM drafts a candidate prompt
        │
        ▼
  human reviews: cut hedging, tighten the contract,
  verify it matches the actual system constraints
        │
        ▼
  human-edited version enters the codebase (see 03-prompts-as-code.md)
```

### Move 2 — not yet implemented in this codebase

There is no meta-prompting here because there is no prompt-drafting step of any kind — every check's logic and copy was written directly by a human, reviewed by a human, and committed. This is worth stating as the honest baseline rather than glossing over: meta-prompting isn't "missing" from this codebase the way token budgeting is missing (no context window exists to budget); it's simply that the one artifact this codebase has that plays a prompt-like role — each check's `title`/`explanation` copy (`app/packages/catalog-checks/src/checks/mg-0NN.ts`) — was never drafted by an LLM in the first place, so there was never a "human-edit-the-LLM-draft" step to perform.

If this copy *had* been meta-prompted, the risk this concept names would show up exactly where the copy currently reads most carefully hand-tuned — `mg-003.ts:32`'s "This is an adjustable screening threshold, not business advice, and may be intentional" is precise, specific, and clearly written by someone who understood the exact legal and product reason for the hedge. A meta-prompted first draft of that same sentence would plausibly have been hedgier and vaguer by default (something closer to "this might not be a real issue"), and it's the human edit — sharpening a generic hedge into a specific, justified one — that a meta-prompting workflow depends on someone actually doing.

### Move 2.5 — current state vs future state

```
Phase A (now)                            Phase B (Bulk AI, planned)
──────────────                           ──────────────────────────
no prompt-drafting step exists;           meta-prompting is a reasonable
every check was hand-written              way to get Bulk AI's first
directly, human to code, with              system prompt off the ground
no LLM involved at any point               fast — draft with an LLM,
                                           then edit until it reads like
                                           an engineering spec, not
                                           customer-support copy

what doesn't have to change: the standard this codebase's copy
already meets — specific, justified hedging, not generic vagueness
(see mg-003.ts:32) — is the bar a meta-prompted draft has to be
edited UP TO, not a bar meta-prompting gets you automatically.
```

### Move 3 — the principle

Meta-prompting is a drafting accelerant, not an authorship shortcut — the artifact that ships still needs a human who understands the actual constraints to have edited it, or you've just moved the "who really wrote this" question one level removed without actually answering it. The tell that a team skipped the edit step is prose that reads like it's hedging out of habit instead of hedging for a specific, statable reason — which is precisely the difference between this codebase's actual copy and what an unedited LLM draft of the same copy would likely read like.

## Primary diagram

```
Meta-prompting — the authorship chain, both cases

  meta-prompted (Bulk AI, planned)         hand-written (Catalog Audit, today)
  ┌────────────────────────────┐          ┌────────────────────────────┐
  │ LLM drafts first pass          │          │ (no draft step — human      │
  ├────────────────────────────┤          │  writes directly)             │
  │ human edits: cut hedging,       │          ├────────────────────────────┤
  │ tighten contract                 │◄────────►│ human writes specific,       │
  ├────────────────────────────┤  same bar│ justified copy the first time │
  │ human-edited version ships      │          │ (mg-003.ts:32)                │
  └────────────────────────────┘          └────────────────────────────┘
```

## Elaborate

Meta-prompting shows up in prompt-tooling products directly — aipe-shaped systems (markdown templates as the source of truth, slash commands composing them) often lean on an LLM to draft a new template's first pass from a short description, precisely because the templates themselves are numerous enough that hand-drafting every one from scratch is the bottleneck. The failure mode to watch for in any such system is exactly the one this file names: templates that read like they were generated and never edited, distinguishable by generic hedging and over-explanation where a human editor would have cut straight to the specific constraint.

## Project exercises

### Exercise: use meta-prompting for Bulk AI's first system prompt, then audit the edit

- **What to build:** draft Bulk AI's changeset-proposer system prompt with an LLM's assistance, then do a specific audit pass on the draft: find every hedge ("might," "could potentially," "in some cases") and either sharpen it to a specific, justified reason or cut it — using `mg-003.ts:32`'s hedge as the bar to edit up to.
- **Why it earns its place:** this codebase's existing copy is genuinely good prompt-adjacent writing, and it's worth using as the explicit editing target rather than shipping a meta-prompted draft unedited.
- **Files to touch:** the new system prompt file itself, wherever Bulk AI's prompts live (see `03-prompts-as-code.md`).
- **Done when:** every hedge in the shipped prompt has a specific, statable reason behind it, the same way every hedge in the existing check copy does.
- **Estimated effort:** a couple hours for the draft, a couple more for the edit pass — the edit is the part that actually takes judgment.

## Interview defense

**Q: What's the actual risk of meta-prompting, concretely?**
A: Shipping the LLM's draft without a human edit pass, which tends to produce prose that hedges generically instead of specifically and reads like customer support copy instead of an engineering contract. The fix isn't avoiding meta-prompting — it's treating the draft as a first draft, always.

```
the answer, sketched
┌─ LLM draft, unedited ──────┐        ┌─ LLM draft, human-edited ──┐
│ generic hedging               │        │ specific, justified hedging   │
│ reads like generated prose    │        │ reads like an engineering       │
│                                 │        │ spec                             │
└──────────────────────────┘        └──────────────────────────┘
```

**Q: This codebase has no meta-prompting. What's the honest reason, and what standard would a meta-prompted draft need to meet here?**
A: There's no prompt to draft — every check's copy was hand-written directly, with no LLM involved at any point, so there was never an edit-the-draft step to perform. The standard that copy already meets — `mg-003.ts:32`'s specific, legally-aware hedge, for instance — is exactly the bar a future meta-prompted draft in Bulk AI would need to be edited up to.

## See also

- `03-prompts-as-code.md` — where the meta-prompted-then-edited version gets versioned once it exists
- `01-anatomy.md` — the section structure a meta-prompted draft still needs to respect
