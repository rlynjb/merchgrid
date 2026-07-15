# Decimal money boundary (`money.ts`)

### Deep module / precision boundary — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where the money boundary lives

  ┌─ App layer ────────────────────────────────────────────────┐
  │  scan-api.server.ts   export.server.ts                     │
  │       │ formatMoney/marginAmount/marginPercent │            │
  └───────┼──────────────────────────────────────────┬─────────┘
          │                                          │
  ┌─ Engine layer (catalog-checks) ───────────────────▼─────────┐
  │  mg-001 … mg-010    ★ money.ts — THIS CONCEPT ★              │
  │  (10 checks, all comparisons and arithmetic pass through it) │
  └────────────────────────┬──────────────────────────────────┘
                           │  wraps
  ┌─ Library ──────────────▼─────────────────────────────────────┐
  │  decimal.js — arbitrary-precision decimal arithmetic          │
  └────────────────────────────────────────────────────────────┘
```

Ten checks compare prices, costs, and margins. Every one of them needs the
same guarantee: `"19.99"` minus `"10.00"` must never come out as
`9.990000000000002`. `money.ts` is the one file in the entire repo that
imports `decimal.js` — every other file, including all ten checks, reaches
one comparison or one arithmetic call away from a raw string, never a raw
`number`.

## Structure pass

**Axis: who's allowed to touch a raw float?** Trace it across the stack:

```
  One question, held constant down the layers

  "who does decimal arithmetic directly?"

  ┌──────────────────────────────┐
  │ checks (mg-001..mg-010)      │   → NO. Call money.ts's functions only.
  └──────────────────────────────┘
      ┌─────────────────────────────┐
      │ money.ts                    │   → YES. The only decimal.js import.
      └─────────────────────────────┘
          ┌─────────────────────────┐
          │ decimal.js               │   → the actual bignum engine
          └─────────────────────────┘

  the answer flips exactly once — that's the seam this module owns
```

**Seam:** the boundary between "any code that needs a money comparison"
and "the one module that knows how to do it correctly." Every check
imports `lt`/`lte`/`eq`/`gt`/`sub`/`mul`/`marginPercent` from
`../money.js` (see `mg-002.ts:2`, `mg-003.ts:2`, `mg-004.ts:2`,
`mg-008.ts:2`) rather than parsing the `Money` string itself. That seam is
load-bearing: cross it (call `parseFloat(v.price)` anywhere in a check) and
the project's own "never floats for money" constraint
(`.aipe/project/context.md` → Must-not-change) breaks silently, no compiler
error, just a wrong answer three decimal places out.

**Layered decomposition:** `Money` (`catalog-core/src/types.ts:1`) is
*just a string* at the type level — `export type Money = string;` — so
TypeScript itself cannot stop a caller from doing `Number(v.price) < 10`.
The discipline is enforced by convention (every arithmetic/comparison call
site imports from `money.ts`) plus test coverage
(`packages/catalog-checks/tests/money.test.ts`), not by the type system.
That's the one gap worth naming honestly: this is a deep module by
discipline, not by a type-level guarantee.

## How it works

### Move 1 — the mental model

You've built this shape before: a `parseFloat` on user-entered currency
that's off by a cent after three additions — same failure, this project's
answer. `money.ts` is a thin, deliberately un-clever wrapper: every
exported function does exactly one `new Decimal(x).operation(y)` and
returns either a `boolean` (comparisons) or a `string` (arithmetic, kept
as `Money` so nothing downstream is tempted to treat it as a number).

```
  The kernel — every function is this shape, nothing more

  input: two Money strings (or an array, for median)
     │
     ▼
  ┌─────────────────────────────┐
  │  new Decimal(a)  .op(  new Decimal(b)  )  │
  └─────────────────────────────┘
     │
     ▼
  output: boolean (lt/lte/eq/gt)  OR  Money string (sub/mul/marginAmount)
```

### Move 2 — the walkthrough

**Comparisons never coerce to number.**

```typescript
// app/packages/catalog-checks/src/money.ts:4-18
export function lt(a: Money, b: Money): boolean {
  return new Decimal(a).lt(new Decimal(b));
}
export function lte(a: Money, b: Money): boolean {
  return new Decimal(a).lte(new Decimal(b));
}
export function eq(a: Money, b: Money): boolean {
  return new Decimal(a).eq(new Decimal(b));
}
export function gt(a: Money, b: Money): boolean {
  return new Decimal(a).gt(new Decimal(b));
}
```
Four one-line functions. `Decimal` parses the *string* representation
directly — `"19.990000"` and `"19.99"` compare equal — so trailing zeros
or differing string formatting from Shopify's GraphQL response never
produce a false mismatch.

**`marginPercent` is where the real decision-hiding happens —
`money.ts:47-55`:**

```typescript
export function marginPercent(price: Money, cost: Money | null): number | null {
  if (cost === null) return null;                              // ← guard 1
  const priceDecimal = new Decimal(price);
  if (priceDecimal.lte(0)) return null;                          // ← guard 2
  const costDecimal = new Decimal(cost);
  return priceDecimal.minus(costDecimal).dividedBy(priceDecimal).times(100).toNumber();
}
```
Two guards a caller would otherwise have to remember every time: no cost
on file → no margin (not zero, not a crash — `null`, meaning "can't
compute"), and a zero-or-negative price → no margin (dividing by zero or a
negative price would produce a meaningless or `Infinity` percentage). Every
one of `mg-003.ts` (margin threshold), `mg-002.ts` (below-cost), and
`scan-api.server.ts:214-216` (finding-detail display) calls this same
function and gets the same two guards for free. This is the module's real
depth: not the arithmetic (that's `decimal.js`'s job), but which
edge cases mean "no answer" vs. a computed one.

**`toNumber()` at the very last step — the one deliberate exception.**
`marginPercent` returns a plain `number`, not a `Money` string
(line 54). That's intentional: a margin *percent* isn't itself a money
value that gets re-compared or re-summed downstream — it's a display/threshold
number compared against `ctx.settings.minimumMarginPercent`
(`mg-003.ts:26`, also a plain number). The module knows the difference
between "a dollar amount, which must stay a `Decimal`-precision string all
the way to display" and "a percentage, which is fine as a float" — and
draws that line itself rather than pushing the choice up to callers.

### Move 3 — the principle

A deep module doesn't have to be big. `money.ts` is 56 lines and ten
one-line functions — the depth is entirely in what it hides (a
third-party bignum library) and what it decides once instead of at every
call site (the two `marginPercent` guards). The measure of a good
interface isn't how little code sits behind it; it's how much a caller
gets to *not* think about.

## Primary diagram

```
  The decimal money boundary — one door, every check walks through it

  ┌─ mg-001 ─┐ ┌─ mg-002 ─┐ ┌─ mg-003 ─┐  ...  ┌─ mg-010 ─┐
  │  lte()   │ │ lt(),sub()│ │marginPct()│      │          │
  └────┬─────┘ └────┬─────┘ └────┬──────┘      └──────────┘
       │            │            │
       └────────────┴─────┬──────┴──────────────────────────┐
                           ▼                                 │
                  ┌─────────────────────┐                    │
                  │      money.ts        │◄───────────────────┘
                  │  lt·lte·eq·gt·sub·mul │   scan-api.server.ts
                  │  marginAmount·Percent │   export.server.ts
                  │  formatMoney·median   │   (display/CSV, same door)
                  └──────────┬────────────┘
                             │  only this file imports
                             ▼
                    ┌─────────────────┐
                    │   decimal.js    │
                    └─────────────────┘
```

## Elaborate

This is the textbook "wrap a third-party library behind a narrow interface"
move, applied to money specifically because floating-point currency bugs
are one of the most common real-world software defects — every language's
IEEE-754 float mishandles base-10 fractions like `0.1` exactly the way this
module was built to prevent. The pattern generalizes past money: any time a
library's native type (float, a raw Date, an untyped JSON blob) is
dangerous to touch directly, wrapping it once behind a small set of named
operations is cheaper than trusting every call site to remember the rule.
For the general "deep module" primitive this exemplifies, see the matching
chapter in this repo's `read-aposd` guide once generated — this file
teaches the codebase-specific instance, not the abstract principle.

## Interview defense

**Q: "Why not just use `number` for money?"**
A: Floats can't represent every base-10 fraction exactly in binary — `0.1 +
0.2 !== 0.3` in JS. Multiply that error across ten checks doing
subtraction, division, and percentage math on real prices, and you get
findings that are wrong by fractions of a cent in ways that compound.
`Money` stays a `string` end-to-end; only `money.ts` ever parses it into a
`Decimal`.

```
  "19.99" - "10.00" via float vs Decimal

  float:    19.99 - 10.00  →  9.990000000000002   (wrong)
  Decimal:  "19.99" - "10.00" → "9.99"             (exact)
```

**Q: "What's the load-bearing part someone would forget to rebuild
this?"**
A: The two guards inside `marginPercent` (cost === null → null; price ≤ 0
→ null). Drop them and a variant with no recorded cost either crashes
(`null` minus a number) or reports a bogus negative-infinity-adjacent
margin instead of "we don't know." That's the part that isn't obvious from
"wrap decimal.js" alone.

**Q: "Where would you push back on this design?"**
A: `Money` is `type Money = string` — a type alias, not a branded/opaque
type. Nothing stops a check author from writing `Number(v.price)` instead
of importing `money.ts`; the discipline is convention plus test coverage,
not the compiler. At this repo's size (10 checks, all reviewed together) it
holds. At 50 checks written by different people, I'd reach for a branded
type or a lint rule banning `Number(`/`parseFloat(` in `checks/**` to make
the boundary enforceable, not just documented.

## See also

- `audit.md` lens 2 (deep vs. shallow modules) — names this as the
  deepest module in the repo.
- `04-check-registry-pattern.md` — every check that calls into this
  module.
- `app/packages/catalog-checks/tests/money.test.ts` — the test file this
  module's guarantees are checked against.
