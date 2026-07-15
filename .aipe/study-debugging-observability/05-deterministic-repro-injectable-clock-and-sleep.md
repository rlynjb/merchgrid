# Injectable clock and sleep for deterministic reproduction

**Dependency injection applied to time (injectable clock / fake
timer)** — Language-agnostic pattern, project-specific implementation
(`RunScanDeps.now`/`catalogSleep` in `runner.server.ts`,
`ReadCatalogOptions.maxRetries`/`sleep` in `catalog-reader.server.ts`).

## Zoom out, then zoom in

Here's the problem this solves: retry/backoff on Shopify's throttling
can wait up to 8 seconds per attempt, up to 4 attempts — worst case,
over 30 seconds of real wall-clock time to prove a single retry-exhaustion
test. And a finding's `detectedAt` timestamp comes from `new Date()` —
call it twice in two different test runs and you get two different
values, which makes "does this test reproduce the same failure every
time" an actual question instead of a given. This repo's answer: push
both — "what time is it" and "how long do we wait" — behind an optional
parameter at the exact call site that needs them, so tests can control
both without touching a single global.

```
  Zoom out — where the injectable seam sits

  ┌─ Test layer (vitest) ─────────────────────────────────────────┐
  │  FIXED_NOW constant, instant fake sleep functions               │
  └───────────────────────────┬───────────────────────────────────┘
                              │  optional deps parameter
  ┌─ Service layer ★ THIS CONCEPT ★ ─▼───────────────────────────────┐
  │  runner.server.ts: RunScanDeps { now?, catalogSleep?, ... }       │
  │  catalog-reader.server.ts: ReadCatalogOptions { sleep?, maxRetries? } │
  └───────────────────────────┬───────────────────────────────────┘
                              │  deps omitted entirely
  ┌─ Production (worker.ts) ──▼───────────────────────────────────┐
  │  defaultNowIso() / defaultSleep() — real Date, real setTimeout   │
  └─────────────────────────────────────────────────────────────────┘
```

Same idea as passing a fake `Date.now` or mocking `setTimeout` in any
test that would otherwise depend on wall-clock time — done here as an
explicit, typed, optional parameter rather than a global mock, so a
test never has to touch a timer it doesn't own.

## The structure pass

**Axis: control — who decides what "now" is, and how long a wait
takes?** The seam is the optional-parameter boundary itself:

```
  Control axis flips exactly at the `deps?` boundary

  ┌─ test side ─────────────────┐  seam   ┌─ production side ─────────┐
  │  test SUPPLIES now/sleep     │ ══╪══► │  worker.ts supplies NOTHING │
  │  → deterministic, instant     │        │  → defaultNowIso/defaultSleep│
  └──────────────────────────────┘        └─────────────────────────────┘
         ▲                                          ▲
         └── same function, two answers to ─────────┘
             "who controls time here?"
```

This is a seam worth studying because the axis genuinely flips: on one
side of `deps?`, time is an external input a test dictates; on the
other, it reverts to whatever the module's own defaults say. Production
never has to know the seam exists — it just never passes a `deps`
object (`app/app/services/scan/worker-core.server.ts:77`,
`await runScan(scan.id, admin, deps)`, where `deps` is only ever
supplied by tests calling `claimAndRunNext` directly).

## How it works

**Move 1 — the mental model.** Anything that reads the wall clock or
waits on a real timer is untestable by default. Instead of mocking
`Date`/`setTimeout` globally — which leaks across parallel test files
and hides which functions actually depend on time — this repo makes
the dependency visible in the function's own signature: an optional
`now`/`sleep` parameter, defaulted to the real thing.

```
  Pattern — default path vs injected path, same function

  function runScan(scanId, admin, deps?: RunScanDeps) {
    now = deps?.now ?? defaultNowIso        // real clock unless overridden
    sleep = deps?.catalogSleep ?? realSleep // real timer unless overridden
  }
```

**Move 2 — the walkthrough.**

**Part 1 — `RunScanDeps` names exactly what's injectable, and why.**
`app/app/services/scan/runner.server.ts:14-26` defines three optional
fields: `now`, `catalogMaxRetries`, `catalogSleep`. The doc comment is
precise about scope: `now` is "used only for finding `detectedAt`
values, so tests are deterministic" (line 15) — it isn't a general
clock override, it's scoped to the one field that needs it.
`defaultNowIso()` (`runner.server.ts:28-30`) is the real ISO-8601
clock production always gets. What breaks if this weren't injectable:
a test asserting on a specific `detectedAt` value would be flaky,
correct only if the assertion happened to run within the same
millisecond as the code under test — effectively untestable.

**Part 2 — the same shape one layer down, for retry/backoff.**
`ReadCatalogOptions.maxRetries`/`sleep`
(`app/app/services/shopify/catalog-reader.server.ts:23-37`), resolved
by `resolveRetryPolicy` (`catalog-reader.server.ts:168-173`) against
`defaultSleep` (`catalog-reader.server.ts:164-166`, a real
`setTimeout`-based promise). Production's real retry policy uses
exponential backoff with jitter, capped at 8 seconds
(`computeRetryDelayMs`, `catalog-reader.server.ts:176-184`):

```
  Execution trace — retry-exhaustion path, real vs test timing

  attempt   real backoff (uncapped formula)   test override
  ───────   ──────────────────────────────    ─────────────
  0         500ms * 2^0 = 500ms                sleep() resolves instantly
  1         500ms * 2^1 = 1000ms                     "
  2         500ms * 2^2 = 2000ms                     "
  3         500ms * 2^3 = 4000ms                     "
  4         500ms * 2^4 = 8000ms (capped)             "
  → exceeds maxRetries (default 4) → throw the safe, sanitized error
    (see 02-safe-failure-messaging.md)

  worst-case real wall-clock cost to exhaust: ~500+1000+2000+4000+8000
  ≈ 15.5s (before jitter) — near-ZERO in a test with sleep injected
```

**Part 3 — production explicitly opts out, rather than being a special
case.** `runScan`'s catalog-read call only spreads
`deps?.catalogMaxRetries`/`deps?.catalogSleep` into the options object
`if` they're present (`app/app/services/scan/runner.server.ts:103-109`).
`worker.ts` — the only real production caller — never constructs a
`deps` object at all. That's the actual point of this pattern: the
injectable seam exists, but production code never has to think about
it or route around it. The default path *is* the production path, not
a fallback bolted on for tests.

**Part 4 — the reproduction payoff, made concrete.** A specific,
previously-flaky scenario becomes byte-for-byte reproducible forever:
`app/test/scan-runner.test.ts:6` fixes
`FIXED_NOW = "2026-07-14T00:00:00.000Z"` and passes it as `deps.now`,
so a below-cost variant's `detectedAt` is the exact same value on every
CI run, on every machine, regardless of when the test actually
executes. Combined with an injected `sleep` that resolves instantly
(`app/test/scan-runner.test.ts` fake-admin setup around lines 97-120),
the entire retry-exhaustion path — which would take real seconds in
production — runs in test time near zero, and produces the exact same
assertions every single run.

**Move 3 — the principle.** Push time and delay behind an injectable
seam at the *exact call site* that needs it, not behind a global
monkeypatch. Production pays nothing for the seam's existence; tests
get full determinism and full speed, and the function's own signature
documents which of its behaviors are time-dependent in the first
place.

## Primary diagram

```
  Full picture — two injectable seams, same shape, one layer apart

  ┌─ runner.server.ts ───────────────────────────────────────────┐
  │  RunScanDeps.now? → defaultNowIso()  (finding.detectedAt only)  │
  │  RunScanDeps.catalogMaxRetries?/catalogSleep? → passed down     │
  └───────────────────────────┬───────────────────────────────────┘
                              │ forwarded (only if present)
  ┌─ catalog-reader.server.ts ▼───────────────────────────────────┐
  │  ReadCatalogOptions.maxRetries?/sleep?                          │
  │  → resolveRetryPolicy() → defaultSleep() / real exponential      │
  │    backoff with jitter, capped at 8s (computeRetryDelayMs)        │
  └─────────────────────────────────────────────────────────────────┘

  production (worker.ts): NEVER supplies deps → gets real Date + real
  setTimeout, unconditionally. tests: supply deps → deterministic,
  near-instant, byte-for-byte reproducible.
```

## Elaborate

This is the same instinct as ports-and-adapters (hexagonal
architecture) applied narrowly to time instead of an entire subsystem —
comparable to injecting a `Clock` interface in Java, or calling
`vi.useFakeTimers()` globally in a JS test runner. This codebase chose
the narrower, per-call optional-parameter version, which is cheaper to
reason about locally (you can see exactly what's overridable from the
function's own type signature) at the cost of every time-dependent
function needing its own small `deps` parameter rather than one global
switch. That's an accepted, slightly un-DRY cost, named honestly rather
than hidden: there's no single "test mode" flag anywhere in this
codebase, and there doesn't need to be one, because the functions that
actually depend on time are few and each names its own dependency
explicitly.

## Interview defense

**Q: Why not just mock the global `Date`/`setTimeout` in tests
instead of threading an explicit parameter through every function?**
A: A global mock leaks across parallel test files and hides which
functions actually depend on time — you'd have to read the test setup
to know `runScan` cares about the clock at all. The explicit `deps?`
parameter makes the dependency visible in the function's own type
signature; anyone reading `RunScanDeps` immediately knows exactly what
this function's time-dependent behavior is, without reading a single
test.

**Q: What's the worst-case real backoff duration this pattern makes
instantly reproducible in tests?**
A: Walking `computeRetryDelayMs`: base delay 500ms, doubling each
attempt, capped at 8000ms — attempts 0 through 4 sum to roughly
500+1000+2000+4000+8000 ≈ 15.5 seconds before jitter, per catalog
fetch, and that can recur across multiple product-variant pages. In
production that's real wall-clock cost; with `sleep` injected, the
exact same code path — same attempt count, same thrown error — runs in
under a millisecond in tests, every time.

```
  the payoff, drawn

  production                          test (deps.catalogSleep injected)
  ─────────────────────────           ──────────────────────────────────
  attempt 0..4, ~15.5s real wait       attempt 0..4, sleep() resolves now
  same THROTTLED→retry logic           same THROTTLED→retry logic
  same final safe error thrown         same final safe error thrown
```

## See also

- `audit.md` §2 (reproduction-and-evidence)
- `04-golden-eval-regression-guard.md` — the companion mechanism that
  makes check *behavior* reproducible the way this pattern makes
  *timing* reproducible
- `02-safe-failure-messaging.md` — what the retry-exhaustion path
  ultimately throws, and why it's sanitized before it's persisted
