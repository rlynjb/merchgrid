# Tool Routing

**Tool routing / tool selection (a.k.a. function-calling dispatch, agent router) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where a tool router would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions          │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  runner.server.ts: runScan() → runChecks(ALL_CHECKS, ctx)        │
│  ★ calls ALL 10 checks, unconditionally — this is the OPPOSITE  │
│    of routing, which means selecting a subset ★                 │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ──────────────────────────┐
│  contract.ts: CatalogCheck registry entries (id/name/description)│
│  a router, if one existed, would select FROM this array           │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Shop, ShopSettings, Scan, Finding tables                          │
└───────────────────────────────────────────────────────────────────┘
```

This concept has no anchor in this codebase — say that plainly, because the tempting-but-wrong move here is to look at `ALL_CHECKS` plus `runChecks`'s `flatMap` and call it "routing" because it superficially resembles picking checks from a list. It doesn't select anything; it runs every entry, every time. Routing means the opposite: given a request and a registry of options, deciding *which subset* applies and skipping the rest. This file teaches routing as the general pattern, then draws the line precisely against what MerchGrid actually does.

## Structure pass

**Layers (general pattern):** a router sits between "incoming request" and "the registry of available tools" — it's the Reason half of a ReAct loop's single step, specialized to answering exactly one question: which of these N tools (if any) apply here?

**Axis: control, at the exact moment routing happens.** Before the router runs: nothing has been decided. After it runs: a specific subset of the registry has been selected, and everything not selected is skipped entirely — never invoked, never charged for, never even considered past the router's decision. That's the axis that flips at a router: pre-router, "which tools matter" is unknown; post-router, it's a committed, small, explicit set.

**Seam, drawn precisely against this repo:** `runChecks(ALL_CHECKS, ctx)` (`app/packages/catalog-checks/src/run.ts` lines 26-28) sits exactly where a router *could* sit — right before the checks run — and does not act as one. There is no selection step; the seam that would carry a router's decision is present in the code's shape (a function taking an array and a context) but nothing occupies it. Naming that absence precisely, rather than calling the flatMap "a router," is the entire point of this file.

## How it works

### Move 1 — the mental model

You've written an `if/else` chain that inspects a request and calls one of several handlers based on its shape — a webhook dispatcher keyed on `event.type`, a reducer's `switch (action.type)`. A tool router is that same dispatch, except the "key" being matched isn't a literal string field you can read directly off the input — it's inferred, by a classifier or an LLM, from something unstructured (a natural-language request, an ambiguous payload) that doesn't come with an obvious key attached.

```
Pattern — routing: request in, subset selected out

  request: "the customer wants a refund and also asked about shipping"
                              │
                              ▼
                    ┌───────────────────┐
                    │      ROUTER        │   reads registry descriptions,
                    │  (classifier / LLM)│   decides which apply
                    └─────────┬─────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
      [ selected: refund ]  [ selected: shipping ]  [ skipped: cancelSub,
                                                       skipped: changeEmail ]
              │               │
              ▼               ▼
        refundTool.run()  shippingTool.run()     ← only the selected
                                                     tools ever execute
```

The underlying strategy in one sentence: don't call everything and filter results afterward — decide *before* calling anything, so unrelated tools never run, never cost money, and never have a chance to produce a spurious result you'd have to explain away.

### Move 2 — the step-by-step walkthrough

**Part 1 — what makes something a router and not just a dispatcher.** Every router is a dispatcher (something that looks up "which function handles this"), but not every dispatcher is a router. The distinguishing fact is *how* the lookup key is produced: a plain dispatcher reads a key that's already explicit in the input (`request.type === "refund"`); a router *infers* the key from something that doesn't carry it directly, which is why routers typically need either a trained classifier or an LLM prompted with each tool's `description` — the same `description` field this repo's `CatalogCheck` interface already has, sitting unused for this purpose.

**Part 2 — the registry a router reads from.** Pseudocode for a generic router in front of a `CatalogCheck`-shaped registry:

```
function routeAndRun(request, registry):
  candidates = []
  for tool in registry:                                // registry = CatalogCheck[]
    if modelDecidesRelevant(request, tool.description):  // the actual routing decision
      candidates.append(tool)
  results = []
  for tool in candidates:                                // ONLY the selected ones run
    results.append(tool.run(buildContextFor(tool, request)))
  return results
```

**Part 3 — contrast against the real code, line by line.** `run.ts` (lines 26-28) has no `modelDecidesRelevant` step and no `candidates` filtering — every entry in `ALL_CHECKS` (lines 13-24) is a `candidate` unconditionally:

```typescript
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));   // no selection — this IS the whole loop
}
```

That's the entire function. There's no branch, no scoring, no threshold, nothing that ever decides one check applies and another doesn't — `flatMap` guarantees every element gets called and every result gets concatenated. Compare that to what a router would need to add: a decision per check, made *before* `.run(ctx)` is reached, based on something about the input (a shop's product mix, a proposed changeset's fields) that would let it legitimately skip a check that plainly doesn't apply.

**In this codebase:** not present. `ALL_CHECKS`/`runChecks` is the "run everything" case a router is explicitly the alternative to — worth naming clearly because it's a common conflation. If MerchGrid needed real routing (say, a future changeset only touches SKUs and barcodes, and re-running all 10 checks including pricing/margin checks wastes a call for no benefit), the attachment point is exactly this seam: a new function sitting between "have a proposed changeset" and `runChecks`, reading each `CatalogCheck.description` and the changeset's shape, and passing only the relevant subset into `runChecks` — which itself wouldn't need to change at all, since it already accepts any array of checks, not just `ALL_CHECKS`.

### Move 3 — the principle

Routing is worth its complexity exactly when calling everything is expensive, slow, or actively risky (a tool with a side effect you don't want triggered on an irrelevant request) — and it's *not* worth it when the full set is cheap and safe to run unconditionally, which is precisely MerchGrid's situation today: 10 pure, side-effect-free functions over an in-memory snapshot cost nothing extra to run all of, so there's no incentive to build a selector. The general lesson: don't add a router because a registry of tools *exists* — add one when you can point at a specific cost (latency, money, an unwanted side effect) that running the full set actually incurs.

## Primary diagram

```
Primary diagram — "run everything" vs. routing, side by side

┌─ MerchGrid today (run everything) ───────────────────────────────┐
│  ALL_CHECKS (10 entries) ──► runChecks() flatMap ──► ALL run     │
│  no selection step exists                                          │
└─────────────────────────────────────────────────────────────────────┘

┌─ Routing (general pattern, NOT built here) ───────────────────────┐
│  registry (N entries) ──► ROUTER reads descriptions ──►            │
│         SELECTED subset ──► only those run ──► SKIPPED never run  │
└─────────────────────────────────────────────────────────────────────┘

             ✗ no router exists between a proposed changeset and
               runChecks() — this is where one would attach if
               running all 10 checks ever became expensive or
               irrelevant for a given input (spec §25.4 territory)
```

## Elaborate

Tool routing shows up under a few names depending on which layer of the stack you're in: a "router" in agent frameworks (deciding which tool from a registry to call), a "supervisor" in multi-agent systems (deciding which sub-agent handles a request), and plain old "intent classification" in older NLU pipelines (deciding which handler a user's utterance maps to) are all the same shape — infer a discrete category from something that doesn't carry it explicitly, then dispatch on the result. The design tension every routing system has to resolve is precision vs. recall: a router that's too aggressive about excluding tools risks silently skipping something relevant (a false negative that's invisible unless you specifically audit for it), while a router that includes too much loses the cost savings that justified building it in the first place. That tension is exactly why "run everything" is a legitimate, sometimes-correct design choice rather than a primitive fallback — MerchGrid's own choice here isn't a gap, it's the right call for a cheap, deterministic check set with no cost pressure to select against.

## Project exercises

### Build a routing layer in front of `ALL_CHECKS`, with a stub classifier

- **Exercise ID:** EX-1
- **What to build:** A standalone function, `selectRelevantChecks(changeset, registry)`, that inspects a fake "proposed changeset" object (a small hand-rolled type with fields like `touchedFields: string[]`) and returns only the `CatalogCheck` entries from `ALL_CHECKS` whose `description` plausibly matches those fields — using a simple keyword-match stub instead of a real LLM call. Wire it so its output feeds straight into the real `runChecks`.
- **Why it earns its place:** It's the fastest way to internalize the precision/recall tension named in Elaborate — you'll have to decide, in code, how aggressively to exclude checks, and defend that call the way a real router's designer has to.
- **Files to touch:** New scratch file, e.g. `app/scripts/toy-router.ts`; imports `ALL_CHECKS`, `runChecks`, and the `CatalogCheck` type from `@merchgrid/catalog-checks`.
- **Done when:** Given a changeset that only touches SKU fields, the router selects a strict subset of `ALL_CHECKS` (fewer than 10), and passing that subset into the real `runChecks` still produces correctly-typed `CatalogFinding[]` output.
- **Estimated effort:** 1-2 hours.

### Argue, in writing, whether MerchGrid should ever add routing

- **Exercise ID:** EX-2
- **What to build:** A short written argument (a scratch note, not code) answering: under what conditions, if any, would MerchGrid: Catalog Audit itself (not Bulk AI) benefit from routing in front of `runChecks`? Consider cost, latency, and correctness risk explicitly, using the real numbers you can find (10 checks, all pure functions, run against an in-memory array).
- **Why it earns its place:** This is the interview-defensible version of Move 3's principle — being able to argue *against* adding a pattern you just learned, with real numbers, is a stronger signal than being able to describe the pattern in the abstract.
- **Files to touch:** No production files — a scratch note.
- **Done when:** Your written argument reaches an explicit verdict (route or don't) backed by a specific cost you named, not a hedge.
- **Estimated effort:** 20 minutes.

## Interview defense

**Q: Is `ALL_CHECKS`/`runChecks` an example of tool routing?**
A: No — it's the opposite. Routing means selecting a subset of a registry based on some inference about the input; `runChecks` (`run.ts` lines 26-28) is a `flatMap` that calls every entry in `ALL_CHECKS` unconditionally. There's no decision step, so there's nothing to call a router.
*Sketch while you say it:* the primary diagram's two boxes side by side — "run everything" vs. "routing."

**Q: When would routing actually earn its complexity in a system like this?**
A: When running the full registry has a real cost you can name — latency, money, or an unwanted side effect from a tool that shouldn't fire on an irrelevant request. MerchGrid's 10 checks are pure, side-effect-free, and cheap enough that "run all 10" costs nothing extra, so there's no incentive to build a selector. A future system where each "check" was an expensive external API call, or where running an irrelevant check risked writing something to Shopify, would tip that calculation the other way.
*Sketch while you say it:* the Move 1 pattern diagram's "selected vs. skipped" split, with a cost annotation on each skipped branch.

**Q: If Bulk AI needed routing, what would have to change in this codebase, and what wouldn't?**
A: A new function would sit between "have a proposed changeset" and `runChecks`, reading each check's `description` and deciding relevance. `runChecks` itself wouldn't change — it already accepts any array of `CatalogCheck`, not specifically `ALL_CHECKS`, so a router's filtered subset is a drop-in replacement for the full array at the call site.
*Sketch while you say it:* the primary diagram's dotted attachment point beneath the "MerchGrid today" box.

## See also

- `02-tool-calling.md` — the contract shape (`CatalogCheck`) a router would select from; routing is one specific decision a tool-calling caller can make.
- `03-react-pattern.md` — a single Reason step in a ReAct loop often *is* a router, deciding which one action fits the current thought.
- `01-agents-vs-chains.md` — the broader chain-vs-agent question; routing only exists on the agent side of that fork.
