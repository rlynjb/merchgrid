# Audit — non-functional requirements, 8 lenses

MerchGrid: Catalog Audit. Every claim below is grounded in a real file, config
value, or the product spec (`merchgrid-catalog-audit-product-spec.md`). Where a
lens's mechanics are already deep-walked by a sibling guide, this section states
the verdict and cross-links rather than re-teaching. `not yet exercised` is used
plainly wherever a lens finds no evidence — nothing here is invented.

## 1. Functional requirements

Read-only Shopify admin app (scopes `read_products,read_inventory` only, no
write scope anywhere — `.aipe/project/context.md`). Every feature in this list
is backed by real routes, not aspiration:

- **Install** — OAuth via `@shopify/shopify-app-remix`, `afterAuth` → `ensureShop`
  creates `Shop`+`ShopSettings` (`app/app/shopify.server.ts`).
- **Configure** — `app/app/routes/app.settings.tsx` edits `minimumMarginPercent`
  (0–90, default 20) and `catalogVariantLimit` (default 5000), validated in
  `app/app/models/settings.server.ts:8-20`.
- **Scan** — `app.tsx`'s onboarding action → `enqueueScan` → worker
  `claimAndRunNext` → `runScan` (read → normalize → run 10 checks → persist) →
  `app.scans.$id.tsx` polls results. Full flow: `.aipe/study-system-design/audit.md`
  lens 2.
- **10 deterministic checks** (`app/packages/catalog-checks/src/checks/mg-001.ts`
  … `mg-010.ts`) — pricing, margin, SKU, and barcode problems, each a pure
  function over `NormalizedVariant` data, money math via `decimal.js`
  (`packages/catalog-checks/src/money.ts`) — never floats.
- **Export** — `/api/scans/:id/export` → `getAllFindingsForExport` → engine
  `findingsToCsv`, gated on `COMPLETED` status.
- **Uninstall / GDPR** — `webhooks.app.uninstalled.tsx` marks the shop
  uninstalled (retains data); `webhooks.compliance.tsx` handles all three
  mandatory GDPR topics, cascading a real delete on `SHOP_REDACT`
  (`app/app/models/shop.server.ts:49-51`).

**Drift check against the product spec:** none found. Every FR section this
audit sampled (§8 export, §11 NFRs, §12 data model) matches what the code
actually does — the product spec is not aspirational documentation drifting
ahead of the implementation.

`not yet exercised`: billing (§11.5 lists "billing-state changes, when billing
is introduced" — no billing code exists yet, correctly unbuilt for an MVP);
App Store submission (deferred by choice, `.aipe/project/context.md`).

## 2. Reliability

DDIA 2e Ch 2 framing: hardware faults, software faults, human faults. This
repo's fault tolerance is concentrated at the one genuinely unreliable
dependency — the Shopify Admin API — plus process-level supervision.

- **Upstream retries with backoff + jitter** — `catalog-reader.server.ts:160-241`
  classifies `THROTTLED` GraphQL errors and retries them (4 attempts, 500ms
  base, 8s cap, full jitter); a genuine query error fails immediately, no
  retry wasted on it. Deep walk: `.aipe/study-distributed-systems/02-partial-failure-timeouts-and-retries.md`,
  `.aipe/study-performance-engineering/03-exponential-backoff-with-jitter.md`.
- **Atomic, idempotent persistence** — `runner.server.ts:187-207` wraps
  delete-stale-findings + insert-fresh-findings + mark-`COMPLETED` in one
  `prisma.$transaction`, satisfying the product spec's own reliability
  requirement verbatim (§11.3: "retries must not duplicate findings"; "a
  failed scan must not overwrite the most recent successful report"). Deep
  walk: `.aipe/study-system-design/02-atomic-idempotent-scan-pipeline.md`.
- **Poison-pill containment** — `worker-core.server.ts:44-75` catches the
  specific case of a shop uninstalling while its scan is still `QUEUED`,
  marks that scan `FAILED`, and moves on — without this, one broken shop
  would livelock every other shop's queue forever. Deep walk: this guide's
  `.aipe/study-debugging-observability/03-process-supervision-and-crash-containment.md`
  and `.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md` risk #4.
- **Fail-together process supervision** — `start-production.js:105-122`: if
  either the web or worker child dies, the supervisor kills the sibling and
  exits non-zero, so Fly restarts the whole machine rather than letting the
  two processes drift apart. → `03-always-on-single-machine-availability-cost-bundle.md`.
- **Sanitized failure boundary** — any exception during `runScan` becomes a
  generic, non-leaking `FAILED` status; the real error is logged server-side
  only (`runner.server.ts:208-224`). Deep walk: `.aipe/study-security/05-sanitized-failure-boundary.md`.

**Verdict: meets, with two named and accepted gaps.** `not yet exercised`:
circuit breakers, bulkheads, or a dead-letter distinction for repeatedly
failing scans (a `FAILED` scan just sits `FAILED`; the merchant must
manually retry). The non-atomic single-worker queue claim
(`worker-core.server.ts:22-42`) is *correct* for one worker but is the
single highest-consequence reliability risk in this repo the moment a
second worker is added — ranked #1 in
`.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
and independently in `.aipe/study-database-systems/09-database-systems-red-flags-audit.md`.
→ see `01-documented-tradeoff-as-nfr-governance.md` for why this repo's
version of "gap" is unusually low-risk: the gap is named, in writing, at
the exact call site.

## 3. Scalability

DDIA 2e Ch 2 framing: name the load parameters, then ask what breaks first
as they grow.

**Load parameters this app actually copes with today:**
- Catalog size per scan — bounded by `ShopSettings.catalogVariantLimit`
  (default 5000, `prisma/schema.prisma:54`), read by `readCatalog`
  (`catalog-reader.server.ts:400-452`).
- Findings per scan — bounded implicitly by variant count × 10 checks;
  paginated at read time (`DEFAULT_PAGE_SIZE = 50` / `MAX_PAGE_SIZE = 200`,
  `scan-api.server.ts:27-28`).
- Concurrent scans — **one, globally, across every shop.** `claimAndRunNext`
  (`worker-core.server.ts:30-79`) claims exactly one `QUEUED` row per poll,
  and there is exactly one worker process (`worker.ts`).

**What breaks first:** the single global poll loop. At 10x merchants, scans
queue up serially behind each other regardless of shop; the code names this
itself as a "single-worker model" that is "intentionally not an atomic
claim-then-lock" (`worker-core.server.ts:22-28`). Full mechanism + what a
second worker would require: `.aipe/study-system-design/audit.md` lens 7,
`.aipe/study-system-design/01-single-worker-db-queue.md`.

**What stays stable:** the read side — Remix reads scale with SQLite's read
throughput, which is fine for an admin-panel access pattern
(`.aipe/study-performance-engineering/02-sql-side-pagination-and-severity-index.md`),
and the engine (`normalizeCatalog`/`runChecks`) is pure, in-memory, O(checks × n)
per scan with no shared state to contend over
(`.aipe/study-performance-engineering/04-linear-time-grouped-checks.md`).

**Verdict: meets-partially — a real, named, unmeasured ceiling.** The
guardrails (`catalogVariantLimit`, `MAX_PAGE_SIZE`) bound cost per unit of
work correctly; they do not establish where the *system-wide* ceiling
actually sits, because no load test has ever been run
(`.aipe/study-performance-engineering/audit.md` lens 2). → see
`02-structural-budgets-without-slos.md` for the pattern these guardrails
share across scalability, latency, and cost.

## 4. Maintainability

DDIA 2e's three sub-attributes, each addressed separately.

**Operability.** Deployability is a single supervised entrypoint
(`start-production.js`: run `prisma migrate deploy`, then start web + worker
on one Fly machine — `DEPLOY.md`); a health check gates traffic
(`app/app/routes/healthz.tsx:6-9`, `fly.toml:33-38`) but deliberately checks
only "is Remix serving," not "is the worker draining the queue" — a named,
intentional blind spot (see lens 7). No on-call rotation or paging exists
(reasonable for a single-operator MVP); no runbook exists for "a scan is
stuck" beyond test-file comments and this guide
(`.aipe/study-debugging-observability/audit.md` lens 7).

**Simplicity.** Owned in full by `.aipe/study-software-design/audit.md`.
Verdict there: change amplification is low and deliberately so (a new check
touches 3 files, `04-check-registry-pattern.md`); the one real cognitive-load
hotspot is `runScan` (`runner.server.ts:59-225`, five concerns in one
166-line function); two information leaks are named (the variant→`Finding`
field list known in two places, and the triple-duplicated
`CATALOG_API_VERSION`). This audit does not re-walk those findings — cross-link
only.

**Evolvability.** Schema migrations are disciplined: additive changes use
native SQLite `ADD COLUMN`; changes needing `NOT NULL`-with-no-default use
SQLite's full-table-rebuild pattern with a real, verified SQL backfill for
`severityRank`/`searchText`
(`.aipe/study-data-modeling/05-migrations-and-evolution.md`). The gap named
there: no down-migrations exist for any of the five migrations, and the
`severityRank` backfill SQL and `severity.ts`'s `SEVERITY_RANK` map encode
the identical mapping through two independent, unsynced code paths. DDIA
Ch 5 (encoding/evolution) maps directly onto this finding — schema evolution
here is forward-only by design, accepted because tables are small and data
is regenerable (see lens 6).

**Verdict: meets, with named leaks — none of them urgent.** The dominant
maintainability trait, visible across every sibling audit, is that this
repo's engineers write down *why* a shortcut is safe at the exact call site
it's taken, rather than either fixing everything preemptively or leaving
the shortcut silent. → `01-documented-tradeoff-as-nfr-governance.md` is the
full walk of this pattern, because it is this repo's single strongest
maintainability trait and its most repeated NFR-governance style.

## 5. Latency and performance budgets

The product spec writes three targets in prose, §11.2
(`merchgrid-catalog-audit-product-spec.md:848-856`):

1. Dashboard loads within 2 seconds under normal conditions, excluding
   active scan processing.
2. A 500-variant catalog completes in a "merchant-acceptable period" —
   deliberately unquantified: "Exact scan-time promises should not appear in
   the listing until production measurements are available."
3. The findings table stays responsive with at least 5,000 findings
   "through server-side pagination or equivalent techniques."

**Code-level budgets that exist, not just prose:** `catalogVariantLimit`
(default 5000, `prisma/schema.prisma:54`) bounds budget 2's input size;
`MAX_PAGE_SIZE = 200` / `DEFAULT_PAGE_SIZE = 50` (`scan-api.server.ts:27-28`)
backed by `@@index([scanId, severityRank, checkId])`
(`prisma/schema.prisma:124`) backs budget 3; `POLL_MS = 5000`
(`worker.ts:25`) caps queue-pickup latency at up to 5s whenever the queue is
empty — an unwritten but real fourth budget. Full mechanism for each:
`.aipe/study-performance-engineering/01-bounded-catalog-read.md`,
`02-sql-side-pagination-and-severity-index.md`.

**Verdict: not yet exercised as measured targets.** Budgets 1 and 2 have no
code checking them at all — no assertion, no monitor, nothing that would
fail a deploy or fire an alert if a dashboard load actually took 6 seconds.
Budget 3 has a real, correct mechanism behind it (SQL-side pagination + a
covering index), but "responsive" was never defined as a number, and no
load test or profiler has ever run against any of these targets
(`.aipe/study-performance-engineering/audit.md` lenses 1–3). This is
labeled honestly, not softened: the guardrails are real; the SLOs they're
meant to protect are unwritten and unmeasured. → `02-structural-budgets-without-slos.md`.

## 6. Availability, security, and privacy

**Availability.** One always-on Fly machine (`fly.toml:38-43`:
`auto_stop_machines = false`, `min_machines_running = 1`) running both web
and worker, backed by one SQLite volume — a genuine single point of failure,
stated as a deliberate tradeoff, not discovered as a surprise
(`.aipe/study-system-design/06-single-machine-shared-volume.md`,
`.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
risk #3). No redundancy, no failover region, no second machine — a crash in
either process takes down both (supervisor design, lens 2 above). →
`03-always-on-single-machine-availability-cost-bundle.md`.

**Security.** Fully owned by `.aipe/study-security/audit.md` — cross-linking
rather than re-auditing. Verdict there: trust boundaries and authz are
solid (per-shop tenant isolation on every read, anti-enumeration on
cross-tenant probes, session tokens AES-256-GCM-encrypted at rest); three
low-severity, non-critical fires (an unchecked webhook payload cast, CSV
formula-injection not defused, one stale doc claim). Nothing critical or
high-severity in the app's own code.

**Privacy / compliance.** GDPR's three mandatory webhook topics are all
handled (`webhooks.compliance.tsx:12-26`): `CUSTOMERS_DATA_REQUEST` and
`CUSTOMERS_REDACT` correctly no-op (this app stores no customer PII at
all — only shop/product data the merchant already owns);
`SHOP_REDACT` cascades a real delete (`redactShop`,
`app/app/models/shop.server.ts:49-51`) fired ~48h after uninstall. Data
minimization is explicit: `Finding` rows persist only the per-variant
fields the UI/CSV need, never the whole catalog snapshot
(`prisma/schema.prisma:107-122`, comment: "Deliberately NOT the whole
catalog"). → `04-gdpr-bounded-retention-and-regenerable-durability.md`
walks why this repo's privacy posture (delete fast on request) and its
durability posture (no backup, data is regenerable) are two sides of the
same underlying call: this data isn't precious, but it is sensitive enough
to require prompt deletion.

**Verdict: meets-partially.** Security and privacy both pass cleanly.
Availability is the one open ceiling — accepted, named, and load-bearing
for why the deploy topology looks the way it does.

## 7. Observability and cost

**Observability.** Fully owned by
`.aipe/study-debugging-observability/audit.md` — cross-linking rather than
re-auditing. Verdict there: the `Scan` row's own stage timestamps and status
enum function as a coarse, persisted substitute for a trace
(`01-scan-state-machine-audit-trail.md`); every log line is a plain
`console.log`/`console.error` string with no structured/JSON logging, and
only the worker's failure path carries a correlation prefix
(`` `[scan:${scanId}]` ``, `runner.server.ts:213`) — the web-request path has
zero log lines at all. `not yet exercised`: metrics, SLIs, SLOs, alerts, and
distributed tracing — none exist (`prom-client`, StatsD, OpenTelemetry: zero
hits in `package.json`'s dependencies). `/healthz` deliberately checks only
"is Remix serving," not "is the worker draining the queue" — a live
diagnostic blind spot if the worker's loop ever deadlocked without crashing.
The product spec's own §11.5 promises exactly the metrics that don't exist
yet: scan duration, catalog size processed, API/check/export failure counts
— written down as a requirement, not yet built as instrumentation.

**Cost.** No cost-per-request or cost-per-shop instrumentation exists
anywhere in this codebase — `not yet exercised` as measured data. What's
provable structurally: the always-on machine (`fly.toml:41-43`) is a fixed
cost floor, not a request-shaped one, because the worker has to keep
polling even with zero HTTP traffic
(`.aipe/study-performance-engineering/audit.md` lens 1). Based on Fly's
published pricing for the smallest shared-cpu-1x machine class plus a 1GB
volume (`fly volumes create data --size 1`, `fly.toml`'s own comment) — the
smallest paid tiers Fly offers for an always-on machine — this deploy costs
on the rough order of **$2–3/month**. This figure is an inference from Fly's
public pricing table, not a billed amount observed in this repo; no invoice,
Fly usage dashboard export, or cost-tracking code exists to confirm it.

**Verdict: gap-with-evidence.** Both halves of "you can't manage what you
can't measure" are genuinely missing. This is the single most consequential
NFR gap in the whole audit because it blocks *verifying* every other lens's
"meets" verdict — see lens 8, finding #1.

## 8. Non-functional-requirements red-flags audit — ranked

Consequence-ordered, pulling the highest-cost finding from each lens above
into one list. None of these are invented risk — every one traces to a real
file, a real config value, or a real absence already named in this guide or
a sibling's.

1. **No metrics, SLOs, or traces anywhere — every other NFR verdict in this
   guide is unverifiable, not just unmeasured.** The product spec writes
   latency targets (§11.2) and observability requirements (§11.5) in prose;
   zero code checks either. This is the highest-leverage gap because fixing
   it is a prerequisite for validating every "meets" verdict above the
   observability line — reliability, scalability, and latency are all
   currently reasoned about by reading code, not by watching a dashboard.
   `.aipe/study-debugging-observability/audit.md` lens 8, finding #3;
   `.aipe/study-performance-engineering/audit.md` lens 2.
2. **The non-atomic single-worker queue claim is simultaneously the #1
   reliability risk and the #1 scalability ceiling** — `worker-core.server.ts:22-42`.
   Correct today (one worker); the first thing that silently breaks
   (duplicate processing, racing writes) the day a second worker is
   introduced without also introducing an atomic conditional update.
   Independently ranked #1 by both
   `.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
   and `.aipe/study-database-systems/09-database-systems-red-flags-audit.md`
   (the latter finds the underlying query is also an unbounded, growing
   full-table scan — `worker-core.server.ts:34-38` — a second, compounding
   reason this specific seam is the highest-priority fix in two entirely
   separate guides).
3. **Availability has a deliberate, single point of failure with no
   redundancy** (`fly.toml:1-8`, one machine, one SQLite volume, fail-together
   supervisor). Accepted and named, not a surprise — but it's the real
   ceiling on this app's uptime story, and no failover path or backup
   machine exists to shorten a real outage's duration.
4. **Durability has an accepted, unmeasured data-loss window** — no
   Litestream, Fly's own daily volume snapshots are the only recovery path,
   any write since the last snapshot is gone if the volume is lost. Ranked
   below #2 and #3 specifically because — unlike them — this is the most
   thoroughly reasoned-about, explicitly-accepted finding in the entire
   codebase, stated in two independent places
   (`app/DEPLOY.md`'s "Known caveats", `.aipe/project/context.md`'s "Known
   deferred"). Severity is the highest in this list (total data loss); rank
   is lower because it already got the attention a red flag is supposed to
   earn. `.aipe/study-database-systems/09-database-systems-red-flags-audit.md`
   finding #5 makes the identical ranking call independently.
5. **Cost is entirely uninstrumented.** No code anywhere ties a request, a
   scan, or a shop to a dollar figure — the always-on machine is a fixed,
   unmeasured floor (~$2–3/month, inferred from Fly's pricing, not observed).
   Low urgency at current scale (one merchant's worth of always-on compute
   is cheap); becomes the first thing worth instrumenting the moment a
   second Fly machine, a paid tier, or usage-based billing enters the
   picture (§11.5's own "billing-state changes, when billing is introduced").

**What this repo meets by accident, worth naming as a landmine:** the
single-worker assumption is the mitigation behind *three* separate,
independently-discovered gaps at once — the queue-claim race (#2), the
`enqueueScan` TOCTOU race (`queue.server.ts:54-62`, named and accepted in
every sibling audit that touched it), and the missing index on
`Scan.status`. All three are safe today for the identical, unstated reason:
exactly one worker, one writer. Whoever adds a second worker needs to know
they're crossing all three seams at once, not just the one they were
looking at.
