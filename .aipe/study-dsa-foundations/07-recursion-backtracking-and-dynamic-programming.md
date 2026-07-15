# 07 — Recursion, backtracking, and dynamic programming

### State spaces, repeated subproblems, memoization, tabulation — Industry standard

## Zoom out, then zoom in

This is the shortest file in this guide, and honestly so — MerchGrid does
not use recursion, backtracking, or dynamic programming anywhere in its
current codebase. That's worth stating plainly rather than stretching a
`for` loop into a "recursive pattern" to fill space. What it does have is a
concrete, deliberate example of *choosing not to recurse* where a naive
implementation might have — and that choice is itself worth understanding,
because it's the same judgment call you'd make deciding whether a feature
needs recursion at all.

```
Zoom out — where you'd expect recursion, and what's there instead

┌─ Engine — @merchgrid/catalog-core/normalize.ts ────────────────────┐
│  Product → Variants is a two-level hierarchy                        │
│  ★ normalizeCatalog(): two NESTED FOR LOOPS, not recursion ★         │
│                                              ← we are here          │
└──────────────────────────────────────────────────────────────────────┘

  not yet exercised anywhere in this repo: recursion, backtracking,
  dynamic programming (memoization or tabulation).
```

## Structure pass

**Layers:** there's only one layer to trace here — the engine's
normalization step — because this is the only place in the codebase where a
hierarchical walk happens at all.

**Axis to trace: depth — how many levels deep does the data actually go,
and does that depth ever vary?**

```
"How deep does this hierarchy go, and is the depth fixed?" — one layer

┌─ RawCatalog → RawProductNode → RawVariantNode ────────────────────┐
│  depth: EXACTLY 2 levels, always — Shopify's product model has no  │
│  further nesting (no variant-of-a-variant, no product groups)      │
│  a fixed, known depth is what makes recursion unnecessary here      │
└────────────────────────────────────────────────────────────────────┘
```

**Seam:** the seam worth naming is the one between "this data structure
happens to be shallow" and "this data structure is *guaranteed* shallow by
the domain." Shopify's product model caps nesting at product → variant,
full stop — there's no scenario where a future Shopify API version adds a
third level transparently. That guarantee is what makes two nested `for`
loops the right, permanent choice rather than a shortcut that would need
revisiting if the depth ever varied.

## How it works

### Move 1 — the mental model

You've written recursive functions before — a function that calls itself on
a smaller version of the same problem, with a base case that stops it. The
mental model that matters more here is the *decision* of when recursion
buys you something: recursion earns its complexity when the depth of a
structure is unknown or variable (a general tree, a nested comment thread, a
file system). When the depth is fixed and small — exactly two levels, always
— a loop nested inside another loop expresses the same walk with less
machinery: no call stack growth to reason about, no base case to get wrong.

```
Pattern — fixed-depth iteration vs. recursion, same walk, two ways

  what normalizeCatalog does (iterative, fixed depth):
    for each product:              ← outer loop, depth 1
      for each variant:             ← inner loop, depth 2
        normalizeVariant(product, variant)
    (no function ever calls itself)

  what it would look like if depth were unknown/variable (not needed here):
    function walk(node, depth):
      process(node)
      for each child of node:
        walk(child, depth + 1)      ← recursion, because "how many levels"
                                       isn't knowable in advance
```

### Move 2 — the walkthrough

**The actual code — two nested loops, no recursion.**
`normalize.ts:109-126`:

```ts
// app/packages/catalog-core/src/normalize.ts:109-126
export function normalizeCatalog(raw: RawCatalog, opts: NormalizeOptions): CatalogSnapshot {
  const variants: NormalizedVariant[] = [];

  for (const product of raw.products) {              // outer loop: every product
    for (const variant of product.variants.nodes) {   // inner loop: every variant of THIS product
      variants.push(normalizeVariant(product, variant, opts));
    }
  }

  return { shopId: opts.shopId, apiVersion: opts.apiVersion, variants, /* … */ };
}
```

What breaks if you "generalized" this into a recursive tree-walker instead:
nothing breaks functionally, but you'd be writing a base case
(`if (node has no children, stop)`) and a recursive case for a structure
that never has more or fewer than two levels — the base case would exist
purely to satisfy a generality the domain doesn't offer. The two-loop
version is the load-bearing-skeleton answer for *this* shape: fixed depth
means the loop nesting level equals the tree depth, one-to-one, with no
need for the function to track "how deep am I" itself.

**Where the boundary would move.** If MerchGrid ever needed to model
something genuinely tree-shaped with *unknown* depth — for example, product
*bundles* that can contain other bundles (a bundle-of-bundles, arbitrarily
nested) — that's exactly the point where two nested loops stop being
sufficient and a recursive walk (or an explicit stack-based iterative walk,
the non-recursive alternative to the same problem) becomes necessary,
because you can no longer write "for each product, for each variant" and
be done — you'd need "for each node, recurse into its children, however
many levels that takes."

### Move 3 — the principle

**Recursion is the right tool when depth is unknown or data-dependent, not
a stylistic upgrade over a loop.** A fixed, domain-guaranteed depth of two
means the honest, least-complex implementation is two nested loops — and
choosing that over recursion isn't "avoiding recursion" as a general
policy, it's matching the tool to the actual shape of the data.

## Primary diagram

```
Recursion, backtracking, and dynamic programming — the full picture

┌─ what exists: fixed-depth iteration ──────────────────────────────┐
│  normalizeCatalog(): 2 nested for loops, depth guaranteed = 2       │
│  (normalize.ts:110-116)                                              │
└────────────────────────────────────────────────────────────────────┘

  not yet exercised: recursion (no variable-depth structure exists to
  walk), backtracking (no constraint-satisfaction / undo-and-retry search
  anywhere), dynamic programming (no overlapping subproblems — every
  check is a single, independent pass over the variant list, computing
  each finding from scratch with no shared, reusable sub-results).

  See "Elaborate" for the concrete, non-speculative places each of these
  would attach if the product grew toward its own stated roadmap.
```

## Elaborate

**Recursion / general tree walks** — would attach the moment a genuinely
variable-depth structure entered the domain model. The most concrete
candidate already implied by this codebase: nested product bundles, or a
category tree deeper than Shopify's flat product/variant model, in a future
feature. The attachment point would be `@merchgrid/catalog-core/normalize.ts`,
replacing (or sitting alongside) `normalizeCatalog`'s current two-loop walk.

**Backtracking** — a constraint-satisfaction search (try an assignment,
detect a violation, undo, try the next option) has no natural home in
today's engine, because every check is a stateless pass with no notion of
"trying" a value and rolling it back. The product spec's mentioned future —
"MerchGrid: Bulk AI" changeset preflight — is the plausible place this would
show up: previewing a batch of proposed price/SKU changes against
constraints (no two variants share a SKU, no active variant priced at zero)
before committing them is exactly a constraint-satisfaction shape, where an
invalid combination needs to be detected and an alternative tried.

**Dynamic programming** — needs overlapping subproblems to pay for the
bookkeeping (memoization or a tabulation array). MerchGrid's ten checks
don't share subproblems with each other in a way DP would help with — each
check independently scans (or groups, or sorts) the same `ctx.variants`
array, and re-deriving each check's own answer from scratch is exactly as
cheap as caching it, because nothing is computed twice *within* a single
check. Where DP would attach concretely: if a future feature needed to find
an *optimal* sequence of price adjustments under a budget constraint (e.g.
"minimize the number of variants below margin threshold, subject to a
maximum total price change across the catalog") — that's a knapsack-shaped
problem, and knapsack is the canonical DP teaching example for exactly that
reason.

Your own portfolio already has the muscle memory for this gap: your DSA
notes on "recursion with memoization patterns" (per your `reincodes` work)
are strong on the classic recursive+memo shape — the missing rep is tabulation
(bottom-up DP) and true backtracking-with-undo, neither of which this repo
currently exercises. See `08-dsa-foundations-practice-map.md` for how to
close that gap deliberately rather than waiting for MerchGrid to need it.

## Interview defense

**Q: "Why doesn't `normalizeCatalog` use recursion to walk products and
variants?"**
A: Because the depth is fixed and guaranteed by the domain — Shopify's
product model is exactly two levels (product, then its variants), never
more, never fewer. Recursion earns its keep when depth is unknown or
data-dependent; here it's neither, so two nested `for` loops express the
walk with less machinery — no base case to write, no call-stack growth to
reason about for a structure that will never be deeper than two levels.
*(sketch: the "fixed-depth iteration vs. recursion" pattern diagram above)*
One-line anchor: **match the tool to the actual shape of the data — a
known, fixed depth doesn't need recursion's generality.**

**Q: "If MerchGrid added nested product bundles, what would have to
change?"**
A: `normalizeCatalog`'s two nested loops would stop being sufficient,
because "for each product, for each variant" assumes exactly two levels.
A bundle-of-bundles structure has unknown depth, so the walk would need to
become recursive (or an explicit stack-based iterative walk) — process a
node, then recurse into each child, with a base case for a bundle that
contains no further bundles.
One-line anchor: **the two-loop implementation is correct exactly as long
as the domain's depth guarantee holds — the moment that guarantee breaks,
the implementation has to become general.**

## See also

- `05-graphs-and-traversals.md` — the other place a "should this be a
  traversal algorithm?" question comes up in this repo, with the same
  honest answer (not yet, and here's why).
- `08-dsa-foundations-practice-map.md` — where recursion/backtracking/DP
  practice ranks in the overall learning plan for this codebase.
