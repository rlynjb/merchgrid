# Decimal-precision money testing

### Industry names: property-based edge-case testing / floating-point-avoidance testing — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Every layer that touches a price, cost, or margin ─────────────┐
  │  checks (mg-002, mg-003, mg-008...) → runner persist → CSV export │
  │       all call through ONE shared module for arithmetic            │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ packages/catalog-checks/src/money.ts ▼─────────────────────────┐
  │  ★ lt / lte / eq / gt / sub / mul / marginAmount / marginPercent │ ← we are here
  │  formatMoney / median — all built on decimal.js, NEVER a float    │
  └──────────────────────────┬───────────────────────────────────────┘
                             │
  ┌─ Test layer ───────────────▼───────────────────────────────────┐
  │  money.test.ts — asserts on the ONE bug class this domain        │
  │  cannot tolerate: silent float drift in a merchant's margin       │
  └────────────────────────────────────────────────────────────────┘
```

`.aipe/project/context.md` states a hard constraint: *"Money is decimal.
Never use floats/`Number()`/`parseFloat` for price/margin — use
`catalog-checks/money.ts` helpers (decimal.js)."* This file is where that
constraint gets tested — not as an abstract style rule, but as concrete
assertions against the exact input pairs that would expose float drift if
anyone ever violated it.

## Structure pass

**Layers:** the wrapped library (`decimal.js`) → the app's own thin
wrapper functions (`money.ts`) → every caller (10 checks, the runner's
persist step, the CSV exporter, `scan-api.server.ts`'s margin computation).

**Axis: what happens to precision at each layer?** Trace it:

```
  "does precision survive this layer intact?"

  Shopify GraphQL:    price/cost arrive as STRINGS ("8.00", "10.00")
  normalizeCatalog:   strings preserved VERBATIM, never parsed to Number
                        (see catalog-core/tests/normalize.test.ts:78-85)
  money.ts:            strings wrapped in Decimal for EVERY operation
  checks/persist/CSV:  results formatted back to strings via formatMoney()
```

Precision survives every layer specifically because *nowhere* in this chain
does a value pass through a JS `number` for a calculation — the seam that
would leak float error (a `parseFloat` anywhere on this path) simply
doesn't exist in the code, and the tests are built to prove specific values
that would expose it if it ever did.

**Seam:** `money.ts` is the single seam between "arbitrary-precision decimal
arithmetic" and every consumer — no check, no persistence code, and no CSV
formatter does its own arithmetic; they all call through these ten
functions.

## How it works

### Move 1 — the mental model

You know `0.1 + 0.2 !== 0.3` in JavaScript — that's the canonical float
trap, and it's exactly the failure mode a pricing app cannot afford: a
margin check that's off by a fraction of a cent could misclassify a
product as profitable when it isn't, or trigger a false-positive
below-cost alert on a perfectly fine SKU. The mental model here isn't
"test more numbers" — it's "test the *specific* numbers known to break
floating point," the same discipline as testing `0`, `-1`, and
`MAX_SAFE_INTEGER` for an off-by-one bug, just aimed at decimal arithmetic
instead of integer bounds.

```
  The float trap this domain can't tolerate

  JavaScript number:   0.30 - 0.10  === 0.19999999999999998   (WRONG)
  Decimal (money.ts):  sub("0.30", "0.10")  ===  "0.2"          (exact)
```

### Move 2 — the walkthrough

**Every arithmetic function is a one-line wrapper around `decimal.js` —
the discipline is in never bypassing it.**

```typescript
// packages/catalog-checks/src/money.ts:20-26
export function sub(a: Money, b: Money): string {
  return new Decimal(a).minus(new Decimal(b)).toString();
}

export function mul(a: Money, b: Money): string {
  return new Decimal(a).times(new Decimal(b)).toString();
}
```

`Money` is a string type (`@merchgrid/catalog-core`'s type, not a
`number`) — the type system itself makes it awkward to accidentally pass a
float in, since you'd have to explicitly stringify it first.

**The float-drift test targets the exact input that breaks native
arithmetic.**

```typescript
// packages/catalog-checks/tests/money.test.ts:36-39
it("sub subtracts decimal strings without float drift", () => {
  expect(eq(sub("10.00", "8.00"), "2")).toBe(true);
  expect(eq(sub("0.30", "0.10"), "0.20")).toBe(true);
});
```

`0.30 - 0.10` is not a random example — it's the textbook case that
produces `0.19999999999999998` under native JS floats. Choosing this exact
pair as the test input is what makes the test meaningful rather than
decorative; a test that only ever subtracted round numbers like `10 - 8`
would pass even with a float-based implementation.

**Rounding-boundary tests pin the exact rule, not just "it rounds."**

```typescript
// packages/catalog-checks/tests/money.test.ts:79-81
it("formatMoney rounds half-up at the default precision", () => {
  expect(formatMoney("10.005")).toBe("10.01");
});
```

`10.005` rounded to 2 decimal places is the classic half-way case where
"round half up" and "round half to even" (banker's rounding) disagree —
asserting `"10.01"` here pins `formatMoney`'s specific rounding rule
(`Decimal.ROUND_HALF_UP`, `money.ts:44`) against the one input where a
different rounding strategy would silently produce a different, equally
plausible-looking answer.

**Null-cost and zero-price are treated as domain facts, not exceptions.**

```typescript
// packages/catalog-checks/tests/money.test.ts:46-52
it("marginPercent returns null when cost is null", () => {
  expect(marginPercent("10.00", null)).toBeNull();
});
it("marginPercent returns null when price is zero", () => {
  expect(marginPercent("0", "5.00")).toBeNull();
});
```

Margin percent is mathematically undefined at a zero price (division by
zero) and meaningless without a cost to compare against — `marginPercent`
returns `null` for both rather than `NaN`, `Infinity`, or throwing. This
propagates all the way to `scan-api.server.ts:190,211-216`'s
`hasMarginInputs` gate and `export.test.ts:104-129`'s CSV test, which
asserts these same null cases render as *blank columns*, not the literal
string `"NaN"` or `"null"` — the same discipline `04-tenant-isolation-authz-
tests.md`'s CSV-adjacent cousin (`csv.test.ts:117-126`) applies to missing
SKU/barcode.

**`median` — the one function backing an actual outlier-detection check —
is tested on both parities.**

```typescript
// packages/catalog-checks/tests/money.test.ts:58-64
it("median returns the middle value for an odd-length list", () => {
  expect(eq(median(["10", "11", "100"]), "11")).toBe(true);
});
it("median averages the two middle values for an even-length list", () => {
  expect(eq(median(["10", "20", "30", "40"]), "25")).toBe(true);
});
```

Odd-length and even-length lists take genuinely different code paths inside
`median` (`money.ts:28-37`: pick the middle element vs. average the two
middle elements) — testing only one parity would leave the other branch
unverified. `mg-008.test.ts` then builds on exactly this function for
variant-outlier detection, itself testing the boundary where a product has
*only two* positive-priced variants (`mg-008.test.ts:40-44`) — too few for
a meaningful median-based outlier signal, and asserted to produce zero
findings rather than a nonsensical one.

### Move 3 — the principle

The generalizable move: when a domain has a known class of bug that native
arithmetic *will* produce given the right input (float drift, integer
overflow, timezone-naive date math), the test suite's job isn't to test
"more numbers" — it's to test the *specific* inputs known to trigger that
bug class, and to pin rounding/boundary rules against the exact values
where two plausible implementations would disagree. A generic
property-based fuzzer would eventually find `0.30 - 0.10`; naming it
directly in the test is cheaper and makes the intent legible to the next
reader.

## Primary diagram

```
  Where decimal safety is tested, end to end

  Shopify string  →  normalizeCatalog        →  money.ts               →  formatMoney
  "8.00"             (verbatim, no parseFloat)   Decimal-wrapped ops       back to string
       │                    │                          │                       │
       │              normalize.test.ts:78-85    money.test.ts:36-39,    export.test.ts,
       │              (preserves money strings)   79-81 (drift + half-up)  csv.test.ts
       │                                                │                (null → blank col,
       ▼                                                ▼                 not "NaN")
  mg-002/003/008 checks compare via lt/gt/eq — never native < > ===
       (mg-002.test.ts:14 asserts via eq(), not toBe() on a raw number)
```

## Elaborate

This pattern sits one level below `01-golden-set-regression-eval.md`: the
golden-set eval proves the *checks* produce the right findings; this
pattern proves the *arithmetic those checks are built on* can't drift. Both
exist because the domain (merchant pricing) has zero tolerance for a
"close enough" answer — a margin miscalculation isn't a UX papercut, it's a
wrong financial signal a merchant might act on. The broader lesson beyond
this repo: floating-point avoidance is a *design* decision (choosing
`decimal.js` and a `Money = string` type) that only pays off if the test
suite actually exercises the inputs that would have broken the naive
alternative — a decimal library imported but never tested against `0.30 -
0.10` would offer false confidence.

## Interview defense

**Q: Why test `sub("0.30", "0.10")` specifically instead of arbitrary
numbers?**
Because that's the textbook input that produces `0.19999999999999998`
under native JavaScript float subtraction. Testing round numbers like
`10 - 8` wouldn't catch a regression to native arithmetic — the test has to
target the exact case where the two implementations (float vs. decimal)
would disagree.

**Q: Why does `formatMoney("10.005")` matter as a test case?**
`10.005` is exactly halfway between `10.00` and `10.01` at 2-decimal
precision — the one input where "round half up" and "round half to even"
(banker's rounding) give different, equally defensible answers. Asserting
`"10.01"` pins the specific rounding rule (`ROUND_HALF_UP`) the codebase
committed to, so a library upgrade or refactor that silently changes
rounding mode fails this test instead of shipping a one-cent discrepancy no
one notices until reconciliation.

```
  10.005 rounded:
    ROUND_HALF_UP    → 10.01   (this codebase's committed rule)
    ROUND_HALF_EVEN  → 10.00   (equally valid, DIFFERENT answer)
```

**Q: Why does `marginPercent` return `null` instead of throwing or
returning `NaN`/`Infinity` for a zero price?**
Because zero-price division is mathematically undefined, and propagating
`NaN` or `Infinity` into a UI or a CSV export would render as a confusing
value instead of a clear "not applicable." Returning `null` gives every
downstream consumer (the finding-detail UI, the CSV exporter) one
consistent signal to check for and render as blank, which is exactly what
`export.test.ts:104-129` asserts.

## See also

- `01-golden-set-regression-eval.md` — the check-level eval this
  arithmetic layer underpins; a drift here would surface as a mismatched
  finding there too.
- `audit.md` lens 5 (edge cases and error paths) — this file is the
  deepest instance of that lens's money-specific coverage.
- `.aipe/project/context.md`'s "must-not-change constraints" — the
  "Money is decimal" rule this whole pattern exists to keep honest.
