# Check registry pattern (`CatalogCheck` + `ALL_CHECKS`)

### Strategy pattern / plugin registry — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the registry lives

  ┌─ App layer ─────────────────────────────────────────────────┐
  │  runner.server.ts:  runChecks(ALL_CHECKS, ctx)                │
  └─────────────────────────┬─────────────────────────────────┘
                            │
  ┌─ Engine layer (catalog-checks) ─────────────────────────────┐
  │  contract.ts: CatalogCheck (the port)                        │
  │  ★ run.ts: ALL_CHECKS + runChecks ★  ← THIS CONCEPT           │
  │  checks/mg-001.ts … mg-010.ts  (10 adapters)                 │
  └──────────────────────────────────────────────────────────────┘
```

Ten independent rules — zero/negative price, below-cost, low margin,
invalid compare-at, duplicate SKU, duplicate barcode, missing SKU,
price-outlier, conflicting duplicate SKU, missing unit cost — all get run
the same way, from the same one-line call. The registry is what makes
"add an eleventh rule" a three-file, zero-caller-changes operation instead
of a rewrite of `runScan`.

## Structure pass

**Axis: who decides which checks run, and who decides how a check runs?**

```
  Two questions, two owners

  "which checks run this scan?"   →  run.ts's ALL_CHECKS array
  "how does mg-003 decide to fire?" →  mg-003.ts's own run() body

  runChecks() never asks the second question — it only iterates the first.
```

**Seam — the `CatalogCheck` interface (`contract.ts:27-32`) is the
port.** Every check module (`mg-001.ts` … `mg-010.ts`) is an **adapter**
implementing that port; `runChecks` (`run.ts:26-28`) is the **client**
that depends on the port and never imports a concrete check file itself.
`ALL_CHECKS` (`run.ts:13-24`) is the **factory list** — the one place that
names every concrete adapter, so nothing else in the app has to.

```
  port · adapter · client — mapped onto this repo

  CatalogCheck (contract.ts)     →  port
  mg001 … mg010                  →  adapters (10 of them)
  runChecks()                    →  client (depends on CatalogCheck only)
  ALL_CHECKS                     →  the registry/factory list
```

**Layered decomposition — trace "what does a check need to know" down
from the runner:**

```
  "what does each layer need to know about a check?"

  runScan (runner.server.ts)   → knows NOTHING about individual checks —
                                  just calls runChecks(ALL_CHECKS, ctx)
      ALL_CHECKS (run.ts)       → knows all 10 concrete checks by name
          mg-003.ts             → knows its own rule (margin threshold)
                                   and nothing about the other 9
```
The knowledge narrows as you go down — the opposite of a system where
every layer needs to know about every check. That narrowing is the actual
payoff of the pattern.

## How it works

### Move 1 — the mental model

You've written a `.map()` over an array of handler objects that all share
one method name before — same shape, at the scale of ten independent
business rules instead of ten UI event handlers. `CatalogCheck` is the
shared shape (`id`, `name`, `description`, `run(ctx)`); `ALL_CHECKS` is
the array; `runChecks` is the `.flatMap()`.

```
  The kernel

  ctx (variants + settings + now)
       │
       ▼
  for each check in ALL_CHECKS:
       check.run(ctx)  →  CatalogFinding[]  (zero or more)
       │
       ▼
  flatten all ten arrays into one findings list
```

### Move 2 — the walkthrough

**The port — small enough to memorize.**
```typescript
// app/packages/catalog-checks/src/contract.ts:27-32
export interface CatalogCheck {
  id: string;
  name: string;
  description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
```
Four fields. `id`/`name`/`description` are metadata (used for CSV headers
via `CHECK_NAMES` in `api.scans.$id.export.tsx:11-13`); `run` is the only
behavior. A check is a pure function from `(variants, settings, now)` to
`CatalogFinding[]` — no check can reach outside `ctx`, which is what makes
every check independently unit-testable with a plain object (see
`packages/catalog-checks/tests/mg-003.test.ts`).

**The registry — one array, one function.**
```typescript
// app/packages/catalog-checks/src/run.ts:13-28
export const ALL_CHECKS: CatalogCheck[] = [
  mg001, mg002, mg003, mg004, mg005, mg006, mg007, mg008, mg009, mg010,
];

export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```
`runChecks` takes `checks` as a parameter rather than reaching for
`ALL_CHECKS` directly — a small but real design choice: it means `runChecks`
could run any subset (useful for a future "run only these 3 checks" mode,
or for a test that wants to isolate one check's interaction with another)
without changing the function itself. `runScan` (`runner.server.ts:130`)
happens to always pass `ALL_CHECKS`, but the function doesn't assume that.

**Adding a check touches exactly three files, and `runScan` isn't one of
them.** Confirmed by walking the actual registration points: a new
`checks/mg-011.ts` (the adapter), one new line in
`catalog-checks/src/index.ts` (the package's public export list,
lines 11-20), and one new array entry plus one new import in `run.ts`
(lines 2-11 imports, 14-24 array). `runner.server.ts:130`
(`runChecks(ALL_CHECKS, ctx)`) does not change — the whole point of
depending on the port instead of ten concrete imports.

**Findings stay uniform however many checks produce them.** Every check
constructs its findings through the shared `findingFor` helper
(`checks/_helpers.ts:4-30`), so a `CatalogFinding`'s shape (`id`,
`checkId`, `severity`, `productId`, `evidence`, ...) is identical whether
it came from `mg-001`'s single-field-filter style
(`mg-001.ts:12-24`, a `.filter().filter().map()` chain) or `mg-008`'s
group-then-compute style (`mg-008.ts:12-43`, grouping by product then
computing a median). The registry doesn't care which internal shape a
check used to arrive at its findings — only that it returns the port's
output type.

## Primary diagram

```
  The check registry — one port, ten adapters, one client

  ┌─ contract.ts ──────────────────────────────┐
  │  CatalogCheck { id, name, description, run }│   ← the port
  └─────────────────────┬──────────────────────┘
                        implements
       ┌─────┬─────┬─────┼─────┬─────┬─────┬─────┬─────┬─────┐
       ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼     ▼
     mg001 mg002 mg003 mg004 mg005 mg006 mg007 mg008 mg009 mg010
       └─────┴─────┴─────┼─────┴─────┴─────┴─────┴─────┴─────┘
                          │ listed in
                   ┌──────▼───────┐
                   │  ALL_CHECKS   │  (run.ts:13-24)   ← the registry
                   └──────┬────────┘
                          │ passed to
                   ┌──────▼────────┐
                   │  runChecks()   │  (run.ts:26-28)   ← the client
                   └──────┬────────┘
                          │ called by
                   ┌──────▼────────┐
                   │ runScan()      │  (runner.server.ts:130)
                   │ — never names  │
                   │   a check      │
                   └────────────────┘
```

## Elaborate

This is the strategy pattern at the scale of "ten interchangeable rule
objects behind one interface," and the specific engineering payoff worth
naming is change amplification: the measure of whether a registry pattern
is paying for itself is exactly "how many files does adding one new
instance touch, and does the caller have to change." Here the answer is
three files, and the answer to the second half is no. Contrast with a
codebase where adding a rule means editing a giant `switch` statement
inside the runner itself — same behavior, but every new rule risks merge
conflicts in one shared function and couples the runner's blast radius to
every individual rule's logic.

## Interview defense

**Q: "What would you lose if you inlined all ten checks into one big
function instead of this registry?"**
A: Independent testability (each `mg-0NN.test.ts` file tests one rule in
isolation against a synthetic `CatalogCheckContext`) and safe
parallel development — two engineers adding MG-011 and MG-012
simultaneously would both edit the same giant function instead of adding
two new files. The registry's whole value is that "add a check" and "run
all checks" are decoupled operations.

**Q: "What's the part of this design someone building it from scratch
would most likely get wrong?"**
A: Making `runChecks` take `ALL_CHECKS` as a hardcoded global reference
instead of a parameter. It's a one-line difference
(`runChecks(ctx)` reaching for a module-level constant vs.
`runChecks(checks, ctx)`), but the parameterized version is the one that
stays testable in isolation and reusable for a future "run a subset"
mode — exactly the kind of small interface decision that's invisible
until you need it.

**Q: "Where does this pattern stop being the right call?"**
A: If checks ever needed to depend on *each other's* results (check B
only makes sense after check A ran), a flat array iterated with
`.flatMap()` stops being enough — you'd need an explicit dependency graph
or execution order, not just a list. Right now every check is
independent by construction (`mg-003`'s own comment at line 20 even notes
it deliberately skips negative-margin variants "to avoid
double-flagging" with `mg-002` — a soft coordination via shared
convention, not a hard dependency), so the flat registry has held so far.

## See also

- `audit.md` lens 1 (complexity) — names this as the low-change-amplification example.
- `01-decimal-money-boundary.md` — the money primitive every adapter calls into.
- `app/packages/catalog-checks/tests/run.test.ts` — the registry's own test coverage.
