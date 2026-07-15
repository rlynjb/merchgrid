# Prompts as code: versioning and observability

Subtitle: **prompt versioning / prompt observability** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where prompt-as-code would live

┌─ git history (version control) ────────────────────────────┐
│  ★ checks are reviewed, versioned source ★                  │
│  app/packages/catalog-checks/src/checks/mg-0NN.ts             │
└──────────────────────────┬───────────────────────────────┘
                            │  same discipline, LLM added
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — prompt files versioned like code,       │
│  paired with the model version that was tested against them  │
└─────────────────────────────────────────────────────────────┘
```

The discipline "prompts as code" means: a prompt lives in a file, that file is checked into version control, changes to it go through the same review a code change would, and — critically — you can answer "which prompt version produced this specific production output" after the fact, because you logged it. Skip any part of this and you get the failure I've watched happen more than once: a prompt gets tweaked directly in a config UI on a Friday afternoon, output quality shifts, and by Monday nobody can say what changed or revert it cleanly, because the "before" version was never saved anywhere durable.

MerchGrid: Catalog Audit has no prompt file to version — there's no LLM call in this repo. But the sibling half of this discipline, versioning the thing that determines behavior and reviewing changes to it, is fully exercised here, just for deterministic logic instead of a prompt string.

## Structure pass

**Axis: is the thing that determines output reviewed, versioned, and revertable?** Trace it across a prompt-as-code system and this codebase.

```
axis: can you answer "what determined this output, and when did it change"

Bulk AI (planned):    prompt file in git → PR review → merge →
                       (needed) log which prompt version + model
                       version produced each production output

Catalog Audit (today): check logic + copy in git → PR review → merge →
                       checkId on every Finding row answers "what
                       determined this" (Finding.checkId, schema.prisma)
                       — but there's no per-check VERSION field, only
                       git history, because behavior can't silently
                       drift the way a prompt can (see Move 2)
```

**Seam:** the seam in a prompt-as-code system is the deploy boundary — a prompt change ships, and from that moment every new output used the new version, but old logged outputs need to say which version made them. In this codebase, the closest seam is the same one: `Finding.checkId` (`app/prisma/schema.prisma`) records which check fired, letting you trace any stored finding back to the exact check logic, in whatever git revision was deployed at `detectedAt`.

## How it works

### Move 1 — the mental model

You already know this from any feature flag or config value that lives in a database versus one that lives in a file: the file-based one goes through code review, has a diff, and can be reverted with `git revert`. The database-based one usually doesn't. Prompts-as-code means treating a prompt the way you'd treat the file-based config — not because prompts are code syntactically, but because the *review and revert* guarantees you want for a prompt are the same ones you already have for code, and you get them for free by putting the prompt in a file.

```
Prompts as code — the guarantee chain

  prompt in a file ──► git diff on every change ──► PR review
        │                                                │
        │                                                ▼
        │                                          merge = deploy
        ▼                                                │
  (logged) which prompt version                          ▼
  produced this output ◄─────────────── production call made
```

### Move 2 — the deterministic version, in this codebase

**Versioned, reviewed source.** Every check's copy — its `title` and `explanation` — lives inline in a TypeScript file, in git, and any change to it goes through the same PR process as a logic change. There's no separate CMS or admin panel where a merchant-facing string could be edited outside of code review. Look at the actual diff shape a copy change would take, using the real string at `app/packages/catalog-checks/src/checks/mg-003.ts:32`:

```ts
// app/packages/catalog-checks/src/checks/mg-003.ts:26-40
if (m < ctx.settings.minimumMarginPercent) {
  findings.push(
    findingFor(v, ctx, {
      checkId: CHECK_ID,
      severity: "WARNING",
      title: "Margin is below minimum threshold",
      explanation: `This variant's estimated gross margin is below your selected minimum of ${ctx.settings.minimumMarginPercent}%. This is an adjustable screening threshold, not business advice, and may be intentional.`,
      evidence: { price, unitCost, marginPercent: m, threshold: ctx.settings.minimumMarginPercent },
    }),
  );
}
```

A copy edit here — softening "not business advice" or changing the threshold framing — is a one-line diff, reviewable in a normal PR, exactly like a prompt-as-code change would be. That's the versioning half of the discipline, fully present.

**Observability — where the analogy stops cleanly.** Prompt observability answers "which *version* of the prompt produced this specific output," because a prompt is nondeterministic — the same prompt on the same model can produce different completions, and the same prompt on an *upgraded* model can produce a different completion for the same input. Neither is true here. `mg003.run(ctx)` is a pure function: the same `ctx` always produces the same finding, forever, regardless of when it runs (`app/packages/catalog-checks/src/checks/mg-003.ts:11-45`; the engine-purity constraint in `.aipe/project/context.md` — "Engine purity: `app/packages/**` must not import Shopify/Prisma/Remix/fs/network" — is what keeps it that way). So `Finding.checkId` on every stored row answers "what determined this" without needing a version-pinning mechanism at all: there's only ever one behavior per `checkId`, the one currently in `main`. The moment Bulk AI adds a model call, that stops being true, and the missing half of this discipline — logging which prompt version *and* which model version produced a given output — becomes mandatory, because unlike this engine, the same input can legitimately produce a different output next Tuesday.

### Move 2.5 — current state vs future state

```
Phase A (now)                            Phase B (Bulk AI, planned)
──────────────                           ──────────────────────────
checks are versioned, reviewed code      prompt files versioned,
Finding.checkId names what fired          reviewed the same way
no version-pinning needed — pure          MUST log: prompt version +
functions are deterministic by            model version + output,
construction                              per call — because model
                                           upgrades silently change
                                           behavior for the same input

what doesn't have to change: the review discipline (PR, diff,
revert) and the "trace an output back to what produced it" instinct.
What's NEW in Phase B: the model-version pairing, because determinism
is no longer free.
```

### Move 3 — the principle

Versioning a prompt is not fundamentally different from versioning any other thing that determines behavior — the discipline is "put it somewhere reviewable, and record what version was live when a given output was produced." What's specific to prompts is *why* the second half is non-negotiable: code doesn't usually change behavior out from under you when a vendor ships an update; a model does. The observability half exists specifically to catch that.

## Primary diagram

```
Prompt-as-code discipline — both systems, one guarantee chain

  Bulk AI (planned)                        Catalog Audit (today)
  ┌────────────────────────┐               ┌────────────────────────┐
  │ prompt file in git       │◄────────────►│ mg-0NN.ts check in git  │
  ├────────────────────────┤   same review  ├────────────────────────┤
  │ PR review, diff visible  │◄────────────►│ PR review, diff visible │
  ├────────────────────────┤               ├────────────────────────┤
  │ MUST log: prompt version │   ✗ not      │ Finding.checkId names   │
  │ + model version per call │   needed —   │ what fired; no version  │
  │ (model is nondeterministic)│  pure fn   │ field needed (pure fn)  │
  └────────────────────────┘               └────────────────────────┘
```

## Elaborate

The industry term for this is "prompts as code" or "prompt versioning," and the tooling around it (LangSmith, PromptLayer, Braintrust) exists almost entirely to solve the observability half — because the versioning half is just "use git," which most teams already do once someone points it out. The harder-won lesson is that model-version pairing matters: a prompt tuned against GPT-4-0613 is not guaranteed to behave the same against a later snapshot, and teams that don't log which model version served which output lose the ability to tell "the prompt regressed" apart from "the model changed under us" when a bug report comes in weeks later.

## Project exercises

### Exercise: prompt-version + model-version logging for Bulk AI

- **What to build:** when Bulk AI's changeset-proposer prompt goes live, log three things per call: the prompt file's git SHA (or a semantic version bumped in its frontmatter), the model identifier including snapshot date, and the raw response — before any parsing.
- **Why it earns its place:** this is the exact capability this codebase currently gets for free from purity and doesn't yet have a mechanism for, because Bulk AI won't be pure.
- **Files to touch:** new — a logging call inside whatever service wraps the LLM SDK call, likely alongside the pattern `app/app/services/scan/` already uses for structured, timestamped state transitions.
- **Done when:** given any stored Bulk AI output, you can answer "which prompt version and which model produced this" without grepping git blame.
- **Estimated effort:** half a day if the logging table already exists in some form (mirrors `Scan`/`Finding`'s shape in `schema.prisma`); a day if it needs a new table.

## Interview defense

**Q: Why isn't "put the prompt in a file" enough on its own?**
A: Because versioning answers "what changed" but not "which version made this specific output." A model call is nondeterministic and the model itself can change under you — so unlike ordinary code, you need both the prompt version *and* the model version logged per call, or a regression six weeks from now is undiagnosable.

```
the answer, sketched
   prompt in git             +          model version logged per call
┌──────────────────┐                  ┌───────────────────────────┐
│ answers: what      │                  │ answers: which model+prompt│
│ changed, and when  │                  │ made THIS output            │
└──────────────────┘                  └───────────────────────────┘
        both required — neither alone lets you diagnose a regression
```

**Q: This codebase has no prompt. What still applies?**
A: The review discipline and the "trace an output to what produced it" instinct — both fully present via `mg-0NN.ts` in git and `Finding.checkId`. What's missing is the model-version pairing, because nothing here is nondeterministic yet.

## See also

- `05-eval-driven-iteration.md` — the golden set that catches a version-introduced regression before it ships
- `01-anatomy.md` — what goes in the versioned prompt file itself
