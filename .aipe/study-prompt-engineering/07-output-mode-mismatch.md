# Output mode mismatch

Subtitle: **output contract mismatch / interface drift between chains** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this bug class would appear

┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  10 checks, ONE shared output type (CatalogFinding) — this    │
│  bug class is structurally prevented, not avoided by discipline│
└──────────────────────────┬───────────────────────────────┘
                            │
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  ★ THIS CONCEPT ★ — if a classifier chain returns free text   │
│  and a downstream chain expects a structured tag, the pipeline│
│  breaks at the seam between them                               │
└─────────────────────────────────────────────────────────────┘
```

Output mode mismatch is what happens when two chains in the same pipeline disagree, silently, about what shape the data between them takes — chain A returns JSON, chain B was written expecting markdown, and the failure surfaces as a parser exception three layers away from the actual cause. Every chain needs one declared output mode, stated in its schema, not inferred from what it happened to return in testing. The bug is easy to spot in code review once you know to look for it: check whether the consuming chain's expected input type is ever written down anywhere, or whether it's just "whatever the previous chain returns, probably."

MerchGrid: Catalog Audit doesn't have this bug — not because the team was disciplined about it (there was no discipline required), but because there's no boundary here where two independently-evolving outputs meet without a compiler checking them first. That's worth understanding precisely, because it's *exactly* the safety net Bulk AI will lose the moment a model's response crosses that same boundary.

## Structure pass

**Axis: what enforces agreement about shape across a chain boundary?** Trace it across an LLM chain pipeline and this codebase's check pipeline.

```
axis: what catches a shape disagreement, and when

LLM chain pipeline:      NOTHING enforces it automatically — chain A's
(the risk)                output shape and chain B's expected input
                          shape are two independent prompts; agreement
                          is a convention, checked (if at all) by a
                          runtime parser failing loudly, in production,
                          after the mismatch already happened

Catalog Audit (today):   TypeScript's structural typing enforces it
                          at COMPILE TIME — every check returns
                          CatalogFinding[] (contract.ts:11-25), and
                          runChecks()'s signature won't compile if a
                          check returns anything else
```

**Seam:** in an LLM pipeline the seam is the literal handoff between chain A's response and chain B's prompt template — whatever gets interpolated there has to match what chain B's instructions assume, and nothing checks that assumption until a parse fails. In this codebase, the same handoff exists between each check's `run()` return value and `runChecks()`'s `flatMap` — but the seam is closed by the type system before the code ever runs, not by convention.

## How it works

### Move 1 — the mental model

You already know this from function signatures in any typed language: if function A returns `string` and function B expects `number`, the compiler stops you before the code ships. Output mode mismatch is that same bug, except it happens at a boundary where nothing checks types — a natural-language handoff between two prompts — so the equivalent of a type error surfaces at runtime, in production, as a parse failure or (worse) silently wrong behavior that nobody notices until a user reports it.

```
Output mode mismatch — the bug, and why it's silent

  chain A's prompt: "summarize the ticket"  →  returns free-form prose
                                                        │
                                                        ▼
  chain B's prompt: "given this JSON, extract the tag"  ← expects JSON
                                                        │
                                                        ▼
                                          parse fails, or worse: silently
                                          extracts garbage from prose
                                          treated as if it were JSON
```

### Move 2 — why this codebase can't have the bug, precisely

Every check's `run()` method is typed to return `CatalogFinding[]` via the shared `CatalogCheck` interface:

```ts
// app/packages/catalog-checks/src/contract.ts:27-32
export interface CatalogCheck {
  id: string;
  name: string;
  description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
```

`runChecks()` composes ten of these (`app/packages/catalog-checks/src/run.ts:26-28`), and because every check implements the same interface, there's no possibility of one check returning, say, a raw string or a differently-shaped object — `tsc` rejects that at the point the check is defined, long before `runChecks` ever runs it. The "does chain B expect what chain A returns" question that a code reviewer has to actively ask in an LLM pipeline is answered automatically here, by the type checker, for every one of the ten checks, every time any of them changes.

This is worth stating precisely rather than just noting "TypeScript helps": the reason output mode mismatch is a *prompt engineering* concept and not just a general software bug is that natural-language interfaces don't have a compiler. `CatalogFinding`'s shared interface is what an LLM pipeline is missing at the chain boundary — and what `02-structured-outputs.md`'s schema-and-validate-at-the-boundary discipline exists specifically to reintroduce, at runtime, once a model (not a typed function) sits on one side of the seam.

### Move 3 — the principle

Output mode mismatch isn't really about JSON versus markdown — it's about what happens when a contract between two components is implicit instead of declared and checked. A type system makes contracts explicit and checks them for free; a natural-language interface makes contracts implicit unless you explicitly reintroduce a schema and a validator at every boundary. The bug this concept names is what happens the moment someone assumes the compiler is still watching when it isn't.

## Primary diagram

```
Output mode mismatch — where the check happens (or doesn't)

  LLM chain pipeline (the risk exists)     Catalog Audit (the risk is closed)
  ┌──────────────────────────┐             ┌──────────────────────────┐
  │ chain A: prompt-defined     │             │ mg-0NN.run(): CatalogCheck │
  │ output shape (implicit)     │             │ interface (contract.ts:27) │
  ├──────────────────────────┤             ├──────────────────────────┤
  │ chain B: prompt-defined      │             │ runChecks(): typed         │
  │ input shape (implicit)       │             │ CatalogFinding[] required   │
  ├──────────────────────────┤             ├──────────────────────────┤
  │ mismatch caught: at RUNTIME,  │             │ mismatch caught: at         │
  │ if at all, after it ships     │             │ COMPILE TIME, before ship   │
  └──────────────────────────┘             └──────────────────────────┘
```

## Elaborate

This is one instance of a broader pattern in LLM systems engineering: anywhere a typed boundary gets replaced by a natural-language one, you lose the compiler's enforcement and have to reintroduce it by hand — structured output/schema validation (`02-structured-outputs.md`) is exactly that reintroduction. Teams that skip it tend to discover output mode mismatches the expensive way, in production incident review, rather than the cheap way, in a type error during development.

## Project exercises

### Exercise: make Bulk AI's chain boundaries typed, even though the content crossing them isn't

- **What to build:** for every handoff between two steps in Bulk AI's pipeline (finding → proposed changeset → validated changeset), define a shared TypeScript interface for what crosses the boundary, and validate the model's actual response against it before passing it to the next step — mirroring `CatalogCheck`'s shared `run()` signature, but with a runtime validator standing in for the compiler.
- **Why it earns its place:** this is the specific safety net this codebase currently gets for free from `tsc` and will lose the instant a model's response is on one side of a handoff.
- **Files to touch:** new — likely a shared types file in whatever package houses Bulk AI's pipeline, following `contract.ts`'s role as the single source of truth for shape.
- **Done when:** a chain that receives a malformed handoff (missing field, wrong shape) fails loudly and specifically, at the boundary, instead of silently producing garbage three steps later.
- **Estimated effort:** half a day per boundary if `02-structured-outputs.md`'s schema discipline is already in place — the interface definition is the cheap part.

## Interview defense

**Q: How do you catch an output mode mismatch in code review, without running the code?**
A: Ask, explicitly, "what does chain B's prompt assume about the shape of chain A's output, and is that assumption written down anywhere chain A's author would see it if they changed it?" If the answer is "it's implicit, based on what chain A currently returns," that's the bug waiting to happen.

```
the answer, sketched
┌─ contract WRITTEN DOWN ──┐        ┌─ contract IMPLICIT ──────┐
│ chain A's author sees      │        │ chain A's author has no    │
│ chain B's expectation        │        │ way to know chain B depends │
│ when changing chain A's       │        │ on the current shape          │
│ output shape                    │        │                                │
└──────────────────────────┘        └──────────────────────────┘
```

**Q: This codebase has no chains. Why does it matter here at all?**
A: Because it demonstrates the mismatch's actual root cause with unusual clarity — the bug only exists where a contract is implicit. `CatalogCheck`'s shared `run(): CatalogFinding[]` signature makes the contract explicit and compiler-checked, which is why this specific bug class cannot occur in `runChecks()`, and it's the exact gap Bulk AI needs to close with runtime validation once natural language sits where a typed function used to.

## See also

- `02-structured-outputs.md` — the schema-and-validate discipline that reintroduces a compiler-equivalent check at runtime
- `06-single-purpose-chains.md` — the composition pattern this bug most often shows up inside
