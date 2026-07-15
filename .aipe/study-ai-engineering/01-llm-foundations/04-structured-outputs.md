# Structured Outputs

**Structured outputs (schema-constrained generation / function calling / JSON mode) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where a schema-constrained LLM call would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  Findings table renders CatalogFinding rows — a fixed shape,  │
│  never freeform text the UI has to parse                       │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  runner.server.ts persists findings straight off the typed       │
│  CatalogFinding[] — no parsing step, because nothing produced      │
│  unstructured text in the first place                               │
│                                                                       │
│         ★ a schema-constrained LLM call would live here ★            │
│         — does not exist; nothing here needs to coerce a model's      │
│           free-text output into a typed shape                          │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks/src/contract.ts ────────────────┐
│  CatalogCheck.run(ctx) → CatalogFinding[]  — a TypeScript interface,      │
│  enforced by the compiler, not by parsing a model's response               │
└───────────────────────────────────────────────────────────────────────┘
```

`01-what-an-llm-is.md` showed you a model that emits one token at a time until it stops. Left alone, that process produces prose — free text with no guaranteed shape. Structured outputs is the family of techniques that constrains that same token-by-token process so what comes out the other end is guaranteed to parse as a specific schema — JSON with the fields you asked for, not "usually JSON, formatted the way the model felt like today."

## Structure pass

**Layers:** the concept sits at the exact boundary between "the model's raw text output" and "the typed object your application code operates on" — everywhere an LLM's output needs to become a struct, a database row, or an argument to another function call.

**Axis: trust — what can the caller assume about the shape of what comes back?** Trace it across an LLM-based system: without structured outputs, the caller can assume *nothing* — a "JSON-ish" response needs a resilient parser, a schema validator, and a retry-on-parse-failure path, because the model is doing next-token prediction over English text, and "syntactically valid JSON with exactly these keys" is a fairly narrow target inside all the text it could produce. With structured outputs (JSON mode, function-calling/tool-use schemas, or constrained/grammar-based decoding), the provider enforces the shape *during* generation — the caller can assume the response parses, though not that its *values* are correct.

**Seam:** the seam is the parser (or its absence) between "model output" and "typed application object." In MerchGrid, this seam is trivial because the object was never text in the first place — `CatalogFinding` (`app/packages/catalog-checks/src/contract.ts` lines 11-25) is constructed directly as a TypeScript object literal inside each check (`findingFor()` in `app/packages/catalog-checks/src/checks/_helpers.ts` lines 4-30), and the compiler enforces its shape at build time. There is no runtime parse step here, because there is no runtime-generated text to parse.

## How it works

### Move 1 — the mental model

You've written a form validator that rejects a submission missing a required field, or a `zod`/`yup` schema that throws if a JSON payload doesn't match. Structured-output generation is the same idea, applied to a model's *output* instead of a client's input — except instead of validating after the fact and rejecting, the better implementations constrain the generation process itself so an invalid shape can't be produced at all.

```
Pattern — three ways to get a schema-shaped result out of an LLM

  (a) prompt-and-pray:      "please respond with JSON like {...}"
                            → parse with try/catch, hope for the best

  (b) provider JSON mode:   provider guarantees SYNTACTICALLY valid JSON
                            → still validate your OWN schema on top

  (c) constrained decoding: provider masks the logits so only tokens that
      / tool-use schema     keep the output on-schema are even sampleable
                            → strongest guarantee, still validate semantics
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the naive approach and why it breaks in production.** The simplest version is a prompt: "Respond only with JSON matching this shape: `{ finding: string, severity: string }`." Because the model is still doing free-form next-token generation, nothing stops it from prefacing the JSON with "Sure, here's the finding:", wrapping it in a markdown code fence, using single quotes, or trailing off mid-object if it hits a token limit. Every one of those is a real, observed failure mode — not a hypothetical — which is why production systems that rely on prompt-and-pray always wrap the parse in error handling and a retry loop.

```
function callWithPromptOnly(prompt):
  response = model.generate(prompt + "\nRespond only with JSON.")
  try:
    return JSON.parse(response)          // fails on preamble, code fences,
                                          // trailing commas, truncation
  catch (parseError):
    // now you need: retry with a stricter prompt? regex-extract the
    // JSON substring? give up and surface an error to the user?
    return handleMalformedOutput(response, parseError)
```

**Part 2 — provider-level JSON mode narrows the failure surface but doesn't close it.** Most major providers offer a request flag that constrains sampling so the output is guaranteed syntactically valid JSON (Part 1's `JSON.parse` failure mode goes away). This does **not** guarantee the JSON matches *your* schema — the model can still emit valid JSON with the wrong keys, missing fields, or a string where you needed a number. You still need a schema validator (a `zod` parse, a JSON Schema validator) on the far side; JSON mode buys you "it's parseable," not "it's correct."

**Part 3 — function calling / tool-use schemas add per-field typing, and constrained decoding is the strongest guarantee.** When you give a provider a tool/function schema (name, parameter types, required fields) instead of a loose "respond with JSON" instruction, the provider trains/steers the model specifically toward filling that schema, and the strongest implementations mask the sampling step itself — at each generation step, tokens that would produce an invalid continuation (a closing brace where a string still needs a comma, a field name not in the schema) are given zero probability, so an off-schema token literally cannot be sampled. This connects directly to `03-sampling-parameters.md`'s truncation step: constrained decoding is truncation driven by a grammar instead of by probability rank.

```
Pattern — constrained decoding masks invalid tokens before sampling

  schema requires:  { "severity": "CRITICAL" | "WARNING" | "UNAVAILABLE" }

  at the token position for the severity VALUE:
    allowed tokens:   "CRITICAL", "WARNING", "UNAVAILABLE"   (probability kept)
    every other token: masked to probability 0               (cannot be sampled)

  the model is still choosing among real candidates — just only the
  ones the grammar permits at that exact position
```

**Part 4 — even a perfect schema match doesn't mean the values are correct.** This is the boundary condition every team forgets: structured outputs guarantee *shape*, never *truth*. A schema-valid response with `{ "severity": "CRITICAL" }` on a variant that's actually fine is still a false positive — the schema constraint operates purely at the syntax level. Anything that checks whether the *content* is right (is this actually critical, does this margin math check out) is a separate concern — in MerchGrid's real engine, that's the entire job of the 10 `mg-0NN` checks, which is exactly why a future LLM-proposed changeset would still need to pass through them (see `07-heuristic-before-llm.md`).

**In this codebase:** not yet implemented — there is no LLM output to constrain, so there's no JSON-mode flag, no tool schema, and no parser recovering a typed object from free text anywhere in this repo. What MerchGrid has instead is arguably the same *problem* solved a level earlier: `CatalogFinding` (`app/packages/catalog-checks/src/contract.ts` lines 11-25) is a TypeScript interface — `id`, `checkId`, `severity: FindingSeverity` (a union of exactly `"CRITICAL" | "WARNING" | "UNAVAILABLE"`, line 3), `evidence: Record<string, string | number | boolean | null>` — and every check builds it through `findingFor()` (`app/packages/catalog-checks/src/checks/_helpers.ts` lines 4-30), a function whose parameter type *is* the schema. There's no runtime validation step because the compiler rejects a malformed `CatalogFinding` at build time; you can't ship a check that returns a `severity` of `"BAD"` because `FindingSeverity` doesn't include that string. This is the strongest possible version of "schema-constrained output" — stronger than any LLM's JSON mode — but it's a build-time compiler guarantee over a value your own code constructs, not a runtime guarantee over a model's generated text, and that distinction matters: it's not the same mechanism, just a stricter cousin of the same goal (shape you can trust downstream).

If MerchGrid built the AI-assisted bulk editor, this is exactly the seam a schema-constrained LLM call would target: the proposed changeset an LLM emits (spec §25.4) would need to be validated (ideally constrained at generation time, at minimum schema-validated afterward) against the same `NormalizedVariant` shape (`app/packages/catalog-core/src/types.ts` lines 3-22) the check engine already consumes — so `runChecks(ALL_CHECKS, ctx)` can preflight it without writing a second parser. The `CatalogCheckContext`/`CatalogFinding` contract (`contract.ts` lines 1-32) is, concretely, the exact typed-output shape a changeset validator would target on the way out the other side.

### Move 3 — the principle

Structured-output techniques move schema enforcement earlier and earlier in the pipeline — from "hope the prose parses" (weakest) to "the provider guarantees valid JSON" to "the sampling step itself cannot produce an off-schema token" (strongest) — but none of them, at any strength, verify that the *values* inside the schema are true. Shape and correctness are separate guarantees, and only one of them is the model's job.

## Primary diagram

```
Primary diagram — the structured-output spectrum, and MerchGrid's build-time analog

  weakest ────────────────────────────────────────────────────► strongest
  prompt-and-pray    JSON mode         tool/function       constrained
  ("please           (syntactically    schema (typed        decoding (invalid
  respond as          valid JSON        fields, required     tokens masked
  JSON")              guaranteed)       vs optional)          at sample time)

                    all four: SHAPE guaranteed, VALUES still unverified
                    values get verified by a separate check, same as MerchGrid's
                    engine verifies its own compiler-enforced CatalogFinding shape

  MerchGrid: Catalog Audit today  →  CatalogFinding is compiler-enforced at BUILD
                                      time (contract.ts), not runtime-parsed from
                                      any model's text output
  MerchGrid: Bulk AI (roadmap)    →  a proposed changeset would need runtime
                                      schema validation against NormalizedVariant,
                                      then value-level verification by runChecks
```

## Elaborate

Structured-output enforcement tracks the broader industry move from "prompt engineering as folklore" toward "prompt engineering as an API contract" — early LLM apps parsed prose with regexes and prayer; providers then added JSON mode; then function-calling/tool-use schemas (popularized by OpenAI's function calling, adopted broadly since) let you hand the provider a typed contract instead of English instructions; grammar-constrained decoding (e.g. via a formal grammar or a library like Outlines/guidance) is the current strongest form, masking invalid tokens directly. The throughline: every step is solving the same problem you already solve with a form validator or an API request schema — the source is just an LLM instead of a browser.

## Project exercises

### Build a schema validator for a stubbed changeset, backed by this repo's real contract

- **Exercise ID:** EX-1
- **What to build:** A validator function `validateProposedChangeset(raw: unknown): NormalizedVariant[]` in a new `app/app/services/ai/validate-changeset.server.ts`, using the real `NormalizedVariant` type from `app/packages/catalog-core/src/types.ts` (lines 3-22) as the target shape. It should reject (with a clear error listing which fields were wrong) any input missing a required field or with a wrong-typed `price`/`unitCost` (must be a decimal string per the `Money` type, line 1). Feed it both well-formed and deliberately malformed fixtures.
- **Why it earns its place:** It's the exact runtime counterpart to what `CatalogFinding`'s compiler enforcement does at build time — you're building the missing half of the seam this file describes, using types that already exist in the repo instead of inventing a new schema from scratch.
- **Files to touch:** New file `app/app/services/ai/validate-changeset.server.ts`; new test `app/app/services/ai/validate-changeset.test.ts`.
- **Done when:** A malformed fixture (e.g. `price: 12.5` as a number instead of the required `Money` decimal string `"12.50"`) is rejected with a field-level error message, and a well-formed one passes straight through into `runChecks(ALL_CHECKS, ctx)` and produces sane findings.
- **Estimated effort:** 1-2 hours.

## Interview defense

**Q: What's the difference between JSON mode and a function-calling/tool-use schema?**
A: JSON mode only guarantees the output is syntactically valid JSON — braces balance, strings are quoted, but the keys and types can be anything. A tool/function schema gives the provider a typed contract (field names, types, which are required) and steers generation toward filling exactly that shape, so you get field-level typing, not just "is this JSON." Neither one verifies the *values* are correct — that's always a separate step.

```
  JSON mode:        guarantees PARSES                (syntax only)
  tool/function:    guarantees matches YOUR SCHEMA    (syntax + field shape)
  neither:          guarantees the VALUES are true     (separate concern)
```

**Q: Does MerchGrid have anything like structured-output enforcement?**
A: In spirit, yes, but at a different layer than an LLM system would need it. `CatalogFinding` (`app/packages/catalog-checks/src/contract.ts` lines 11-25) is a TypeScript interface with a closed `severity` union (`"CRITICAL" | "WARNING" | "UNAVAILABLE"`), and every check constructs it through `findingFor()` — the compiler rejects a malformed finding at build time. That's a stronger guarantee than any LLM's JSON mode, but it's solving a different problem: MerchGrid's own code produces the object, so there's nothing to *parse*. An LLM system needs runtime enforcement because the model's output is text the moment it leaves the provider; MerchGrid's engine never has that moment at all.

**Q: If MerchGrid added an LLM-proposed changeset, what would you validate, and against what shape?**
A: I'd validate it against the existing `NormalizedVariant` type (`app/packages/catalog-core/src/types.ts`), which is already the exact input shape `runChecks` consumes — so a schema-valid, type-checked proposed changeset can go straight into the same deterministic engine that audits a live catalog today, without a second parser or a second contract to maintain.

## See also

- `03-sampling-parameters.md` — constrained decoding is truncation driven by a grammar instead of by probability rank; read that file first for the truncation mechanism this one builds on.
- `07-heuristic-before-llm.md` — why shape-correctness (this file) is never enough; value-correctness is the deterministic engine's whole job.
- `app/packages/catalog-checks/src/contract.ts` — the real, compiler-enforced schema used throughout this file as the contrast case.
- `app/packages/catalog-checks/src/checks/_helpers.ts` — `findingFor()`, the function that plays the role a schema validator would play in an LLM system.
