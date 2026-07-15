# Performance Engineering Audit — MerchGrid: Catalog Audit

Eight lenses, walked in order. Each names what the codebase actually does, with `file:line` grounding, or says `not yet exercised` and explains what evidence would fill the gap. Findings significant enough to earn a full mechanism walkthrough cross-link to the matching Pass-2 file.

## 1. Performance budget

The product spec writes three targets in prose (`merchgrid-catalog-audit-product-spec.md:848-856`, §11.2):

1. Dashboard loads within 2 seconds under normal conditions, excluding active scan processing.
2. A 500-variant catalog completes in a "merchant-acceptable period" under normal Shopify API conditions — deliberately unquantified: "Exact scan-time promises should not appear in the listing until production measurements are available" (line 856).
3. The findings table stays responsive with at least 5,000 findings "through server-side pagination or equivalent techniques."

Two design-time proxies enforce budgets 2 and 3 in code, not just prose:

- `ShopSettings.catalogVariantLimit` defaults to `5000` (`app/prisma/schema.prisma:54`) — the merchant-configurable ceiling that bounds how much a single scan can cost, read by `readCatalog` (`app/app/services/shopify/catalog-reader.server.ts:400-452`). → see `01-bounded-catalog-read.md`.
- `DEFAULT_PAGE_SIZE = 50` / `MAX_PAGE_SIZE = 200` (`app/app/services/scan/scan-api.server.ts:27-28`) bound how many findings rows any one request can cost, backing budget 3. → see `02-sql-side-pagination-and-severity-index.md`.

There's also a system-visible cost budget nobody wrote down as a target but that's real: `fly.toml:41-43` sets `auto_stop_machines = false`, `min_machines_running = 1` — an always-on machine, billed continuously, because the worker has to keep polling even with zero HTTP traffic (`fly.toml:38-40`). That's a fixed cost floor, not a request-shaped one. See `.aipe/study-system-design/06-single-machine-shared-volume.md` for why the topology is one machine at all.

**Verdict:** budgets 1 and 2 are prose with no code checking them. Budget 3 has a real mechanism behind it (SQL-side pagination), but "responsive" was never defined as a number and never measured against one.

## 2. Measurement, baselines, and profiling

`not yet exercised.` A repo-wide search for profiling/benchmarking tooling (`performance.now`, `perf_hooks`, `autocannon`, `clinic`, `k6`, `artillery`, `0x`) returns zero hits outside this guide, in either `app/` or `app/packages/`.

The nearest neighbors, and why neither one is a baseline:

- **Golden eval** (`app/test/eval-fixtures.test.ts`, run via `npm run eval`) — 17 fixtures pushed through the real `normalize → runChecks` pipeline, asserting the *findings match*, mutation-verified. It's a correctness suite; it has no timing assertion and no large-N fixture.
- **`app/scripts/seed-fixtures.ts`** — seeds one demo fixture per check (ten small products), sized to demonstrate each check working, not to exercise the 500- or 5,000-variant budgets in §11.2. It's the closest thing to load-test infrastructure the repo has, and it's the wrong size for that job today.

**What a first baseline would need:** (a) extend the seeder (or add a sibling script) to generate a 500-variant and a 5,000-variant fixture set; (b) wrap `runScan`'s phases — `readCatalog`, `normalizeCatalog`, `runChecks`, the persist `$transaction` (`app/app/services/scan/runner.server.ts:59-225`) — in `performance.now()` markers logged per phase; (c) time `getScanFindings` (`scan-api.server.ts:225-275`) at page 1 vs. a late page against a 5,000-row `Finding` table, with and without the composite index, to actually prove `02`'s claim.

## 3. Latency, throughput, and tail behavior

`not yet exercised` as measured data — no p95/p99, no queue-depth metric, no latency histogram anywhere. What *is* provable structurally, by reading the code:

Throughput ceiling: `claimAndRunNext` (`app/app/services/scan/worker-core.server.ts:30-79`) claims and runs **at most one scan globally**, sequentially — there is exactly one worker process (`worker.ts`), so the effective system throughput is one scan in flight at a time across every shop, full stop. A second shop's scan cannot start until the first shop's `readCatalog → normalize → runChecks → persist` pipeline finishes. See `.aipe/study-system-design/01-single-worker-db-queue.md` for the mechanism; this lens only names the consequence — queue depth grows unbounded under multi-tenant concurrent scan requests, with no metric watching it.

Tail-latency source: `readCatalog`'s retry policy (`catalog-reader.server.ts:160-198`) adds up to 4 extra attempts per GraphQL call when Shopify returns `THROTTLED`, each attempt backing off exponentially (base 500ms, capped 8s, full jitter). Under sustained throttling this is the dominant source of variance in how long a scan takes — and it's exactly the kind of tail behavior that's invisible without a captured distribution. → see `03-exponential-backoff-with-jitter.md`.

**Verdict:** the ceiling is real and provable from the code; there is no evidence for where actual latency sits under it.

## 4. CPU, memory, and allocation

- **Money arithmetic is arbitrary-precision, not floats** (`app/packages/catalog-checks/src/money.ts:1-55`, using `decimal.js`) — a deliberate correctness-over-speed tradeoff (see project constraint: "Money is decimal... never floats"). Each `Decimal` comparison/arithmetic call allocates an object instead of touching a machine float; per-variant this stays O(1), but the constant factor is higher than native arithmetic. Named cost, accepted for exactness — a below-cost price finding must never be wrong because of float drift.
- **Catalog memory is bounded, not streamed.** `readCatalog` builds the full (bounded) `RawCatalog` array in memory before `normalizeCatalog` runs (`runner.server.ts:103-123`) — fine at the 5,000-variant default ceiling, but if that ceiling grew by orders of magnitude this would need to become a streaming/chunked pipeline instead of an in-memory array.
- **The check engine is O(checks × n), not O(checks × n²).** `runChecks` (`app/packages/catalog-checks/src/run.ts:26-28`) runs all 10 checks via `.flatMap`, and 4 of them (`mg-005`, `mg-006`, `mg-008`, `mg-009`) group the variant list into buckets with a `Map` (`_helpers.ts:32-48`) instead of comparing every pair. → see `04-linear-time-grouped-checks.md` for the full mechanism and the actual numbers this buys at the 5,000-variant ceiling.

**Verdict:** no GC/allocation profiling has ever been run (no `--prof`, no `clinic doctor`); the complexity-class claims above are provable by reading the code, not by a captured heap snapshot.

## 5. I/O, network, and database bottlenecks

- **Network:** the Shopify Admin GraphQL API is the only external dependency. `catalog-reader.server.ts:41-115` paginates 100 products per page and 100 variants per page — a catalog near the 5,000-variant default ceiling needs on the order of dozens to 100+ round trips minimum before any throttling retries, each one exponentially backed off on `THROTTLED` (`catalog-reader.server.ts:160-198`, see `03`).
- **Database:** SQLite, one file, one writer process (the web server and the worker share the same Fly machine and volume — `fly.toml:1-9`, `DEPLOY.md`). There's no connection pool because there's exactly one process writing; every write serializes at the SQLite/OS layer by construction, not by an explicit lock the app manages.
- **Query shape:** `getScanFindings`/`getAllFindingsForExport` (`scan-api.server.ts:225-304`) push the severity sort and free-text filter into SQL — `orderBy: [{ severityRank: "asc" }, { checkId: "asc" }]` and `where.searchText = { contains: search }` — backed by `@@index([scanId, severityRank, checkId])` (`schema.prisma:124`), instead of loading every `Finding` row for a scan and sorting/filtering in JavaScript. → see `02-sql-side-pagination-and-severity-index.md`.

**Verdict:** no slow-query log, no `EXPLAIN QUERY PLAN` output, no captured round-trip count from a real scan exists in this repo — the I/O shape is inferrable from the code, not measured against it.

## 6. Caching, batching, and backpressure

- **Caching: there is none, anywhere.** No in-memory cache, no Redis, no HTTP cache headers beyond framework defaults. Read this as a *reasoned absence*, not a missing feature: every scan is an on-demand, read-once request for current catalog state — a merchant expects fresh data, and there's no repeated-read hot path (the findings table is read many times per scan, but that's already served by the DB index in `02`, not by an app-level cache). Caching would be solving a problem this workload doesn't have yet.
- **Batching:** persistence collapses what could be dozens to thousands of individual writes into one `prisma.$transaction([...])` call — a `deleteMany`, one `createMany` for every finding row, and the scan-status `update`, all in a single round trip (`runner.server.ts:182-207`). See `.aipe/study-system-design/02-atomic-idempotent-scan-pipeline.md` for why this is atomic (crash safety, idempotency); this lens only names the batching payoff — 1 round trip instead of N.
- **Backpressure:** the system bounds concurrent work at two points instead of fanning it out: `enqueueScan` refuses a second active scan per shop (`queue.server.ts:14-19, 44-68`, `ACTIVE_STATUSES`), and `claimAndRunNext` claims exactly one QUEUED scan globally per poll (`worker-core.server.ts:30-79`). See `.aipe/study-system-design/01-single-worker-db-queue.md` for the mechanism; this lens flags the accepted gap in it — the check-then-create in `enqueueScan` is a documented, non-atomic TOCTOU race under true concurrent requests (`queue.server.ts:54-62`), named in the code's own comment as acceptable "for MVP" given single-worker consumption and per-session request serialization.

**Verdict:** batching and backpressure are real, deliberate mechanisms with code to point at. Caching's absence is a defensible design call, not a gap. The one open risk (the TOCTOU race) is named and accepted, not silently missing.

## 7. Rendering, client, and mobile performance

- The findings page never renders more than `PAGE_SIZE = 50` rows client-side regardless of how many of the (up to) 5,000+ findings exist for a scan (`app/app/routes/app.scans.$id.tsx:41, 101-119`) — because the pagination decision already happened at the DB layer (`02`), the client never has to virtualize or windows-scroll a large list; there's nothing large to render.
- Progress polling is a fixed interval, not adaptive: `useEffect` sets `setInterval(() => revalidator.revalidate(), 2500)` while the scan is non-terminal (`app.scans.$id.tsx:512-519`). Each tick re-runs the whole route loader, but `findingsPage` is only fetched once `summary.status === "COMPLETED"` (`app.scans.$id.tsx:101-110`), so the poll stays cheap during the in-progress state — the fixed 2.5s cadence was never justified against a measured cost, though, just chosen.
- No bundle-size budget, no code-splitting decision, no Lighthouse/Core Web Vitals run exists anywhere in the repo.

**Verdict:** the one rendering decision that matters (never hydrate more than 50 rows) is a load-bearing consequence of lens 5/pattern `02`, not a separate client-side optimization. Everything else in this lens is `not yet exercised`.

## 8. Performance red flags — ranked

1. **No profiling or load test has ever run against either written target in §11.2.** The variant-limit guardrail and the SQL-side pagination are strong, correct-by-construction designs — neither has a captured before/after number. Highest-leverage fix: generate a 5,000-variant fixture set and time `runScan`'s phases (see lens 2).
2. **The single-Fly-machine / single-SQLite-writer topology is a deliberate, documented scale ceiling** (`fly.toml:1-9`, `DEPLOY.md`) — correct for a per-merchant on-demand audit tool today; would need a rearchitected write path (hosted Postgres, a real job queue) before it could serve many shops' concurrent scans at real throughput. Not a bug — a named tradeoff, unmeasured against any actual concurrent-shop load.
3. **`enqueueScan`'s active-scan check is a named, accepted TOCTOU race** (`queue.server.ts:54-62`) — low probability today (single worker, per-session request serialization), but exactly the class of bug a real load test would surface and this repo has never run one.
4. **The worker's fixed 5-second idle poll caps queue-pickup latency at up to 5s** (`worker.ts:25`, `POLL_MS = 5000`) whenever the queue is empty — an accepted, unmeasured latency budget, not a defect.
