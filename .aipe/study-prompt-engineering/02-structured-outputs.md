# Structured outputs via tool calling and schemas

Subtitle: **structured output / schema-constrained generation** — Industry standard

## Zoom out, then zoom in

```
Zoom out — where structured output would live

┌─ Shopify Admin (embedded UI) ──────────────────────────────┐
│  app.scans.$id.tsx renders finding.severity as a Badge tone  │
└──────────────────────────┬───────────────────────────────┘
                            │  typed object, not a string to parse
┌─ Engine (app/packages/catalog-checks) ── TODAY ────────────┐
│  ★ CatalogFinding contract + findingFor() boundary ★         │
│  the deterministic version of "schema, enforced at the edge"│
└──────────────────────────┬───────────────────────────────┘
                            │  same discipline, LLM added
┌─ MerchGrid: Bulk AI (planned) ── FUTURE ───────────────────┐
│  LLM proposes a changeset → must come back as a typed object,│
│  not prose describing a changeset                            │
└─────────────────────────────────────────────────────────────┘
```

I have shipped six production features that depend on structured output from an LLM. Every one of them broke at least once because someone — often me — added a well-meaning instruction like "and please keep it concise" to a prompt that was relying on schema mode, and the model started wrapping its schema-conformant JSON in a markdown code fence as a courtesy. The parser, which was doing `JSON.parse(response)`, got a string starting with ```` ```json ```` and threw. That's the concrete shape of the concept this file teaches: structured output isn't "ask nicely for JSON in the prompt text" — it's a contract enforced at the boundary between the model's response and the code that consumes it, with validation and a retry path when the contract is violated.

MerchGrid: Catalog Audit doesn't call a model, so it can't have this exact bug. But it has the *other half* of the same discipline — a schema, and a single point where every object gets constructed against that schema — and that half is worth studying on its own, because it's the part that has to exist whether or not an LLM is involved.

## Structure pass

**Axis: who's allowed to construct the object, and who enforces its shape.** Trace "does anything reach the consumer without going through the schema" across an LLM-backed system and this codebase.

```
control axis — who enforces the shape before a consumer sees it

LLM + schema mode:      provider enforces token-level grammar
                         → your code validates again at the boundary
                         → retry with a stricter prompt on failure

Catalog Audit (today):  TypeScript compiler enforces CatalogFinding's
                         shape at compile time → findingFor() is the
                         ONLY function that constructs one → no check
                         can hand-build a finding that skips a field
```

**Seam:** the seam in an LLM system is the parse boundary — response text in, validated typed object out, and everything on the far side of that seam trusts the object completely. In this codebase, the equivalent seam is `findingFor()` (`app/packages/catalog-checks/src/checks/_helpers.ts:4-30`): every one of the ten checks calls it instead of constructing a `CatalogFinding` literal by hand, so the seam has exactly one place to enforce the shape, not ten.

## How it works

### Move 1 — the mental model

You already know this from TypeScript function signatures: a function that takes `{ name: string; age: number }` and nothing else cannot silently receive a string instead. Structured output is the same idea applied to what a model is allowed to emit — instead of asking the model to describe the answer in prose and hoping you can regex it out, you give it (or the API layer gives it) a schema, and the response either conforms or the call fails visibly.

```
Structured output — schema in, validated object out

  schema declared ──► provider grammar-constrains generation
       │                        │
       │                        ▼
       │              raw response (should already be schema-shaped)
       │                        │
       ▼                        ▼
  your code re-validates at the boundary ──► typed object OR retry
```

### Move 2 — the deterministic version, in this codebase

**The schema.** `app/packages/catalog-checks/src/contract.ts:11-25` declares `CatalogFinding` as a TypeScript interface — this plays the exact role a JSON Schema or Zod schema would play for an LLM call: it names every field the consumer is allowed to depend on, and nothing else is legal.

```ts
// app/packages/catalog-checks/src/contract.ts:11-25
export interface CatalogFinding {
  id: string;
  checkId: string;
  severity: FindingSeverity;     // "CRITICAL" | "WARNING" | "UNAVAILABLE" — a closed enum,
  shopId: string;                // same discipline an LLM schema uses for a constrained field
  productId: string;
  variantId?: string;
  title: string;
  explanation: string;
  evidence: Record<string, string | number | boolean | null>;
  productTitle: string;
  variantTitle?: string;
  adminUrl: string;
  detectedAt: string;
}
```

`FindingSeverity` (`contract.ts:3`) is a union of exactly three string literals. That's the same move as an LLM schema's `enum: ["CRITICAL", "WARNING", "UNAVAILABLE"]` — closing off the field so nothing downstream has to defensively handle a fourth, unexpected value.

**The boundary.** `findingFor()` is the single factory every check calls — no check anywhere in `app/packages/catalog-checks/src/checks/` builds a `CatalogFinding` object literal directly:

```ts
// app/packages/catalog-checks/src/checks/_helpers.ts:4-30
export function findingFor(
  v: NormalizedVariant,
  ctx: CatalogCheckContext,
  f: { checkId: string; severity: FindingSeverity; title: string;
       explanation: string; evidence: Record<string, string | number | boolean | null>; },
): CatalogFinding {
  return {
    id: `${f.checkId}:${v.variantId}`,   // derived, not caller-supplied — can't be malformed
    checkId: f.checkId,
    severity: f.severity,
    // ...assembles the rest from v and ctx, never from free-form caller input
  };
}
```

This is the "validate at the boundary" half of the structured-output discipline, minus the retry loop — there's nothing to retry because a TypeScript compile error, not a runtime parse failure, is what happens if a check tries to hand `findingFor` a shape it doesn't declare. That's strictly stronger than what an LLM schema gives you (compile-time versus runtime), and it's exactly the gap Bulk AI will reintroduce the moment a model's response re-enters this pipeline: the model's output can't be checked by `tsc`, so it needs the runtime validate-and-retry loop this codebase currently gets for free.

### Move 2.5 — current state vs future state

```
Phase A (now)                           Phase B (Bulk AI, planned)
──────────────                          ──────────────────────────
CatalogFinding + findingFor()           LLM proposes a changeset →
enforced at compile time, zero          must validate against a
runtime cost, zero retry logic          Zod/JSON-Schema equivalent
needed                                  of CatalogFinding's shape
                                         → retry with a stricter
                                         system prompt on schema fail
                                         → log the schema-fail rate

what doesn't have to change: the shape discipline itself. Bulk AI's
changeset schema should look like CatalogFinding's sibling — one job
per field, a closed enum for anything like severity, a factory
function as the only construction path.
```

### Move 3 — the principle

Structured output isn't really about JSON. It's about refusing to let free-form text be the interface between two pieces of code that need to agree on shape. Whether the enforcement point is a TypeScript compiler or a runtime schema validator, the discipline is the same: name every field, close every enum, and give the object exactly one place it can be constructed.

## Primary diagram

```
Structured output — the full contract, both systems

  LLM + schema mode (Bulk AI, planned)      TypeScript contract (today)
  ┌───────────────────────────────┐         ┌───────────────────────────┐
  │ schema declared (Zod/JSON      │         │ CatalogFinding interface   │
  │ Schema)                        │◄───────►│  (contract.ts:11-25)       │
  ├───────────────────────────────┤  same    ├───────────────────────────┤
  │ provider grammar-constrains    │  role   │ tsc enforces at compile    │
  │ generation                     │         │ time                       │
  ├───────────────────────────────┤         ├───────────────────────────┤
  │ your code re-validates at the  │         │ findingFor() — the ONLY    │
  │ boundary, retries on fail       │◄───────►│ construction path          │
  └───────────────────────────────┘         │  (_helpers.ts:4-30)         │
                                              └───────────────────────────┘
```

## Elaborate

Tool calling and JSON mode replaced "please respond only in JSON" instructions around 2023–2024 as providers started offering grammar-constrained decoding — the model literally cannot emit a token that violates the schema, instead of being asked nicely and sometimes complying. OpenAI's function calling and Anthropic's tool use both work this way now. The specific failure this file's opening story describes — courteous prose wrapping — still happens with plain JSON mode when the surrounding prompt asks for something in tension with "raw JSON only" (like "concise" or "friendly"); it happens less with tool calling, because the schema is a structural part of the API call, not a sentence competing with other sentences for the model's attention. Read Anthropic's and OpenAI's structured output documentation directly before shipping this in Bulk AI — the retry semantics differ by provider.

## Project exercises

### Exercise: schema-first changeset proposal for Bulk AI

- **What to build:** a Zod (or equivalent) schema for a proposed catalog changeset, modeled directly on `CatalogFinding`'s field-per-concern shape — one job per field, a closed enum for the change type.
- **Why it earns its place:** this is the first place in the MerchGrid codebase an LLM's output will need runtime validation instead of compile-time; getting the schema shape right first prevents the markdown-fence bug class before it exists.
- **Files to touch:** new package, likely `app/packages/catalog-ai/src/schemas/changeset.ts`, following the existing `catalog-checks` package-boundary pattern (`app/packages/catalog-checks/src/contract.ts` as the template).
- **Done when:** a malformed model response fails validation with a specific, loggable reason (not a silent `undefined` field) and a defined retry happens exactly once before surfacing an error.
- **Estimated effort:** one day, including the retry-and-log path.

## Interview defense

**Q: Why is "ask the model to respond in JSON" not the same as structured output?**
A: Because it's a request, not a contract — the model can comply, add a code fence, add a preamble, or partially comply, and your `JSON.parse` has no way to know which happened until it throws. Structured output/tool calling constrains the token-level grammar so the shape isn't optional, and you still validate again at your own boundary because providers aren't infallible either.

```
the answer, sketched
  prompt text asking for JSON        schema-constrained generation
  ┌─────────────────────┐            ┌─────────────────────┐
  │ "respond only in     │            │ schema passed to the │
  │  JSON" (a request)   │            │ API call itself       │
  └──────────┬───────────┘            └──────────┬───────────┘
             │ model may still wrap,               │ provider enforces
             │ preface, or partially comply         │ at the token level
             ▼                                      ▼
        parser breaks                        still validate at
        unpredictably                        YOUR boundary, retry on fail
```

**Q: This codebase has no LLM. What's the load-bearing part of structured output that still applies?**
A: The single-construction-path rule. `findingFor()` is the only function that builds a `CatalogFinding` — no check hand-assembles one. That rule is what makes a schema meaningful in either system: a schema you can bypass isn't a contract, it's a suggestion.

## See also

- `01-anatomy.md` — the policy/data split this schema also encodes
- `07-output-mode-mismatch.md` — what happens when two consumers disagree about the schema
