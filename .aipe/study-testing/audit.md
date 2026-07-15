# Testing audit — MerchGrid Catalog Audit

209 tests total: 132 under `app/test/**` (Vitest, real Prisma against
`test.sqlite`) + 83 under `app/packages/*/tests/**` (the pure engine, its own
`vitest.config.ts`) + `npm run eval` (`test/eval-fixtures.test.ts`, also
counted inside the 132 — it's `include`d by the app's own
`test/**/*.test.ts` glob, so `npm test` runs it too; `npm run eval` just runs
it in isolation). Every lens below is walked against the real files, not a
generic checklist.

---

## 1. What is tested and what isn't (the risk map)

The **engine** (`app/packages/catalog-core`, `app/packages/catalog-checks`)
is the most thoroughly tested layer in the repo, and it's also the layer
that decides every dollar amount a merchant sees — that's the right
allocation. Every one of the 10 checks (`mg-001.ts`…`mg-010.ts`) has its own
test file (`app/packages/catalog-checks/tests/mg-00N.test.ts`), plus
`engine.test.ts` running all 10 together to catch cross-check
double-counting or suppression bugs, plus the golden-set eval
(`app/test/eval-fixtures.test.ts`) running the same engine through 17
independently-specified fixtures. `normalizeCatalog` (`packages/catalog-core/
src/normalize.ts`) has 10 tests covering trimming, null-safety, gid
conversion, and admin-URL construction (`app/packages/catalog-core/tests/
normalize.test.ts:47-144`).

The **scan pipeline** (`app/services/scan/runner.server.ts`,
`worker-core.server.ts`, `queue.server.ts`) is tested at the integration
level against a real (test) database — happy path, idempotency, the FAILED
path with message redaction, the missing-settings precondition, and the
variant-limit-truncation `partial` flag (`app/test/scan-runner.test.ts:159-
314`). The livelock/poison-pill scenario — a broken shop's queued scan must
not permanently block a healthy shop's scan — is explicitly tested
(`app/test/worker-core.test.ts:166-215`), which is the kind of test most
teams skip because it requires *building* the failure scenario rather than
hitting it by accident.

**The read side is the weak spot.** `app/routes/app.scans.$id.tsx` (636
lines: a `loader`, `FilterBar`, `FindingDetailModal`, `FindingsTable`, the
default export, and an `ErrorBoundary` — `app/routes/app.scans.$id.tsx:68-
636`) has **zero tests**. Every other route under `app/routes/` is in the
same position — no route-level or component-level test exists anywhere in
the repo. This isn't as bad as it sounds, because the logic those routes
call (`getScanFindings`, `getAllFindingsForExport`, CSV building) is
thoroughly unit/integration tested one layer down — but the wiring itself
(does the loader parse query params into the right filter shape? does the
modal render the right evidence fields for each check?) is unverified.

**Red flag check:** the most important code (the engine) is the *best*
tested, not the least — this repo does not have the classic
important-code-is-untested smell. The gap is UI wiring, which is lower
blast-radius (a broken filter chip degrades the UX; it can't corrupt a
merchant's findings).

→ see `01-golden-set-regression-eval.md` for the deep walk on the engine's
strongest test.

## 2. Test design and levels (the pyramid as-built)

The pyramid here is unusually well-shaped for a two-and-a-half-layer app:

```
        ▲  (none)                 no e2e / browser tests at all
       ╱ ╲
      ╱   ╲   ~40 integration     real Prisma + test.sqlite, one process
     ╱─────╲                      boundary (scan pipeline, models, auth
    ╱       ╲                     storage) — app/test/*.test.ts
   ╱─────────╲
  ╱           ╲ ~170 unit         pure functions: checks, money, csv,
 ╱─────────────╲                  normalize, state transitions
```

There is no over-mocked-unit-tests smell: the "integration" tests
(`scan-runner.test.ts`, `worker-core.test.ts`, `scan-api.test.ts`,
`scan-queue.test.ts`, `models.test.ts`, `shop.test.ts`, `settings.test.ts`,
`uninstall.test.ts`, `compliance.test.ts`, `encrypted-session-storage.test.ts`)
run against a **real** Prisma client and a real (test) SQLite file — nothing
here is testing a mock's behavior instead of the code's. The only thing
faked at that layer is the Shopify Admin GraphQL client itself
(`AdminGraphqlClient`), which is the actual external-network seam and the
correct place to fake (see `03-fake-admin-graphql-seam.md`).

The "unit" layer is genuinely unit-shaped too: `mg-00N.test.ts` files call
`mg00N.run(ctx)` directly with hand-built `NormalizedVariant` fixtures
(`app/packages/catalog-checks/tests/_fixtures.ts:4-23`) — no framework, no
I/O, no mocking required because there's nothing to mock.

**The one missing rung is e2e/route-level.** Nothing drives a request
through a Remix `loader`/`action` and asserts on the rendered response. For
a read-only reporting app this is a lower-stakes gap than it would be for a
write path, but it means the filter/pagination/export *wiring* in
`app.scans.$id.tsx` and the `api.scans.*` routes is unverified end-to-end —
only its ingredients are.

→ see `03-fake-admin-graphql-seam.md` for how the one real external
dependency is isolated correctly.

## 3. Tests as design pressure (untestable code as a design smell)

This is the strongest evidence in the repo that the design earns its test
suite rather than fighting it. Two examples of *intentional* seams built
specifically so a piece of logic could be tested in isolation:

- **`worker-core.server.ts` exists only to be testable.** The comment at
  `app/services/scan/worker-core.server.ts:1-14` says it directly: the real
  worker entrypoint (`app/worker.ts`) needs live Shopify OAuth env vars just
  to import `shopify.server`, which throws under Vitest without them. So the
  actual queue-draining logic (`claimAndRunNext`) was pulled into a
  standalone, env-free module that takes an `AdminFactory` function instead
  of importing `unauthenticated.admin` directly. `worker.ts` itself is 0%
  covered *by design* — and that's the right call, not a gap, because it's
  now an intentionally-thin adapter with nothing left in it worth testing.
- **`AdminGraphqlClient` is a narrow interface, not the Shopify SDK type.**
  `app/services/shopify/catalog-reader.server.ts:16-21` defines the minimal
  shape the reader actually needs (`graphql(query, options):
  Promise<{json(): Promise<any>}>`), explicitly so tests can hand it a
  same-shaped object with no SDK import at all. This is dependency inversion
  earning its keep: the seam exists because untested-without-it code would
  have been untestable.

One place the design *admits* an untested edge rather than hiding it:
`queue.server.ts:54-62` has an explicit code comment naming a TOCTOU race
("the 'is a scan already active' check and the create below are not
atomic") and choosing to accept it for MVP rather than pretend it's covered.
It isn't tested, and it structurally can't be with the current single-
process assumption — the honest move here is exactly what the comment does:
name the race, name why it's acceptable now, name the fix (a partial unique
index) for when it stops being acceptable. This is a `study-software-design`
finding (deep-modules / explicit tradeoff) as much as a testing one —
cross-linking rather than re-auditing it here.

**Red flag check:** no test in this repo needs elaborate setup to reach the
code under test. The heaviest setup is `test/setup.ts`'s per-file
`beforeEach` table wipe (see `02-sqlite-integration-test-harness.md`), which
is proportional to what integration tests against a real DB require, not
a symptom of tangled code.

## 4. Determinism, isolation, and flakiness

`app/vitest.config.ts:24-25` sets `fileParallelism: false` with an explicit
comment: *"Avoid concurrent `prisma migrate deploy` / sqlite writers racing
against the same test database file."* This is the correct fix for a real
hazard (one shared SQLite file, one test DB) rather than a band-aid — see
`02-sqlite-integration-test-harness.md` for the full mechanism.

Time is injected everywhere it matters instead of read from the wall clock:
`runScan`'s `now` dependency (`app/services/scan/runner.server.ts:14-16,
128`) and `readCatalog`'s `sleep`/`maxRetries` overrides
(`app/services/shopify/catalog-reader.server.ts:31-37`) let
`scan-runner.test.ts` and `catalog-reader.test.ts` assert exact
`detectedAt` values and drive retry/backoff logic (`app/test/catalog-
reader.test.ts:410-457`) without a single real `setTimeout` in the test
run. Randomness the same way: `computeRetryDelayMs`'s jitter
(`catalog-reader.server.ts:176-184`) is never asserted on directly — tests
pass an injected `sleep: async () => {}` and assert on retry *count*, not
timing, which is the right thing to make deterministic and the right thing
to leave alone.

No test in the suite depends on run order (Vitest's per-file isolation plus
the `beforeEach` table wipe in `test/setup.ts:29-33` guarantee each `it`
starts from an empty `Shop`/`Scan`/`Finding`/`ShopSettings`/`ScanArtifact`
table), and no test was found that passes/fails nondeterministically on
rerun.

**Red flag check:** zero flakiness sources found — no bare `setTimeout` in
a test, no un-injected `Date.now()`/`Math.random()` read directly by
assertions, no cross-test shared mutable fixture. This lens is clean.

→ see `02-sqlite-integration-test-harness.md` and `03-fake-admin-graphql-
seam.md` for the two mechanisms that make this possible.

## 5. Edge cases and error paths

Strong coverage here, concentrated at the two places where edge cases carry
real financial or data-integrity risk:

- **Money edge cases**: null cost (`mg-002.test.ts:23-26`), zero price
  (`money.test.ts:50-52`), float-drift-prone subtractions like `0.30 - 0.10`
  (`money.test.ts:36-39`), half-up rounding at a boundary
  (`money.test.ts:79-81`) — see `06-decimal-money-precision-tests.md`.
- **CSV edge cases**: embedded commas/quotes/newlines per RFC 4180
  (`packages/catalog-checks/tests/csv.test.ts:90-107`), unicode passthrough
  (`csv.test.ts:109-115`), `null` rendered as an empty column rather than
  the string `"null"` (`csv.test.ts:117-126`) — the kind of edge case that
  is easy to skip and embarrassing to ship broken.
- **Boundary values on settings**: `it.each([-1, 91, 20.5, NaN])` in
  `app/test/settings.test.ts:33-47` exercises four distinct invalid-input
  shapes (below range, above range, non-integer, not-a-number) in one
  parameterized test, and asserts the *stored* value is untouched on
  rejection — not just that the call throws.
- **Pagination boundary math**: page 2 of a 3-row filtered set with
  `pageSize: 2` (`app/test/scan-api.test.ts:392-417`) proves the slice
  indexes into the *filtered* set, not the full unfiltered table — a
  classic off-by-one class of bug that a happy-path pagination test would
  miss entirely.

The one soft spot: no test asserts behavior for an empty/whitespace-only
`search` string beyond the implicit `.trim()` in `scan-api.server.ts:254`
(a request with `search: "   "` falls through to no filter — untested but
low-risk, easy first addition).

## 6. Testing AI features

`not yet exercised` — correctly so. There is no LLM, no model call, no
non-deterministic output anywhere in this codebase
(`.aipe/project/context.md`: *"Deterministic, not AI... do not add LLM/AI to
the first app (that's the future 'MerchGrid: Bulk AI')"*). Every finding
this system produces is the output of a pure function over normalized data;
"is this good enough" evaluation has no seam to attach to because nothing
here is probabilistic. If the planned future "MerchGrid: Bulk AI" product
introduces a changeset-preflight LLM feature reusing this engine, *that*
product would need `study-ai-engineering`'s eval machinery layered on top —
this codebase, as it stands today, does not.

## 7. Testing red flags — consolidated checklist

| Red flag | Status | Evidence |
|---|---|---|
| Most important code least tested | **Not present** | Engine (the pricing/margin logic) has the deepest coverage in the repo — lens 1. |
| Heavy mocking that tests the mock | **Not present** | Only the Shopify GraphQL client is faked, and it's the actual external boundary — lens 2, `03-fake-admin-graphql-seam.md`. |
| Inverted pyramid (all e2e, slow, flaky) | **Not present** | No e2e layer at all; pyramid is unit-heavy with a solid integration mid-layer — lens 2. |
| Code needs elaborate setup to reach | **Not present** | Setup is proportional (DB wipe for integration tests); the engine needs none — lens 3. |
| Flaky reruns / order-dependent tests | **Not present** | Injected clock/sleep, serialized file execution, per-test table wipe — lens 4. |
| Zero tests on error/exception branches | **Not present** | FAILED-path, precondition-failure, and redaction-of-internal-error-detail are all explicitly tested — lens 1, 5. |
| LLM feature with untested deterministic boundary | **N/A** | No LLM feature exists — lens 6. |
| **Actual gap found** | **Present** | Zero route/component tests anywhere (`app/routes/**`); `app.scans.$id.tsx` (636 lines of loader + UI) is the largest untested file in the repo — lens 1, 2. |
| **Accepted, named risk** | **Present** | `enqueueScan`'s TOCTOU race (`queue.server.ts:54-62`) is explicitly un-tested and explicitly accepted for MVP — lens 3. |

**Verdict:** six of seven classic red flags do not fire in this repo — an
unusually clean result. The two real findings are a route/UI test gap (the
next thing to build, not a crisis) and one explicitly-accepted concurrency
race (already named in a code comment, not hidden). The three highest-
leverage next tests, in order: (1) a loader-level test for
`app.scans.$id.tsx` asserting the filter query-params map to the right
`getScanFindings` call, (2) a test for the empty/whitespace search-string
fall-through named in lens 5, (3) if a second worker process is ever
introduced, an atomic-claim test that would catch the TOCTOU race
reappearing at the queue level.
