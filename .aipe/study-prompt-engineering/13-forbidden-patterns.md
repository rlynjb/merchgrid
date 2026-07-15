# Forbidden patterns and rotating formulas

Subtitle: **anti-repetition prompting / forbidden-phrase lists** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this concept would apply

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  no repetition risk exists — the same check always produces   │
│  the exact same explanation string, on purpose                │
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — only if Bulk AI ever GENERATES novel free-  │
│  text (a changeset rationale written fresh per proposal) run     │
│  repeatedly for the same merchant does phrasing convergence       │
│  become a real risk                                                │
└─────────────────────────────────────────────────────────────┘
```

LLMs converge on phrasings — run the same generative chain for the same user repeatedly (a caption generator, a daily summary, a recurring reminder message) and, without intervention, you'll notice every output opening the same way, using the same three transition phrases, landing on the same closing line. The fix is blunt and effective: explicitly forbid the openings and transitions the model keeps reaching for, and enumerate a rotation of acceptable alternatives, refreshed periodically as the model finds new favorites to overuse. This matters specifically for generative chains a single user sees many times — it does not matter for one-shot classifiers or structured outputs, where there's no repeated free text for a pattern to become noticeable in.

## Structure pass

**Axis: does the same input produce varying or identical output across repeated calls?** Trace it across a generative chain and this codebase's checks.

```
axis: same input, run twice — same or different output?

generative chain (the risk):    same input, TWO SEPARATE model calls
                                  → plausibly different phrasing each
                                  time, converging toward the model's
                                  favorite formulas across MANY calls
                                  for the same user

Catalog Audit checks (today):    same input, run twice → BYTE-IDENTICAL
                                  output, always — mg003.run(ctx) is a
                                  pure function; the "repetition" this
                                  concept warns about is impossible
                                  because there's no variation to
                                  converge FROM
```

**Seam:** the seam this concept lives at is "the same underlying message, phrased differently each time it's generated" — that seam only exists where generation happens per-call. This codebase's checks produce their explanation string once, as a fixed constant in source code (see `01-anatomy.md`), so there is no per-call phrasing variation for a merchant to ever notice repeating.

## How it works

### Move 1 — the mental model

You already know the failure mode from any templated email system that wasn't actually templated carefully — every "your order shipped" notification a customer receives sounding subtly the same becomes noticeable, even comforting, because it's consistent. Now imagine a system meant to sound fresh each time — a caption generator, a personalized daily summary — converging on the same "Exciting news!" opening every single time. Consistency reads as intentional design in the first case and as a tell in the second, and the difference is entirely about whether the user expects variation.

```
Forbidden patterns — the mechanism

  system prompt: "Never open with 'Exciting news!' or 'We're thrilled
                  to announce.' Rotate among these openings instead:
                  [list of 5-10 alternatives]. Vary sentence structure
                  from the previous N outputs shown below."
        │
        ▼
  generation ──► checked against the forbidden list ──► regenerate
                  if it matches, or accept if it doesn't
```

### Move 2 — not yet implemented in this codebase; here's precisely why it can't apply yet

Every check's `title` and `explanation` is a fixed string (or, for a handful of checks like `mg-003`, a template literal with exactly one interpolated number — the merchant's configured threshold) written once in source and returned identically every time that check fires:

```ts
// app/packages/catalog-checks/src/checks/mg-005.ts:20-27 (excerpted)
findings.push(
  findingFor(v, ctx, {
    checkId: CHECK_ID,
    severity: "WARNING",
    title: "Duplicate SKU",
    explanation:
      "This SKU is also assigned to other variants. Duplicate SKUs can create confusion in inventory, fulfillment, reporting, or external integrations. This may be intentional, for example bundles or shared inventory.",
    evidence: { sku: v.sku, normalizedSku, duplicateCount: group.length },
  }),
);
```

This string is identical every single time `mg-005` fires, for every merchant, forever, until a human edits the source. That's not a forbidden-pattern problem waiting to happen — it's the opposite situation entirely: consistency here is the correct, intended behavior, because a merchant needs to trust that the same finding always means the same thing, the same way an error code always maps to the same error. The concept this file names is specifically about *generative* variation converging unintentionally; there is no generative variation here to converge, so there's nothing for a forbidden-pattern list to fix.

### Move 2.5 — current state vs future state

```
Phase A (now)                            Phase B (Bulk AI, planned)
──────────────                           ──────────────────────────
every check's copy is a fixed             IF Bulk AI ever generates
constant — identical output every         novel free text per proposal
time, by design, for every merchant       (a changeset rationale written
                                           fresh, not from a fixed
                                           template) AND a merchant sees
                                           many such proposals over time,
                                           forbidden-pattern lists become
                                           relevant — otherwise every
                                           rationale starts sounding
                                           the same

what doesn't have to change: fixed, reviewed copy for anything that
functions like a status code (a finding's title/explanation) should
STAY fixed even after Bulk AI ships — this concept applies only to
genuinely generative, per-instance free text, not to classification
labels that happen to be phrased as sentences.
```

### Move 3 — the principle

Forbidden-pattern lists solve a problem that only exists where generation is genuinely open-ended and repeated for the same audience — they're a targeted fix for LLM convergence, not a general hygiene practice every generative system needs. The instructive contrast this codebase provides is that identical output isn't always the bug this concept assumes it is: for a classification label, sameness is the feature, and the entire concept simply doesn't apply.

## Primary diagram

```
Forbidden patterns — where the risk exists, and where it structurally can't

  generative chain, repeated per user      Catalog Audit check (today)
  ┌────────────────────────────┐          ┌────────────────────────────┐
  │ same input, called AGAIN         │          │ same input, called AGAIN     │
  │ → model may phrase differently,   │          │ → byte-identical output,      │
  │ converging on favorite formulas    │          │ always (pure function)         │
  ├────────────────────────────┤          ├────────────────────────────┤
  │ fix: forbidden-openings list +     │          │ fix needed: NONE — sameness    │
  │ rotation                             │          │ is correct, not a bug           │
  └────────────────────────────┘          └────────────────────────────┘
```

## Elaborate

This pattern shows up most in consumer-facing generative features run repeatedly for the same person — a daily journal-entry prompt, a recurring social-media caption suggestion, a personalized digest. The fix compounds over time: forbidden-phrase lists need periodic refreshing as the model finds new favorites once the old ones are banned, which is itself a signal that this is a patch on top of an inherently statistical process, not a permanent solution — the underlying convergence tendency doesn't go away, it just gets pushed to phrasings not yet on the list.

## Project exercises

### Exercise: decide, in advance, whether Bulk AI needs this at all

- **What to build:** before Bulk AI ships any generative free text (a changeset rationale, say), decide explicitly whether that text is closer to a classification label (should stay fixed/templated, like this codebase's check copy) or genuinely generative prose a merchant sees repeatedly over time (a real forbidden-pattern candidate) — and default toward the templated option unless there's a real product reason the text needs to vary per instance.
- **Why it earns its place:** this codebase's ten checks are ten pieces of evidence that "sameness is a bug" is often the wrong default assumption; the right first move is asking whether Bulk AI's text actually needs to be generative at all before reaching for anti-repetition tooling.
- **Files to touch:** none yet — this is a design decision to make before writing Bulk AI's first generative prompt.
- **Done when:** every piece of Bulk AI-generated text has an explicit answer to "does this need to vary per instance, and why" on record.
- **Estimated effort:** an hour of design review; the alternative (skipping this and discovering the convergence problem in production) costs much more.

## Interview defense

**Q: When does a forbidden-pattern list actually matter?**
A: Only for generative chains producing free text a single user sees many times over — a caption generator, a recurring summary. It doesn't matter for one-shot classifiers or structured outputs, because there's no repeated instance for a pattern to become noticeable across.

```
the answer, sketched
┌─ generative, repeated per user ──┐        ┌─ classification / one-shot ──┐
│ convergence is a real risk           │        │ sameness is correct, not a     │
│ → forbidden-pattern list helps        │        │ bug → nothing to fix             │
└──────────────────────────────────┘        └──────────────────────────────┘
```

**Q: This codebase has ten checks producing identical output every time. Isn't that exactly the problem this concept warns about?**
A: No — and stating precisely why is the stronger answer than a reflexive "not applicable." The concept warns about *unintentional* convergence in *generative* text. This codebase's identical output is *intentional* and *deterministic*: `mg-005.ts:23-24`'s explanation string is a fixed constant, not a model's statistical tendency, and identical output here is the correct behavior a merchant depends on — the same way an HTTP 404 always means the same thing.

## See also

- `01-anatomy.md` — where fixed, policy-owned copy like this lives in a prompt's structure
- `03-prompts-as-code.md` — versioning the fixed copy so a deliberate change is reviewable
