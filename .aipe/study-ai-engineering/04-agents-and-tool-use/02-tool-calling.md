# Tool Calling

**Tool calling / function calling — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where a tool-calling dispatcher would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions          │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  runner.server.ts: runScan()  →  runChecks(ALL_CHECKS, ctx)      │
│  ★ a hardcoded array, run via flatMap — NOT a dispatcher ★       │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ──────────────────────────┐
│  contract.ts: CatalogCheck { id, name, description, run(ctx) }   │
│  ★ THIS SHAPE IS A REAL TOOL CONTRACT — reusable, unused as one ★│
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Shop, ShopSettings, Scan, Finding tables                          │
└───────────────────────────────────────────────────────────────────┘
```

You already know the shape of tool calling from a much more boring primitive: a switch statement, or a registry object mapping string keys to handler functions — `{ "createUser": createUserHandler, "sendEmail": sendEmailHandler }`. Tool calling is that registry, except the *lookup key* isn't chosen by your code reading a request field — it's chosen by an LLM reading a prompt and emitting structured JSON that says "call this one, with these arguments." The model never executes anything itself; it just names a function and fills in the arguments, and your code is still the thing that runs it.

MerchGrid has half of this pattern built, in the open, and doesn't have the other half at all — and the gap between those two halves is the single most important distinction in this file. Get comfortable with that split before anything else: **the tool *contract* (a named, described, typed function) is real code you can open right now; the tool-calling *loop* (an LLM choosing which contract to invoke) does not exist anywhere in this repo.**

## Structure pass

**Layers:** UI → Service (`runner.server.ts`) → Engine (`catalog-checks`: `contract.ts`, `run.ts`, the 10 `mg-0NN.ts` files) → Storage.

**Axis to trace: control — who decides which function runs?** In a classic tool-calling system, the model decides, per turn, which tool(s) from a registry to invoke. In this repo, at the Engine boundary, the answer is: nobody decides — `runChecks` (`app/packages/catalog-checks/src/run.ts` lines 26-28) runs *all* of `ALL_CHECKS` (`run.ts` lines 13-24), every time, via `flatMap`. That's not "code decided to call check #3" — it's "there was never a decision point at all."

**Seam:** the boundary that would carry a tool-calling contract already exists — it's `contract.ts`'s `CatalogCheck` interface. Trace the same control axis across that seam and it does *not* flip: whatever sits on the other side of `CatalogCheck.run(ctx)` today is `runChecks`'s flat, unconditional loop, not a model choosing whether to call it. The seam is real and load-bearing (it's exactly why `runChecks` can take *any* array of checks, in any order, and why the checks never import Shopify or Prisma — see `contract.ts`'s import list). What's missing is a caller on the other side that reasons before calling.

## How it works

### Move 1 — the mental model

You've built a form's `onSubmit` handler that reads a `type` field and dispatches to one of several functions — `if (type === "refund") processRefund(payload); else if (type === "cancel") processCancel(payload);`. Tool calling is that same dispatch, generalized twice: instead of a hardcoded `if/else` you keep a registry of `{name, description, inputSchema}` entries, and instead of your code choosing the branch by reading a known field, an LLM reads a natural-language request and *emits* the branch to take, as structured data it read the registry to figure out how to fill in.

```
Pattern — the tool-calling round trip

  ┌─ Host / your code ───────────────────────────────────────────┐
  │  registry: [ {name, description, schema}, {name, ...}, ... ]   │
  └──────────────────────────┬─────────────────────────────────────┘
                             │ 1. send prompt + registry to the model
                             ▼
  ┌─ LLM ────────────────────────────────────────────────────────┐
  │  reads registry descriptions, decides WHICH tool fits,        │
  │  emits: { name: "getWeather", arguments: { city: "Seattle" } }│
  └──────────────────────────┬─────────────────────────────────────┘
                             │ 2. host looks up "getWeather" in registry
                             ▼
  ┌─ Host / your code ───────────────────────────────────────────┐
  │  runs the REAL function, gets a REAL result                  │
  │  { temp: 61, condition: "cloudy" }                            │
  └──────────────────────────┬─────────────────────────────────────┘
                             │ 3. result fed back into the conversation
                             ▼
                    model continues reasoning with real data
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the contract shape, annotated line by line.** This is the piece that's real in this codebase, so start here. `app/packages/catalog-checks/src/contract.ts` lines 1-32:

```typescript
export interface CatalogCheckContext {          // ← the tool's INPUT schema
  variants: NormalizedVariant[];                 //   (typed, not freeform JSON)
  settings: { minimumMarginPercent: number };
  now: string; // ISO 8601 detectedAt, injected so checks are deterministic
}

export interface CatalogFinding {               // ← the tool's OUTPUT schema
  id: string;
  checkId: string;
  severity: FindingSeverity;
  // ...evidence, explanation, adminUrl, etc.
}

export interface CatalogCheck {
  id: string;             // ← the tool's NAME ("mg-001")
  name: string;            // ← human-readable label (an LLM-facing
                            //   registry would put this in a prompt)
  description: string;      // ← EXACTLY what a tool registry entry's
                            //   "description" field is for — telling a
                            //   caller what this function does and when
                            //   to reach for it
  run(ctx: CatalogCheckContext): CatalogFinding[];  // ← the callable itself
}
```

Line these up against the general shape from Move 1 and they match field for field: `id`/`name` is the tool's name, `description` is the exact text an LLM (or a human) would read to decide whether this tool is the right one, `CatalogCheckContext` is a fully-typed input schema (no freeform JSON parsing required), `CatalogFinding[]` is a fully-typed, structured output. This is not "tool-calling-adjacent" — it is the tool contract, built for a different reason (composability and testability of checks) but structurally identical to what you'd hand an LLM's function-calling API.

**Part 2 — the dispatcher that's missing.** A real tool-calling loop needs a caller that (a) sees the registry, (b) decides which entries to invoke, (c) invokes only those, based on something it reasoned about. Compare that to what actually calls `CatalogCheck.run`:

```typescript
// app/packages/catalog-checks/src/run.ts lines 13-28 — the ENTIRE dispatcher
export const ALL_CHECKS: CatalogCheck[] = [
  mg001, mg002, mg003, mg004, mg005, mg006, mg007, mg008, mg009, mg010,
];

export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

`ALL_CHECKS` is a hardcoded array — not a registry a caller queries and selects from, just a list that gets fully consumed. `runChecks` is a `flatMap` — not a dispatch table keyed by a decision, just "call every one of these, in this order, unconditionally." There is no `description` ever read at runtime by anything; it exists in the type but nothing consults it to decide whether to call the function. Contrast the general tool-calling pseudocode with what's actually here:

```
// what a real tool-calling loop looks like (general pattern, NOT this repo)
function handleTurn(prompt, registry):
  toolCall = model.decide(prompt, registry)      // model reads descriptions,
                                                   // picks ONE (or a few)
  tool = registry.lookup(toolCall.name)           // host resolves the name
  result = tool.run(toolCall.arguments)           // host executes it
  return model.continue(result)                   // model reasons over result

// what actually happens in this repo — run.ts lines 26-28
function runChecks(checks, ctx):
  return checks.flatMap(c => c.run(ctx))          // no decision, no lookup,
                                                    // no model in this call at all
```

**In this codebase — the precise line, stated plainly:** the CONTRACT is real; the LOOP is not. `contract.ts` (lines 1-32) gives you a named, described, typed callable — exactly the shape a tool-calling API wants. `run.ts` (lines 26-28) is the caller, and it is a fixed-order pipeline step, not an LLM-driven dispatch: nothing in this codebase ever asks a model "which of these 10 checks should run for this catalog," and nothing reads `description` at runtime to make that call. Calling `runChecks` a "tool router" would be dishonest — a hardcoded array consumed unconditionally is the opposite of routing (`04-tool-routing.md` draws that line precisely). What's true, and worth being precise about instead: if MerchGrid ever needs an LLM to decide which checks matter for a given proposed changeset (spec §25.4's "Check engine → Preflight every proposed edit"), `CatalogCheck` would not need to change shape at all — you'd write a new caller that reads `id`/`description` and lets a model select a subset, and every existing check would already satisfy that caller's contract without modification.

### Move 2.5 — current state vs. future state

```
Phase A (today, real) vs. Phase B (Bulk AI, roadmap, not built)

┌─ Phase A ────────────────────────────────────────────────────────┐
│  ALL_CHECKS: CatalogCheck[]  →  runChecks() flatMap               │
│  caller: CODE, unconditional, same 10 checks every time            │
└────────────────────────────┬──────────────────────────────────────┘
                             │  contract.ts's shape carries over
                             │  UNCHANGED — this is what doesn't
                             │  have to change
┌─ Phase B (speculative) ────▼──────────────────────────────────────┐
│  same CatalogCheck[] registry, now read by an LLM router          │
│  model reasons: "this proposed changeset only touches SKUs,       │
│  only run mg-004/mg-008" → selects a SUBSET → calls run(ctx)      │
│  on each selected check, same typed input/output as today          │
└─────────────────────────────────────────────────────────────────────┘
```

The migration cost, if it ever happens, is entirely in writing a new caller — a router that reads the existing `id`/`description` fields and a prompt, and decides. Nothing about `CatalogCheck`, `CatalogCheckContext`, or `CatalogFinding` would need to change. That's the payoff of having built the contract cleanly in the first place, whether or not the team knew "tool calling" was the industry name for what they were setting up.

### Move 3 — the principle

The reusable insight: a good tool contract — a name, a description aimed at whoever picks it (human or model), a typed input, a typed output — is valuable independent of who the caller is. Code you write assuming a fixed, hardcoded caller today can become an LLM's callable tool tomorrow with zero changes to the contract, *if* you kept the contract clean (no hidden global state, no side effects the caller can't see, no untyped `any` escape hatches) in the first place. The corollary, and the one worth saying bluntly: a fixed array plus a `flatMap` is not tool-calling just because the functions inside it happen to have names and descriptions. Tool calling requires a *decision* — something, at runtime, choosing a subset based on reasoning about the input. Absent that, you have a contract that's *shaped like* a tool, being called by a pipeline, not a tool-calling system.

## Primary diagram

```
Primary diagram — the real contract, and the loop that doesn't exist

┌─ REAL TODAY ────────────────────────────────────────────────────────┐
│  contract.ts (lines 1-32)                                            │
│    CatalogCheck { id, name, description, run(ctx): CatalogFinding[] }│
│                          │                                            │
│                          │  consumed by                                │
│                          ▼                                            │
│  run.ts (lines 13-28)                                                 │
│    ALL_CHECKS: CatalogCheck[]  →  checks.flatMap(c => c.run(ctx))    │
│    (fixed array, unconditional call, no decision, no model)           │
└────────────────────────────┬──────────────────────────────────────────┘
                             │
             ✗ NOT BUILT — an LLM reading `description`,
               selecting a subset of CatalogCheck, calling
               only those. This is the missing half.
               Would attach in Bulk AI (spec §25.4), reusing
               contract.ts unchanged.
```

## Elaborate

Function/tool calling as a named API feature dates to OpenAI's June 2023 "function calling" release — before that, teams got a model to emit structured actions by asking it to output JSON in the prompt and parsing that JSON themselves (fragile, since a model can wander off-format). What changed with native tool-calling APIs is the model gets fine-tuned/constrained specifically to emit valid calls against a schema you supply, which is why the contract's *shape* — name, description, JSON-schema-typed arguments — is dictated by the API, not by convention. The Model Context Protocol (MCP, 2024) generalized this further: instead of every application defining its own ad hoc tool registry, MCP standardizes the wire format for "here are my tools, here's how to call them" so a tool built for one host can be reused by any MCP-compatible client. `contract.ts`'s `CatalogCheck` predates and has no dependency on either of these — it was built for internal composability (spec §27: "design the check engine as a reusable package") — but the shape converges because good interface design converges: name, description, typed input, typed output is the load-bearing skeleton of *any* callable contract meant to be invoked by something that isn't you.

## Project exercises

### Wrap `runChecks` as an LLM tool-call handler using a stub model response

- **Exercise ID:** EX-1
- **What to build:** A standalone script that exposes each entry in `ALL_CHECKS` as a "tool" in a minimal, hand-rolled tool-calling loop — no real API key, no network call. Hardcode a fake "model response" (a JSON blob shaped like `{ name: "mg-004", arguments: {} }`) and write the host-side code that looks that name up in `ALL_CHECKS`, calls `.run(ctx)` on the match, and prints the resulting `CatalogFinding[]`. Then simulate a second fake response that names a check that doesn't exist, and handle that failure explicitly (see `06-error-recovery.md` for what a real host would do here).
- **Why it earns its place:** This is the single most direct way to rehearse the difference this file's Move 2 draws — you'll feel exactly where "the contract" ends and "the missing dispatcher" begins, because you're the one writing the dispatcher by hand.
- **Files to touch:** New scratch file, e.g. `app/scripts/tool-call-stub.ts`; imports `ALL_CHECKS` and the `CatalogCheck`/`CatalogCheckContext` types from `@merchgrid/catalog-checks`.
- **Done when:** The script runs a fake tool call end to end (name lookup → `run(ctx)` → printed findings) and separately demonstrates the not-found case failing loudly instead of silently.
- **Estimated effort:** 1-2 hours.

### Write the tool-registry description a real LLM caller would read

- **Exercise ID:** EX-2
- **What to build:** For 2-3 of the 10 checks (e.g. `mg-001`, `mg-004`, `mg-008`), write the exact JSON-schema-style tool definition (`name`, `description`, `parameters`) you would hand to an LLM's function-calling API today, sourced directly from each check's existing `description` field and its `CatalogCheckContext` shape.
- **Why it earns its place:** Forces you to confirm, concretely, that the existing `description` strings in `app/packages/catalog-checks/src/checks/mg-00N.ts` are already good enough for a model to pick from — or to find out they're too terse and would need rewriting, which is a real, transferable skill (writing tool descriptions models can actually route on).
- **Files to touch:** No production files — a scratch JSON/markdown file with the three tool definitions written out.
- **Done when:** You can point at the real `description` string in each `mg-00N.ts` file (`app/packages/catalog-checks/src/checks/`) and say, for each, whether it would need editing before an LLM could reliably choose between them.
- **Estimated effort:** 45 minutes.

## Interview defense

**Q: Is `runChecks` a tool-calling system?**
A: No — it's a fixed pipeline step, not an LLM-driven dispatch. `runChecks` (`run.ts` lines 26-28) is a `flatMap` over a hardcoded array (`ALL_CHECKS`); nothing ever reads a check's `description` at runtime or decides which subset to call. What *is* real and worth being precise about: `CatalogCheck` (`contract.ts` lines 1-32) is structurally identical to a tool-calling contract — named, described, typed input, typed output — so it's directly reusable as one if this codebase ever needed a model to choose among checks.
*Sketch while you say it:* the primary diagram's "REAL TODAY" box vs. the "✗ NOT BUILT" callout underneath it.

**Q: What would it take to make this an actual tool-calling system?**
A: You'd need a caller that reads the registry (`ALL_CHECKS`) and a prompt or task description, asks a model which check(s) apply, and invokes only the model's selection — not all 10 unconditionally. `CatalogCheck`'s shape wouldn't need to change; only the caller changes, from `runChecks`'s flatMap to a router that makes a real decision per call.
*Sketch while you say it:* the Phase A / Phase B comparison diagram in Move 2.5 — same contract, different caller.

**Q: Why would you want a fixed pipeline instead of tool-calling here, even though the contract already looks tool-shaped?**
A: Because the product's whole value is that MG-003 fires identically on identical data, every time — that's a determinism guarantee, and an LLM choosing which checks to run would trade that guarantee for a flexibility this product doesn't need (spec §2.1: "Deterministic: Findings come from explicit validation rules rather than an LLM"). The contract being tool-shaped is a *design* virtue (it keeps the checks composable and independently testable); it doesn't imply the caller should be a model just because it could be.

## See also

- `01-agents-vs-chains.md` — the broader control-axis question this file specializes to one function boundary (`CatalogCheck.run`).
- `04-tool-routing.md` — the precise distinction between "run everything" (`ALL_CHECKS`/`runChecks`, this file) and "select a subset" (routing, not built here either).
- `06-error-recovery.md` — what happens when a tool call fails, walked with the same real-vs-not-real discipline this file uses.
- `app/packages/catalog-checks/src/contract.ts` — the contract itself; open it before opening any of the 10 check files.
- Product spec `merchgrid-catalog-audit-product-spec.md` §25.4 and §27 — the roadmap language that names the check engine as reusable for a future model-driven caller.
