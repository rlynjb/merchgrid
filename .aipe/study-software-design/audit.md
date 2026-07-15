# Audit — MerchGrid: Catalog Audit against the AOSD lenses

Pass 1 of 2. Eight lenses, each walked against the real files. `not yet
exercised` is used honestly where the codebase is too small or too young to
show a lens yet — this is a ~30-file MVP, not a ten-year system, and some
lenses simply don't have much to bite on. Where a finding is deep enough to
earn its own walkthrough, this file names it and points at the Pass 2 file
rather than re-explaining it.

---

## 1. Complexity in this codebase

The diagnostic overview. Three symptoms to hunt: change amplification (one
conceptual change touches many files), cognitive load (the module that
takes real concentration to hold in your head), and unknown unknowns (code
where you can't tell what you need to know before changing it safely).

**Change amplification — low, and it's deliberately low.** Adding check
MG-011 touches exactly three files: a new `checks/mg-011.ts`, one export
line in `catalog-checks/src/index.ts`, and one array entry in
`catalog-checks/src/run.ts` (`app/packages/catalog-checks/src/run.ts:13-24`).
No caller of `runChecks` (`run.ts:26-28`) changes. → see
`04-check-registry-pattern.md` for the deep walk on why this stays cheap.

**Cognitive load hotspot — `runScan`,
`app/app/services/scan/runner.server.ts:59-225`.** This is the single
densest function in the repo: it owns state-machine transitions, a Shopify
GraphQL read, normalization, check execution, Finding-row denormalization
(lines 144-180), and the atomic persist-or-fail boundary (lines 182-224),
all in one 166-line function. It reads linearly and every step is commented,
so it's dense rather than tangled — but it's the one file where a change
("also fail the scan if X") requires holding the whole pipeline in your
head at once, because the function does not delegate any of its five
concerns to a sub-function. Praise where it's due: the try/catch at the
outer edge (lines 85-224) is exactly the "define errors out of existence"
move — see lens 6.

**Unknown-unknowns hotspot — pagination truncation,
`app/app/services/shopify/catalog-reader.server.ts`.** Whether a scan ends
up `partial: true` depends on three functions agreeing:
`fetchAllVariants` (lines 309-344) sets `truncated` when a single product's
variant pages exceed the remaining budget, `buildProduct` (lines 351-376)
forwards that flag, and `readCatalog` (lines 400-452) ORs it against
`moreProductsInThisPage` and `pageInfo.hasNextPage` (line 442) to decide the
catalog-wide `partial` bit. A future change to any one of the three without
checking the other two can silently produce a scan marked complete
(`partial: false`) that actually truncated. Nothing is broken today — the
current wiring is correct and tested (`test/catalog-reader.test.ts`) — but
this is the spot in the repo where "what do I need to know before I touch
this" has the highest true answer.

**The three highest-cost hotspots, ranked:**
1. `runner.server.ts:59-225` (`runScan`) — cognitive load, one function, five concerns.
2. `catalog-reader.server.ts` truncation logic (309-452) — unknown-unknowns, three functions must agree.
3. The variant→Finding field list, duplicated across `runner.server.ts:144-180` and `scan-api.server.ts:170-218` — see lens 3.

---

## 2. Deep vs. shallow modules

Depth = functionality ÷ interface size. The best modules in this repo hide a
real amount of decision-making behind a tiny surface; the worst force a
caller to fabricate data just to satisfy a signature.

**Deepest — `app/packages/catalog-checks/src/money.ts` (56 lines, 10
exported functions).** The interface is nine one-line comparison/arithmetic
functions (`lt`, `lte`, `eq`, `gt`, `sub`, `mul`, `median`, `marginAmount`,
`marginPercent`) plus `formatMoney`. Behind that flat interface sits every
decimal.js call in the codebase — no other file imports `decimal.js`
directly (verified: `money.ts` is the only importer). All ten checks and
both `scan-api.server.ts` and `export.server.ts` compare and format money
exclusively through this module. Strip it out and the concrete capability
lost is precise, float-free money comparison everywhere prices are checked
— the exact bug class the project's "money is decimal, never floats"
constraint exists to prevent. → see `01-decimal-money-boundary.md`.

Runner-up: `app/app/services/scan/state.ts` — two functions
(`isTerminal`, `assertTransition`, lines 30-56) hide the entire legal
scan-transition graph; every caller (`runner.server.ts`) just calls
`assertTransition(currentStatus, "READING_CATALOG")` and never sees the
transition table itself. → see `02-scan-state-machine.md`.

**Shallowest — `CsvRowInput`, `app/packages/catalog-checks/src/csv.ts:5-8`,
as consumed by `app/app/services/scan/export.server.ts:15-59`.**
`CsvRowInput` demands a full `CatalogFinding` (10 fields) and a full
`NormalizedVariant` (14 fields), but `rowFields`
(`csv.ts:50-85`) reads only 4 finding fields (`severity`, `checkId`,
`title`, `explanation`) and 12 variant fields — it never touches
`finding.shopId`, `finding.productId`, `finding.detectedAt`,
`finding.evidence`, `variant.shopId`, `variant.displayName`,
`variant.tracksInventory`, `variant.inventoryPolicy`, or
`variant.inventoryQuantity`. Because the interface is wider than what's
used, the one caller that doesn't already have real `CatalogFinding`/
`NormalizedVariant` objects — `buildFindingsCsv`
(`export.server.ts:20-56`) — has to **fabricate** values for fields the
CSV writer never reads: `shopId: ""` (twice), `tracksInventory: false`,
`displayName: row.variantTitle ?? row.productTitle`. None of those four
lines do real work; they exist only to satisfy a type the function doesn't
need in full. The fix: give `csv.ts` its own narrow row type — the dozen
fields `rowFields` actually reads — and have `buildFindingsCsv` map
`FindingRow` onto that directly, with no placeholder fields at all. This
was still a reasonable call at the time: `CsvRowInput` was probably shaped
to match the engine's own types so the CSV writer looked reusable from
inside `catalog-checks` too — but the one real caller lives in the host app
and pays the interface tax on every call.

---

## 3. Information hiding and leakage

**Leak 1 — the variant→Finding denormalized field list, known in two
places.** `runScan` (`runner.server.ts:144-180`) decides which
`NormalizedVariant` fields get copied onto a persisted `Finding` row
(`price`, `compareAtPrice`, `unitCost`, `currencyCode`, `sku`, `barcode`,
`productStatus`) — the comment at 145-148 explains why (CSV export and the
finding-detail UI need these self-contained, since the whole catalog isn't
retained). `toFindingRow` (`scan-api.server.ts:170-218`) has to know the
exact same field list to read it back out and additionally re-derive
`hasMarginInputs` (line 190) and recompute `marginAmount`/`marginPercent`
(lines 211-216) from the raw stored strings. Add an eighth denormalized
field and both functions (plus the Prisma schema) need a coordinated edit —
three files carrying one decision. Not yet a bug; it is the definition of
"a fact needed in two places," which is exactly the leak this lens hunts
for.

**Leak 2 — `CATALOG_API_VERSION`, explicitly self-documented as
triple-duplicated.** `app/app/config.ts:19` sets the constant, and the
comment directly above it (lines 13-17) says it must be kept in sync with
`api_version` in `shopify.app.toml` and `ApiVersion.July26` in
`shopify.server.ts:28,53`. This is the rare leak the codebase already
confesses to in a comment rather than one this audit had to find — three
independent files must agree on one string, with no compiler or runtime
check enforcing it. Low cost today (this is an infrequently-changed value,
and it's since been correctly kept in sync across all three), but it's a
manual invariant, not a hidden one.

**Leak 3 (minor) — the CSV `COLUMNS` array and `rowFields`'s return
array are coupled by position, not by name.** `csv.ts:15-36` declares 20
column headers in order; `rowFields` (`csv.ts:50-85`) returns a 20-element
array that must line up 1:1 by index. Reorder one without the other and
every value silently shifts one column right — TypeScript's array typing
can't catch a transposition here because both sides are just `string[]`.
Both arrays are short and colocated (35 lines apart in one file), which
keeps the actual risk low, but it's a second knowledge-in-two-places
pattern worth naming since it's the same shape as Leak 1 at smaller scale.

**A genuinely well-hidden decision, named because praise is a finding
too:** which `SessionStorage` implementation gets used (plaintext vs.
AES-256-GCM) is decided in exactly one place —
`app/app/shopify.server.ts:18-23` — behind a decorator whose constructor
signature (`EncryptedSessionStorage`, `encrypted-session-storage.server.ts:21-24`)
looks identical to the thing it wraps. No caller of `shopify.sessionStorage`
anywhere else in the app knows or cares which one is live. → see
`03-encrypted-session-storage-decorator.md`.

---

## 4. Layers and abstractions

**Pass-through re-exports — accepted, not a defect.**
`app/app/shopify.server.ts:54-59` re-exports `authenticate`,
`unauthenticated`, `login`, `registerWebhooks`, `sessionStorage` as direct
1:1 pass-throughs of `shopify.X`. That's the `@shopify/shopify-app-remix`
template's own shape — every Remix route in the repo imports from
`../shopify.server` rather than reaching for the `shopify` object directly,
so the pass-through is the seam that lets the app swap the underlying
`shopifyApp()` config without touching 12 route files. Naming it because
the lens asks for it, not because it's worth removing.

**A layer that earns its place — the API routes are thin on purpose.**
`app/app/routes/api.scans.tsx:12-30` and
`app/app/routes/api.scans.$id.export.tsx:25-67` do real work (map
domain errors to HTTP status codes: `ActiveScanError` → 409,
`ScanNotFoundError` → 404, `ScanNotCompletedError` → 409) rather than
being pure forwarding — each route is the one place that translates a
service-layer exception into a wire-level status. This is the opposite of
a wasted layer: strip it out and every route would leak a raw 500 for a
completely ordinary "a scan is already running" condition. → see
`05-tenant-safe-error-collapsing.md` for the deeper pattern this feeds.

**No adjacent-layer duplication found.** There's no case in this repo of
two layers offering the same abstraction to the same caller — the
engine/app/deploy split (per `.aipe/project/context.md`) is a clean single
staircase, not a system with redundant rungs.

---

## 5. Pull complexity downward

**Exposed knob, justified — `RunScanDeps` (`now`, `catalogMaxRetries`,
`catalogSleep`), `runner.server.ts:14-26`.** `runScan`'s public signature
carries three parameters that exist purely so tests can inject a
deterministic clock and skip real backoff timers — the doc comment
(lines 15-26) says so directly: "production callers should omit these."
This is exactly the red flag's shape (a knob pushed up to the caller that
the module could in principle own itself), but the alternative — a DI
container, or a test-only subclass — is more machinery than a
10-route MVP needs. The cost is honest: every non-test caller of `runScan`
sees three parameters it will never set. The same shape repeats one layer
down in `readCatalog`'s `ReadCatalogOptions.maxRetries`/`sleep`
(`catalog-reader.server.ts:23-37`), for the identical reason.

**A knob that's correctly NOT pulled down —
`ShopSettings.catalogVariantLimit`.** `readCatalog` requires
`variantLimit` as a required option (`catalog-reader.server.ts:24-25`)
rather than defaulting it internally, because the module genuinely cannot
know a merchant's configured limit — that's owned by `ShopSettings` and
correctly lives one layer up. This is the counter-example that makes the
`RunScanDeps` case legible: some knobs belong at the caller because the
callee lacks the information; `RunScanDeps` doesn't have that excuse, it's
a test seam wearing a production parameter's clothes.

---

## 6. Errors and special cases

**Special cases eliminated by design — the standout of this lens.**
`runScan`'s single try/catch wrapping the entire pipeline
(`runner.server.ts:85-224`) collapses what could have been four separate
error-handling sites (read failure, normalize failure, check failure,
persist failure) into exactly two outcomes: full success (the atomic
`$transaction`, lines 187-207) or one `FAILED` status with one generic,
non-leaking message (lines 213-223). No caller of `runScan` ever has to
distinguish *which* step failed — that distinction is deliberately erased,
and the real error is still captured (`console.error`, line 213) for
operators. This is Ousterhout's "define errors out of existence" applied
correctly: the special case (partial failure) doesn't get a bespoke path,
it gets consumed by the general one.

**Special cases eliminated for security, not just convenience —**
`ScanNotFoundError` is deliberately thrown for three distinct conditions —
unknown scan id, scan belongs to another shop, unknown shop domain
(`scan-api.server.ts:14, 100-120`) — collapsing what would otherwise be
three distinguishable error paths into one, specifically so a caller
probing another tenant's scan ids learns nothing. → see
`05-tenant-safe-error-collapsing.md`.

**Minor special-case sprawl — the retry loop in `runQuery`,
`catalog-reader.server.ts:200-241`.** Two near-identical retry blocks
exist 15 lines apart: the `catch` around the network call (lines 213-224,
"retry it like a throttle") and the `if (body?.errors...)` branch
(lines 226-237, throttled-error retry). Both do the same
`attempt < maxRetries → sleep(computeRetryDelayMs(attempt)); attempt += 1;
continue` — the sleep-and-increment logic is duplicated rather than
factored into one `shouldRetry`/`retry()` helper. Low cost (one function,
40 lines, well-tested), but it's the one place in the repo where the same
recovery logic is written out twice instead of named once.

---

## 7. Readability — names, comments, consistency, obviousness

**Names — a genuine strength, grepped rather than asserted.** A sweep for
vague names (`data`, `obj`, `tmp`, `manager`, generic `helper`/`utils`)
across `catalog-checks/src`, `catalog-core/src`, and `app/services` turns
up nothing except idiomatic Prisma `data:` keys and GraphQL response
destructuring (`(data) => data.products`) — both conventional to their
libraries, not vague application names. Every domain function name states
its effect precisely: `assertTransition`, `claimAndRunNext`,
`buildFindingsCsv`, `marginPercent`, `normalizeSku`. No renaming fix to
propose here.

**Comments — the standout facet.** The codebase consistently uses
comments to carry *why*, not *what*: the TOCTOU race explicitly accepted
in `queue.server.ts:54-62`, the "poison-pill guard" in
`worker-core.server.ts:47-75` explaining a livelock this exact code
prevents, the single-worker-model non-atomicity note in
`worker-core.server.ts:22-29`, and the CATALOG_API_VERSION sync note
(`config.ts:13-17`, lens 3). These are the comments a reader actually
needs — a fact the code alone can't carry — and there's no comment in the
files read for this audit that merely restates the line below it.

**Consistency — one convention, held throughout.** Every server-only
module ends in `.server.ts` (enforced by the Remix convention and
followed without exception in the files read); every check file follows
the identical `CHECK_ID` constant → `CatalogCheck` object → `findingFor`
call shape across all ten `mg-0NN.ts` files with zero structural drift.

**Obviousness — one small "huh?" spot.** `severityToRank`
(`app/app/services/scan/severity.ts:23-25`) silently defaults an
unrecognized severity string to the *lowest* sort rank
(`SEVERITY_RANK.UNAVAILABLE`) rather than throwing. Today this can't
actually happen — `FindingSeverity` is a closed union and every check
constructs its findings through `findingFor`, which only accepts that
union — so the fallback is dead code guarding against a state the type
system already prevents. It's not a bug, but a reader hits a genuine
pause here wondering what production condition it's defending against;
a one-line comment ("defensive: satisfies `string` params from stored
DB rows, which aren't statically narrowed") would remove the "huh?"
without changing behavior.

---

## 8. Red-flags audit — capstone checklist

| Red flag | Fires? | Where | Fix (one line) |
|---|---|---|---|
| Shallow module / classitis | **Fires** | `CsvRowInput` (`csv.ts:5-8`) vs. what `rowFields` reads | Narrow `CsvRowInput` to the ~12 fields actually used; see `audit.md` lens 2 |
| Information leakage | **Fires (x2)** | variant→Finding field list (`runner.server.ts:144-180` / `scan-api.server.ts:170-218`); `CATALOG_API_VERSION` triple (`config.ts:13-19`, `shopify.server.ts:28,53`) | Compute margin once at persist time and store it; add a single-source version constant checked at startup |
| Temporal decomposition | Not found | — | — |
| Overexposed implementation | Not found | — | — |
| Pass-through method/variable | **Fires, accepted** | `shopify.server.ts:54-59` re-exports | Framework-imposed shape; not worth removing |
| Repetition (same knowledge, two call sites) | **Fires (minor)** | CSV `COLUMNS`/`rowFields` positional coupling (`csv.ts:15-36` / `50-85`) | Zip columns to a keyed row object instead of two parallel arrays |
| Special-case sprawl | **Fires (minor)** | duplicated retry-and-sleep logic (`catalog-reader.server.ts:213-224` / `226-237`) | Extract one `retryOn(predicate)` helper |
| Avoidable config exposed to callers | **Fires, justified** | `RunScanDeps` (`runner.server.ts:14-26`), `ReadCatalogOptions` (`catalog-reader.server.ts:23-37`) | Test-only seam; acceptable at this scale, revisit if a DI pattern is ever introduced |
| Non-obvious code | **Fires (trivial)** | `severityToRank`'s silent fallback (`severity.ts:23-25`) | Add a one-line defensive-fallback comment |
| Comments that restate code | Not found | — | — |
| Generic container names (Manager/Helper/Util doing everything) | Not found | — | — |
| Dependency on concrete type instead of interface | Not found | `AdminGraphqlClient` (`catalog-reader.server.ts:16-21`) is a real minimal port | — |

**Sorted by cost to this repo, highest first:** (1) the variant→Finding
field-list leak — grows with every new denormalized field; (2) the
`CsvRowInput` shallow interface — grows every time `buildFindingsCsv` is
touched; (3) everything else on this list is a one-line fix or an accepted
tradeoff, not a live risk.
