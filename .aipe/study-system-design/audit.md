# Audit — system design, 8 lenses

Walks the codebase against the standard system-design lens inventory. Every claim below is grounded in a real file and line range. Where a lens finds nothing, it says so plainly rather than inventing infrastructure this repo doesn't have.

## 1. System map and boundaries

Three real components, one datastore, one external provider:

- **Remix web process** (`app/app/routes/*.tsx`, served by `remix-serve` per `app/start-production.js:85`) — the request/response boundary. Everything under `routes/` runs here: onboarding (`app._index.tsx`), the results UI (`app.scans.$id.tsx`), settings (`app.settings.tsx`), the scan-trigger and read APIs (`api.scans.tsx`, `api.scans.$id.tsx`, `api.scans.$id.export.tsx`), OAuth (`auth.$.tsx`), and three webhook receivers.
- **Worker process** (`app/worker.ts`) — no inbound HTTP at all. Started as a sibling process by `start-production.js:86` (`node build/worker.js`). Runs a 5-second poll loop (`app/worker.ts:25,69-89`) that drains the `Scan` table.
- **Engine** (`app/packages/catalog-core`, `app/packages/catalog-checks`) — pure functions, zero I/O, imported by both processes but owning no runtime lifecycle of its own. See `03-engine-app-boundary.md`.
- **SQLite** (`app/prisma/schema.prisma`) — the single datastore, on one Fly volume mounted at `/data` (`app/fly.toml:31-33`). No Redis, no separate queue broker, no cache layer.
- **Shopify Admin GraphQL API** — the one external dependency, reached only from the worker via `readCatalog` (`app/app/services/shopify/catalog-reader.server.ts:400-452`), scoped to `read_products,read_inventory` only (context.md's must-not-change constraints — no write scope exists anywhere in the app).

Trust boundaries:
- **Merchant ↔ Remix**: App Bridge session-token JWT, verified by `authenticate.admin(request)` at the top of every authenticated loader/action (e.g. `app/app/routes/app.scans.$id.tsx:69`, `app/app/routes/api.scans.tsx:13`).
- **Remix/worker ↔ Shopify**: OAuth, offline access tokens. The worker obtains its client with no inbound request via `unauthenticated.admin(shopDomain)` (`app/worker.ts:19,28`) — see `01-single-worker-db-queue.md` for why that's safe here and where it would break.
- **App ↔ database**: encrypted at the session-token layer only (`04-encrypted-token-at-rest.md`); everything else in SQLite is plaintext by design (no PII beyond Shopify shop domain and product/variant data the merchant already owns).

`not yet exercised`: no API gateway, no reverse proxy beyond Fly's own edge, no service mesh — this is a two-process monolith, not a service-oriented system.

## 2. Request/response and data flow

Three flows matter; each crosses the worker/web boundary through the `Scan` row, not through a direct call.

**Trigger a scan** — synchronous, fast: `api.scans.tsx:12-30` action → `startScan` (`scan-api.server.ts:130-135`) → `enqueueScan` (`queue.server.ts:44-78`), which inserts a `QUEUED` row and returns `202` immediately. No waiting on Shopify here.

**Run a scan** — asynchronous, on the worker: `worker.ts`'s poll loop calls `claimAndRunNext` (`worker-core.server.ts:30-80`), which finds the oldest `QUEUED` row and hands it to `runScan` (`runner.server.ts:59-225`). That function walks `QUEUED → READING_CATALOG → RUNNING_CHECKS → PREPARING_RESULTS → COMPLETED`, calling out to Shopify (`readCatalog`), the engine (`normalizeCatalog`, `runChecks`), and finally persisting via one `$transaction` (`runner.server.ts:187-207`). Full walkthrough: `02-atomic-idempotent-scan-pipeline.md`.

**Read results** — polling, not push: `app.scans.$id.tsx:502-519` re-invokes its own loader every 2.5s via `useRevalidator` until the scan reaches a terminal status. There is no WebSocket, SSE, or webhook telling the browser "your scan is done" — the client just re-asks. `not yet exercised`: any push-based completion notification.

**Export** — a fourth, simpler flow: `api.scans.$id.export.tsx:25-67` calls `getAllFindingsForExport` (gated on `COMPLETED`, `scan-api.server.ts:286-304`) then the pure `buildFindingsCsv` and streams a `Content-Disposition: attachment` response — no background job, computed synchronously in the request.

No fan-out/parallel work anywhere in these flows — everything is a single sequential chain per request. `readCatalog` does paginate (`catalog-reader.server.ts:400-452`) but pages are fetched one at a time, not concurrently.

## 3. State ownership and source of truth

| State | Owner | Where |
|---|---|---|
| Scan progress (`QUEUED`…`COMPLETED`/`FAILED`) | The `Scan` row, mutated only by the worker's `runner.server.ts` | `schema.prisma:59-82`, transitions guarded by `state.ts:40-56` |
| Findings | The `Finding` table, written once per scan (atomically replacing any prior attempt) | `runner.server.ts:187-207` |
| Shop settings (margin %, variant limit) | `ShopSettings` row, edited via `app.settings.tsx`, snapshotted onto each `Scan` at enqueue time (`queue.server.ts:74-76`) so a later settings edit never retroactively changes a scan already run | `schema.prisma:49-57` |
| OAuth tokens | `Session` table, written by `PrismaSessionStorage`/`EncryptedSessionStorage` during `afterAuth` | `shopify.server.ts:17-23,35-42` |
| UI polling/filter state | Ephemeral, client-side (`useState` for the selected finding modal, `useSearchParams` for filters) | `app.scans.$id.tsx:223-231,506-519` |
| URL as state | Filter params (`severity`, `checkId`, `q`, `page`) live in the URL, not client memory, so a shared link reproduces the same filtered view | `app.scans.$id.tsx:68-119,383-400` |

Server is the single source of truth for everything that matters (scan state, findings, settings). No client-side cache of server state beyond what Remix's loader naturally holds between polls — a revalidate always re-reads the database.

## 4. Caching and invalidation

`not yet exercised`. There is no cache layer anywhere in this system — no Redis, no in-memory LRU, no HTTP cache headers set intentionally on the data routes, no memoization of Shopify GraphQL responses. Every read (`getScanSummary`, `getScanFindings`, `getAllFindingsForExport`) hits SQLite directly on every call (`scan-api.server.ts:161-304`). The 2.5s UI poll (`app.scans.$id.tsx:513-517`) is the closest thing to a caching *concern* in this system, and it's handled by re-querying, not by caching+invalidating. For a single-tenant-per-request, low-QPS embedded admin app this is a reasonable choice, not an oversight — see `audit.md` → lens 7 for where it would start to matter.

## 5. Storage choice and durability boundaries

One datastore for everything: SQLite via Prisma, one file, one Fly volume (`fly.toml:26-33`). Why SQLite and not Postgres: this is a single-writer workload (one worker process, see `06-single-machine-shared-volume.md`) with no need for concurrent writers across machines, and SQLite-on-a-volume avoids running a separate DB service for an app whose entire dataset is "the merchant's own findings," which is cheap to regenerate. `context.md`'s "Known deferred" section confirms this tradeoff explicitly: Litestream backups are "intentionally skipped (data is regenerable; volume has daily snapshots)" — durability is deliberately looser than a typical production database, because the data itself is a disposable audit artifact, not a system of record a merchant depends on existing.

Durability guarantees that do matter:
- **Atomicity of a scan's result set** — `runner.server.ts:187-207` wraps delete-old-findings + insert-new-findings + mark-COMPLETED in one `$transaction`, so a crash mid-write can never leave stale or duplicate findings, or a `COMPLETED` scan with no findings behind it. See `02-atomic-idempotent-scan-pipeline.md`.
- **Encryption at rest for OAuth tokens** — `SESSION_ENCRYPTION_KEY` must never rotate once set (context.md), because rotation would orphan every stored token and force every merchant to reinstall. See `04-encrypted-token-at-rest.md`.
- **GDPR-bounded retention** — `webhooks.app.uninstalled.tsx:17-20` explicitly retains `Scan`/`Finding` rows after uninstall; only `webhooks.compliance.tsx`'s `SHOP_REDACT` case (`redactShop`, `shop.server.ts:49-51`) cascades a real delete, ~48h later per Shopify's own webhook timing.

Cross-link: SQLite's own transaction/locking mechanics belong to `study-database-systems`; the `Finding` table's denormalization choices belong to `study-data-modeling`.

## 6. Failure handling and reliability

- **Upstream throttling** — `catalog-reader.server.ts:175-241` retries a `THROTTLED` GraphQL error or a rejected `admin.graphql()` call with exponential backoff + full jitter, capped at 4 retries / 8s max delay by default. A genuine query error (bad field, bad argument) is *not* retried — it fails immediately (`runQuery`, same file, lines 226-237).
- **Partial catalogs** — a soft `variantLimit` guardrail (`catalog-reader.server.ts:378-452`) truncates a catalog that's too large rather than failing the scan outright; the resulting `Scan.partial` flag surfaces to the merchant as a banner (`app.scans.$id.tsx:558-563`).
- **Pipeline failure-safety** — any exception during `runScan` is caught, logged server-side with full detail, and turned into a generic `FAILED` status with a non-leaking message (`runner.server.ts:208-224`) — the spec's explicit "no internal leakage to end users" requirement.
- **Poison-pill scans** — if a shop uninstalled between being queued and being claimed, `unauthenticated.admin()` throws; `worker-core.server.ts:44-75` catches that specifically, marks *that* scan `FAILED`, and returns its id — otherwise the same broken row would be re-selected forever (global oldest-`QUEUED`-first) and no other shop's scan could ever run. This is a real, named failure mode with a real fix, not a hypothetical.
- **Worker-loop resilience** — a bad scan must never kill the whole worker: `worker.ts:71-78` catches per-iteration and keeps polling.
- **Process-level failure** — `start-production.js:105-122`: if either the web or worker child process dies unexpectedly, the supervisor kills the other and exits non-zero, so Fly restarts the whole machine (migrations rerun, both processes come back together) rather than the two processes drifting out of sync.

`not yet exercised`: circuit breakers, bulkheads, or a dead-letter queue for scans that fail repeatedly (a scan that fails is simply `FAILED`; the merchant must manually retry by starting a new scan — there's no automatic retry-with-backoff at the scan level, only inside a single `readCatalog` call).

## 7. Scale bottlenecks and evolution

What breaks first at 10x merchants: the single global poll loop. `claimAndRunNext` selects "the oldest `QUEUED` scan across all shops" (`worker-core.server.ts:34-38`) with exactly one worker process consuming it — the code comments this explicitly as a "single-worker model" that is "intentionally not an atomic claim-then-lock" (`worker-core.server.ts:22-28`). At 10x scan volume, scans queue up serially behind each other regardless of shop; at 100x, the SQLite single-writer file becomes the second bottleneck (one process, one file, no read replicas).

What stays stable: the request/response side (Remix reads scale with SQLite's read throughput, which is fine for an admin-panel access pattern), and the engine (`normalizeCatalog`/`runChecks` are pure, in-memory, per-scan — no shared state to contend over).

What would force rearchitecture: adding a second worker process. The code names its own future failure mode — `worker-core.server.ts:22-28` says a second worker needs "an atomic conditional update (`UPDATE Scan SET status='READING_CATALOG' WHERE id=? AND status='QUEUED'`, checking the affected-row count)" instead of a plain `findFirst`, or two workers will race and claim the same scan. Similarly, `queue.server.ts:54-62` names a real TOCTOU race in `enqueueScan` itself (check-then-create isn't atomic) that's currently "acceptable for MVP" only because there's a single worker and low concurrency — the fix would be a partial unique index on `(shopId)` where status is non-terminal.

Moving off single-machine-SQLite would also force the deploy topology in `06-single-machine-shared-volume.md` to change — a second machine can't mount the same Fly volume, so scaling the worker or the web tier independently requires a real datastore migration (Postgres) first.

## 8. System-design red flags — ranked

1. **Single point of queue contention, correctly labeled as such.** The `findFirst`-based claim (`worker-core.server.ts:30-38`) is not a red flag in isolation — for one worker it's correct and simple — but it's the first thing that must change before this app can run two workers. Ranked #1 because it's the most consequential *known, named* limitation in the codebase; the comments already tell you the fix.
2. **TOCTOU race in `enqueueScan`.** Two concurrent trigger requests for the same shop could both pass the "no active scan" check and both insert a `QUEUED` row (`queue.server.ts:54-62`). Low-probability today (one worker, low request concurrency in practice), but it's a correctness gap with a known, cheap fix (a partial unique index) that hasn't been applied.
3. **No push notification for scan completion.** The UI polls every 2.5s (`app.scans.$id.tsx:513-517`) for the entire scan duration, which for a large catalog could be minutes. Not wrong for an MVP, but it's wasted request volume at scale and a UX gap (no notification if the merchant closes the tab).
4. **Durability is deliberately loose, and that's a stated tradeoff, not an oversight.** No Litestream backups (context.md), single SQLite file, single Fly volume, no cross-region replication. Correct given "data is regenerable" — flagged here only so a future reader doesn't mistake it for negligence.

No findings here point to invented risk — every ranked item traces to a real file, a real comment, or a real absence.
