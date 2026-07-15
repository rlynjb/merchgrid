# Eval Set Types

Golden set / adversarial set / regression set — Industry standard

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Worker layer ──────────────────────────────────────────────┐
│  app/services/scan/runner.server.ts                         │
│  runScan() → fetch catalog → normalize → run checks → save   │
└───────────────────────────┬───────────────────────────────────┘
                            │ same two calls, in-process
┌─ Engine seam (the production contract) ───────▼──────────────┐
│  normalizeCatalog()  →  runChecks(ALL_CHECKS, ctx)            │ ← we are here
│  packages/catalog-core        packages/catalog-checks         │
└───────────────────────────┬───────────────────────────────────┘
                            │ fed a hand-built fixture instead of live Shopify data
┌─ Eval layer ────────────────▼─────────────────────────────────┐
│  app/test/eval-fixtures.test.ts                                │
│  15-product / 17-variant golden set → asserts exact findings   │
└─────────────────────────────────────────────────────────────┘
```

You already know what a unit test is: call a function, assert on the return value. An eval set is the same shape wearing different clothes — instead of one hand-picked input/output pair, it's a *curated collection* of them, chosen because together they cover the space of things that could go wrong. The question an eval set answers isn't "does this one case work" — it's "do I have enough of the right cases to trust a regression didn't sneak past me."

There are three flavors of eval set, and this repo has a real, working example of exactly one of them. Golden set is the one worth learning in full here — `app/test/eval-fixtures.test.ts` is a textbook instance of it, hand-built and running today via `npm run eval`. The other two — adversarial and regression — get taught as general knowledge, with an honest accounting of what this repo does and doesn't have.

## Structure pass

**Layers:** three bands, same as the zoom-out — worker (`runner.server.ts`), engine seam (`normalizeCatalog` → `runChecks`), eval (`eval-fixtures.test.ts`). The eval sits *beside* the worker, not inside it — both call the identical seam, but one calls it with live Shopify GraphQL data and the other calls it with a hand-built fixture.

**Axis to trace: where does "ground truth" live?**

```
One axis — "who says what the right answer is?" — across the three layers

┌─ Worker ───────────┐   seam    ┌─ Engine ───────────┐
│ no opinion on       │ ═══╪═══► │ CODE decides        │
│ correctness — just  │           │ (10 deterministic   │
│ calls the seam and  │           │  checks, MG-001..010)│
│ persists whatever    │           │                     │
│ comes back           │           │                     │
└─────────────────────┘           └─────────┬───────────┘
                                             │ seam
                                   ┌─ Eval ──▼──────────┐
                                   │ HUMAN decides        │
                                   │ (hand-derived from    │
                                   │  reading each check's │
                                   │  spec — not from       │
                                   │  running the engine)   │
                                   └───────────────────────┘
```

**Seam:** the boundary between "engine computes findings" and "eval judges whether those findings are correct" is the one that matters. On the engine side of that seam, control belongs to code — `runChecks` just executes ten pure functions over a variant list. On the eval side, control belongs to a human who read `mg-002.ts`'s stated behavior (`packages/catalog-checks/src/checks/mg-002.ts`) and wrote down, independently, what it *should* produce for "Below-Cost Tee." That's the axis flip that makes the golden set worth studying: the engine computes, the human judges, and the eval file is where those two answers get compared.

## How it works

### Move 1 — the mental model

You've written a snapshot test before — you run a component once, save its output, and future runs diff against that saved output. A golden set eval feels similar but flips the source of truth: instead of trusting whatever the code produced on some past run, you write down the expected output *first*, by reasoning about the spec, before ever running the code. The pattern is: **curated inputs + independently-derived expected outputs, checked against the real production seam.**

```
The eval-set pattern — three collections, one shared shape

┌────────────────────────────────────────────────────────┐
│  input i  ──────►  [ system under test ]  ──────►  actual(i) │
│                                                          │
│  expected(i)  ◄──── derived independently, NOT from a run │
│                                                          │
│  assert:  actual(i) == expected(i)   for every i in the set │
└────────────────────────────────────────────────────────┘

  golden set:      i chosen to represent "the normal/important cases"
  adversarial set:  i chosen to break the system (malformed, extreme, hostile)
  regression set:   i chosen because a specific past bug lived here
```

### Move 2 — the three set types, one at a time

**Golden set — "this is the right answer," small, high-signal, hand-curated.**

A golden set is a small collection of examples where you're confident enough in the expected output to treat it as ground truth. Small is a feature, not a limitation — every row earns its place because someone reasoned about it, not because a script generated it. That's exactly what `app/test/eval-fixtures.test.ts` is.

Walk the file's own shape. Lines 1–32 are a header comment that states the eval's contract in plain language: this is a "SEAM-LEVEL eval" that feeds a fixture catalog through `normalizeCatalog -> runChecks` — "the same two calls the worker uses in production" — and checks the resulting findings against an "INDEPENDENTLY-SPECIFIED expected set."

```
eval-fixtures.test.ts — fixture table, one row per edge case
(lines ~85–243 build the fixtures; lines ~272–310 pair them with expectations)

┌────────────────────────────┬────────────────────────────────────┐
│ fixture (label)             │ what edge case it exercises         │
├────────────────────────────┼────────────────────────────────────┤
│ Below-Cost Tee (BC-001)     │ price < unitCost           → mg-002 │
│ Thin-Margin Mug (TM-001)    │ margin below threshold      → mg-003│
│ Free Sample (FS-001)        │ price = 0.00                → mg-001│
│ Bad-Sale Hoodie (BS-001)    │ compareAtPrice < price       → mg-004│
│ No-Discount Cap (ND-001)    │ compareAtPrice = price       → mg-004│
│ Shared SKU A / B             │ same SKU, whitespace variant → mg-005, mg-009│
│ Dup Barcode X / Y             │ same barcode, two products   → mg-006│
│ Tracked No-SKU                │ tracked, sku = null           → mg-007│
│ Variant-Outlier (S/M/L)        │ 3 variants, one price outlier → mg-008 on L only│
│ Missing-Cost Item              │ unitCost = null                → mg-010 (UNAVAILABLE)│
│ Draft Zero-Price                │ DRAFT status, price 0           → no findings│
│ Archived Below-Cost              │ ARCHIVED status, below cost      → mg-002 still fires│
│ Café ☕ "Ünïcode", Tee            │ unicode/CSV-hostile title        → mg-002 still fires│
└────────────────────────────┴────────────────────────────────────┘

15 products / 17 variants total — snapshot.variants.length === 17 (asserted at line 349)
```

Every row in that table is chosen to represent one *kind* of thing that could go wrong — below-cost pricing, a bad sale, a shared SKU, a duplicate barcode, missing cost data, a multi-variant outlier, a unicode-hostile title, non-active statuses. That's the "high-signal" property of a golden set: fifteen products aren't a random sample of a catalog, they're fifteen deliberately different shapes designed to poke at all ten checks (MG-001 through MG-010) at least once, plus a couple of adjacent concerns (does status gate the check or not; does unicode break string handling).

Now the part that makes this a genuine eval and not just a fixture-heavy unit test: **where do the expected values in the `FIXTURES` array (lines 272–310) come from?** The header comment answers this directly — they were "written by reading each `mg-00N.ts` check's stated behavior and reasoning about what it *should* flag for each fixture — NOT by running the engine once and snapshotting whatever came out." Take `mg-002.ts` (`packages/catalog-checks/src/checks/mg-002.ts`, lines 12–14) as the concrete anchor:

```ts
run(ctx) {
  return ctx.variants
    .filter((v) => v.price !== null && v.unitCost !== null)
    .filter((v) => lt(v.price as string, v.unitCost as string))   // price < unitCost
    ...
```

Someone read that filter chain, saw "flags any variant where price is strictly less than unit cost, with both fields present, regardless of product status," and *from that reading* wrote `expected: ["mg-002:CRITICAL"]` for Below-Cost Tee, Archived Below-Cost, and the unicode-title fixture — three separate rows, each independently reasoned about, each landing on the same conclusion because the check has no status gate. That's independent specification: the ground truth exists on paper (in someone's head, reasoning about the spec) before the code ever ran.

**Why independent specification is the whole point.** If you instead ran the engine once, copied its output into the `expected` array, and called that the golden set, the eval would still pass every time — but it would only ever tell you "the code agrees with itself." A regression that changes `mg-002`'s behavior (say, someone adds a status gate that silently excludes archived products) would slip through undetected, because the "expected" value was never independent of the code that produces it. The file's own header names this exact failure mode and warns against it explicitly: "Do not 'fix' a red run here by copying the engine's actual output into the expected table; that defeats the purpose of the eval." That sentence is the single most important line in the file — it's the difference between an eval and a rubber stamp.

**Adversarial set — deliberately hostile or malformed inputs, chosen to break the system. Not present here.**

An adversarial set exists to answer a different question: not "does the system get the normal cases right" but "does the system survive the cases someone would throw at it on purpose or by accident" — negative numbers, empty strings where a number is expected, a 10,000-variant product, a SKU that's just whitespace, a price string that isn't valid decimal. Be precise about this repo: there is no dedicated adversarial fixture file. The closest things to adversarial coverage in `eval-fixtures.test.ts` are incidental — the unicode-title row (`'Café ☕ "Ünïcode", Tee'`, line 239) stress-tests string handling, and the null-SKU / null-unitCost rows (Tracked No-SKU, Missing-Cost Item) stress-test missing-data paths. None of these were chosen with "how do I break this system" as the design goal; they were chosen to exercise a specific check's normal behavior. A real adversarial set would go looking for breakage on purpose — that doesn't exist yet.

**Regression set — cases pinned because a past bug lived there. Only informal coverage here.**

A regression set is built retroactively: something broke in production, you write a fixture that reproduces the exact shape of the bug, and it stays in the suite forever so that bug can never silently come back. That requires a bug to have happened first. Be honest about what this repo has: no dedicated regression-set file, and no fixture rows in `eval-fixtures.test.ts` that are commented as "added after incident X." The unicode-title row and the draft/archived-status rows function *informally* as edge-case regression coverage — if someone later changes status handling and breaks archived-product detection, this suite would catch it — but that's a side effect of good golden-set design, not a formal regression discipline (no changelog linking fixture rows to fixed bugs, no separate regression file).

### Move 3 — the principle

A golden set's value isn't its size, it's the independence of its judgment from the system it's grading. Fifteen fixtures that were reasoned about by hand, checked against the real seam, beat fifty fixtures that were generated by running the code once and snapshotting the result — because the fifty only prove the code agrees with itself, and the fifteen prove the code agrees with the spec. That discipline (small, hand-labeled, independently derived, resistant to "just copy the output" drift) is the transferable skill — it applies whether the system under test is ten deterministic pricing checks or an LLM generating merchant-facing copy.

## Primary diagram

```
Eval set types — one shared shape, three different purposes

┌───────────────────────────────────────────────────────────┐
│              normalizeCatalog → runChecks (the seam)        │
│         packages/catalog-core   packages/catalog-checks      │
└───────────────────────────┬─────────────────────────────────┘
                            │ same seam, three different fixture sources
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────────┐
│  GOLDEN SET     │   │ ADVERSARIAL   │   │  REGRESSION SET     │
│  ───────────    │   │ SET           │   │  ──────────────     │
│  eval-fixtures  │   │ ───────────   │   │  not present as a    │
│  .test.ts       │   │ NOT PRESENT   │   │  dedicated file;      │
│  15 products /  │   │ no fuzzed /   │   │  informal coverage    │
│  17 variants    │   │ malformed     │   │  only (unicode row,   │
│  independently  │   │ input file    │   │  draft/archived rows) │
│  specified      │   │               │   │                       │
│  ✓ real, run via │   │ ✗ not built    │   │  ✗ not formalized      │
│  `npm run eval`  │   │               │   │                       │
└───────────────┘   └───────────────┘   └───────────────────┘
```

## Elaborate

The golden-set idea predates LLMs by decades — it's the same discipline as a compiler's conformance test suite or a payment processor's test-card table: a small set of cases where the "right answer" is settled by a spec, not by observing the system. What LLM evals borrowed from this tradition is the *shape* (curated inputs, independent ground truth, comparison against the real production path), not the idea itself. The reason golden sets matter more in LLM eval work than they did in classic unit testing is that LLM outputs are non-deterministic and the failure modes are subtler (a plausible-sounding wrong answer, not a stack trace) — so the discipline of writing expectations *before* running the system, and refusing to let a red run become the new expected value, is what keeps the eval honest rather than decorative.

Inside this repo, the natural next step for adversarial coverage is named directly in the Project exercises below — negative prices, absurd variant counts, and malformed decimal strings are exactly the kind of input the current fixture table doesn't cover, and hand-deriving their expected findings the same way this file already does for MG-002 would extend the same discipline rather than invent a new one.

## Project exercises

### Add an adversarial fixture row

- **Exercise ID:** EX-1
- **What to build:** Add one adversarial fixture to `app/test/eval-fixtures.test.ts` (or, if you'd rather keep the golden set uncluttered, a new sibling file `app/test/eval-fixtures-adversarial.test.ts` that imports the same fixture-builder helpers) covering a malformed or extreme input the current 15-product set doesn't touch — a variant with a negative price string (`"-5.00"`), or a single product with 100+ variants to stress `mg-008`'s outlier-detection logic at scale.
- **Why it earns its place:** The golden set is honest about covering "normal edge cases the spec anticipates." Nothing in the current 17 fixtures asks "what happens when the input is actively hostile, not just unusual." That's a real gap, and it's the cheapest one to close because the fixture-builder helpers (`variant()`, `product()`, lines 45–83) already exist — you're adding a row, not building infrastructure.
- **Files to touch:** `app/test/eval-fixtures.test.ts` (or a new `app/test/eval-fixtures-adversarial.test.ts`); read `packages/catalog-checks/src/checks/mg-008.ts` and whichever check your fixture targets before writing the expected value.
- **Done when:** The new fixture's `expected` array was derived by reading the target check's source and reasoning about its behavior — written down *before* running `npm run eval` to see what the engine actually produces — and the test passes because your hand-derived expectation matches, not because you copied the engine's output after the fact.
- **Estimated effort:** 30-60 minutes.

### Start a regression-set discipline

- **Exercise ID:** EX-2
- **What to build:** The next time a check's behavior changes (a bug fix, a threshold tweak, a new edge case discovered in manual QA per §22.4 of the product spec), add a fixture row to `eval-fixtures.test.ts` with a comment naming the bug it pins down — `// regression: mg-003 previously flagged margin exactly at threshold as WARNING; should not fire at exactly 20%` — instead of only fixing the check and moving on.
- **Why it earns its place:** Right now this repo has zero formal regression coverage — no fixture is labeled "this exists because X broke once." A single labeled row establishes the pattern the rest of the team (or future you) can follow, turning "we fixed a bug" into "we fixed a bug and it can't silently come back."
- **Files to touch:** `app/test/eval-fixtures.test.ts`; the specific `packages/catalog-checks/src/checks/mg-00N.ts` file whose behavior changed.
- **Done when:** At least one fixture row exists with an inline comment tracing it to a specific past behavior change, and removing the fix from the check makes that specific test fail (verify this by temporarily reverting the check's logic and confirming the eval goes red).
- **Estimated effort:** 20-40 minutes, assuming a real bug fix triggers it.

## Interview defense

**Q: This app has zero AI in it. Why does a deterministic golden-set eval count as "AI engineering" at all?**

A: The discipline transfers even though the model behind the seam doesn't exist here. What makes `eval-fixtures.test.ts` trustworthy is exactly what makes any LLM eval trustworthy: ground truth that's independently specified (not snapshotted from a run), checked against the real production seam (not a mocked shortcut), and structurally resistant to "fix the red test by copying the actual output" drift. Swap the ten deterministic checks for an LLM generating merchant-facing copy and the eval discipline doesn't change — you'd still want a small hand-labeled set, checked against the real generation path, with expectations a human wrote by reasoning about what's correct, not by running the model once and rubber-stamping it.

```
Same discipline, different system under test

┌─ this repo today ──────────────┐   ┌─ if MerchGrid: Bulk AI adds ─────┐
│ system: 10 deterministic checks │   │ an LLM-generated copy feature      │
│ ground truth: human reads       │   │ ground truth: human reads a rubric  │
│   mg-00N.ts spec, writes         │   │   or writes model examples,          │
│   expected findings by hand      │   │   NOT the model's own output         │
│ checked against: real seam       │   │ checked against: real generation     │
│   (normalizeCatalog→runChecks)   │   │   path (prompt → model → parse)      │
└─────────────────────────────────┘   └───────────────────────────────────┘
        same eval discipline, ported to a different system under test
```

**One-line anchor:** the model is incidental, the eval discipline is the transferable skill.

**Q: Why is a small fixture set (15 products) better than generating hundreds of random test cases?**

A: Because size isn't the metric that matters — signal-per-fixture is. Fifteen fixtures that were each chosen to represent one distinct failure mode (below-cost, bad sale, shared SKU, missing cost, unicode stress) give you full coverage of ten checks with zero redundancy. A generator that spits out five hundred random catalogs would mostly produce near-duplicate cases (products that trip no checks, or the same check twice) while still needing someone to hand-verify what each one *should* produce — the verification cost doesn't shrink just because the input count grows. The golden set's job is coverage of *kinds* of cases, not volume of cases.

**One-line anchor:** a golden set optimizes for coverage-per-fixture, not fixture count.

## See also

- `02-eval-methods.md` — the assertion method this golden set uses (exact match) and where it sits on the broader eval-methods ladder.
- `03-llm-as-judge-bias.md` — the judge-side biases that would matter if this repo ever needed a rubric instead of an exact match.
- `04-llm-observability.md` — what it would take to observe an LLM-backed pipeline the way `npm test` already observes this deterministic one.
