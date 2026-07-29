# Structural budgets without SLOs

### Guardrail-as-budget-proxy / capacity limit without an SLI — Industry pattern, Project-specific instances

## Zoom out, then zoom in

```
  Zoom out — where these three constants sit

  ┌─ Config / schema layer ───────────────────────────────────────┐
  │  ShopSettings.catalogVariantLimit = 5000  (prisma/schema.prisma) │
  └───────────────────────┬────────────────────────────────────────┘
  ┌─ Service layer ─────────▼──────────────────────────────────────┐
  │  ★ THESE CONSTANTS ★ — MAX_PAGE_SIZE=200, POLL_MS=5000            │ ← we are here
  │  (scan-api.server.ts, worker.ts) act as budgets nothing measures   │
  └───────────────────────┬────────────────────────────────────────┘
  ┌─ Product spec layer ─────▼──────────────────────────────────────┐
  │  §11.2's unquantified prose targets — 2s dashboard load,           │
  │  "merchant-acceptable" scan time, "responsive" findings table       │
  └────────────────────────────────────────────────────────────────┘
```

Three numeric constants — `catalogVariantLimit`, `MAX_PAGE_SIZE`, and
`POLL_MS` — are the entire latency/scalability/cost governance model of this
app. None of them were derived from a measurement. All three are doing the
job an SLO with a monitored SLI would normally do: bounding a cost so it
can never exceed a known ceiling. The pattern worth naming: **a structural
cap and a measured SLO solve the same problem two very different ways, and
this repo has chosen the cheaper one everywhere, without yet paying for the
measurement half.**

## Structure pass — layers, axis, seams

**Layers:** config value (`catalogVariantLimit`) → service constant
(`MAX_PAGE_SIZE`, `POLL_MS`) → product-spec prose (§11.2's targets).

**The axis: does this budget come from a measurement, or from a
structural guess about "enough headroom"?**

```
  Structural cap vs. measured SLO — same governance goal, different cost

  STRUCTURAL CAP (what this repo has)      MEASURED SLO (what it doesn't have)
  ┌────────────────────────────┐           ┌────────────────────────────┐
  │ "5000 variants ought to be   │           │ "p95 scan time for a         │
  │  enough for most catalogs"    │           │  500-variant catalog is       │
  │  — a guess, chosen once         │           │  47 seconds, alert if it       │
  │                                  │           │  exceeds 90s" — a fact,          │
  │  cost: near-zero to write         │           │  refreshed continuously            │
  │  cost: silently wrong if a          │           │  cost: requires instrumentation, │
  │  real catalog exceeds it              │           │  a metric pipeline, a dashboard    │
  └────────────────────────────┘           └────────────────────────────┘
```

**The seam:** every one of these three constants sits at the exact boundary
between "we bounded the *input* to this operation" and "we know how long
the operation actually takes." Bounding the input is cheap and correct as
far as it goes; it says nothing about whether the bound is generous enough,
because nothing on the other side of that seam has ever been measured.

## How it works

### Move 1 — the mental model

You've set a `maxLength` on a form input before without benchmarking what
happens at that length — you picked a number that felt safely large and
moved on. That's exactly this pattern, applied three times at the system
level instead of once at a form field: pick a structural ceiling that
feels safe, ship it, and defer the question "is this ceiling actually
tight against reality" until later.

```
  Pattern: cap-then-defer

  choose N                          // a number that "feels" safe
  enforce N in code (a limit,        // MAX_PAGE_SIZE, catalogVariantLimit,
    a page size, a poll interval)     // POLL_MS
  ship it
  defer: "is N actually right?"      // no instrumentation exists to
                                      // answer this yet
```

### Move 2 — the three instances, one at a time

**Instance 1 — `catalogVariantLimit` bounds scalability's input size.**
`prisma/schema.prisma:54` defaults it to `5000`; `readCatalog`
(`app/app/services/shopify/catalog-reader.server.ts:400-452`) truncates a
catalog that exceeds it rather than failing the scan outright, surfacing a
`partial: true` banner to the merchant. This is a real, tested, correct
guardrail — full mechanism at
`.aipe/study-performance-engineering/01-bounded-catalog-read.md`. What it
does *not* do: tell you how long a 5000-variant scan actually takes, or
whether 5000 was chosen because 4999 was measured to be safe and 5001
wasn't.

```
  Layers-and-hops — catalogVariantLimit as an input-size budget, not a
  time budget

  ┌─ Merchant setting ──┐  writes                ┌─ Scan ────────────┐
  │  ShopSettings          │ ─────────────────────► │  variantLimit read │
  │  .catalogVariantLimit  │                        │  by readCatalog     │
  └──────────────────────┘                        └─────────┬──────────┘
                                                              │ bounds INPUT SIZE
                                                              ▼
                                                    ┌──────────────────────┐
                                                    │  actual scan DURATION  │
                                                    │  — never measured        │
                                                    └──────────────────────┘
```

**Instance 2 — `MAX_PAGE_SIZE` bounds the findings-table latency budget.**
`scan-api.server.ts:27-28`:
```ts
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
```
Backed by a real composite index (`@@index([scanId, severityRank, checkId])`,
`prisma/schema.prisma:124`) that makes the SQL-side pagination genuinely
fast — full mechanism at
`.aipe/study-performance-engineering/02-sql-side-pagination-and-severity-index.md`.
This is the one instance in this pattern with a real mechanism behind it,
not just a guessed number — but "responsive," the word the product spec
uses (§11.2), was never converted into a millisecond target this cap is
checked against.

**Instance 3 — `POLL_MS` bounds queue-pickup latency.**
`app/worker.ts:25`:
```ts
const POLL_MS = 5000;
```
Every `QUEUED` scan waits up to 5 seconds before the worker even notices it
exists. This is an unwritten budget — it appears nowhere in the product
spec's §11.2 targets — but it's exactly as real a latency contributor as
the two above, and it was chosen the same way: a number that felt fine, not
a number derived from "how fast does a merchant expect their scan to
start."

### Move 2.5 — what's missing to close the loop

None of these three constants have ever been checked against a captured
number. `.aipe/study-performance-engineering/audit.md` lens 2 names the
exact next step: extend `app/scripts/seed-fixtures.ts` (or a sibling
script) to generate 500- and 5,000-variant fixture sets, wrap `runScan`'s
phases in `performance.now()` markers, and time `getScanFindings` at page 1
vs. a late page against a populated `Finding` table. Until that exists,
every one of these three numbers is a structural guess, not a validated
budget.

### Move 3 — the principle

A structural cap and a measured SLO are not competing solutions — they're
sequential ones. The cap is the cheap, correct-by-construction first move
(bound the blast radius before you can measure it precisely); the SLO is
the second move that tells you whether the cap you picked is actually
right. Shipping the first without ever doing the second isn't wrong at MVP
scale — it's incomplete, and the incompleteness compounds silently, because
nothing alerts anyone when the guessed number turns out to be too tight or
too loose.

## Primary diagram

```
  Three constants, one governance model, zero measurement behind any of them

  ┌────────────────────────┬───────────┬──────────────────────────────┐
  │ constant                  │ value      │ NFR it bounds                  │
  ├────────────────────────┼───────────┼──────────────────────────────┤
  │ catalogVariantLimit       │ 5000       │ scalability (input size)        │
  │ MAX_PAGE_SIZE              │ 200        │ latency (findings-table reads)  │
  │ POLL_MS                    │ 5000ms     │ latency (queue-pickup delay)     │
  └────────────────────────┴───────────┴──────────────────────────────┘
                    │
                    ▼
       none derived from a measurement; all three would need
       a captured baseline (perf-eng lens 2) to confirm they're
       actually the right numbers, not just plausible ones
```

## Elaborate

This pattern is common at every startup's MVP stage, and for good reason:
picking a safe-feeling constant costs minutes; building a measurement
pipeline costs days. The industry term for the second half — the missing
half here — is an SLI (service level indicator, the actual measured
number) backing an SLO (the target that number is supposed to stay inside
of). Google's SRE book is the canonical reference for the full discipline
(SLI → SLO → error budget → alerting policy); this repo has none of that
tooling yet, and correctly hasn't needed it at its current, single-merchant-at-a-time
scale. The moment this app needs to promise a merchant "your scan will
finish in under 2 minutes," these three constants stop being sufficient on
their own — they'd need a real SLI behind them.

## Interview defense

**Q: "Is having no SLOs here a mistake?"**
A: Not yet — for a single-worker MVP with per-merchant, on-demand usage,
the structural caps are doing the actual job an SLO would do (bound the
blast radius of a large catalog or a slow read), at a fraction of the
build cost. It becomes a mistake the moment this product needs to make a
quantified promise to a merchant ("scans finish in X"), because none of
these three numbers were derived from a measurement that could back that
promise up.
One-line anchor: *a guessed cap is a fine first move; a promised number
needs a measured one behind it.*

**Q: "Which of these three would you instrument first?"**
A: `catalogVariantLimit`'s downstream effect — actual scan duration at 500
and 5,000 variants — because it's the one the product spec (§11.2) already
writes a target against ("merchant-acceptable period"), and it's the one
with zero mechanism at all checking it today, unlike `MAX_PAGE_SIZE` which
at least has a real index behind it.

## See also

- `audit.md` lens 3 (scalability) and lens 5 (latency and performance
  budgets) — both cite these same three constants from the NFR-verdict
  angle.
- `.aipe/study-performance-engineering/01-bounded-catalog-read.md` — the
  full mechanism behind `catalogVariantLimit`.
- `.aipe/study-performance-engineering/02-sql-side-pagination-and-severity-index.md`
  — the full mechanism behind `MAX_PAGE_SIZE` and its supporting index.
- `.aipe/study-performance-engineering/audit.md` lens 2 — exactly what a
  first baseline measurement would need to build.
