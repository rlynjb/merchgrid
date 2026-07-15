# Audit — Debugging & Observability

Repo: MerchGrid: Catalog Audit. One Fly.io machine, Remix web process +
background scan worker, one SQLite volume. Eight lenses, walked in
order. Each names what's actually there (`file:line`) or says
`not yet exercised` — no invented infrastructure.

## 1. observability-map

What can be observed, at each boundary that matters:

- **UI ↔ Route** — `app.scans.$id.tsx` polls its own loader every
  2500ms while the scan is non-terminal
  (`app/app/routes/app.scans.$id.tsx:512-519`), reading whatever the
  `Scan` row currently says. There is no live push channel (no
  WebSocket/SSE) — polling IS the observability transport here.
- **Route ↔ Service** — `scan-api.server.ts` (`getScanSummary`,
  `getScanFindings`) is the only thing the UI ever queries; it exposes
  `status`, `failureCode`, `failureMessageSafe`, counts, and `partial`
  (see `ScanSummary` interface, `app/app/services/scan/scan-api.server.ts:28-41`).
- **Service ↔ external (Shopify Admin GraphQL)** — `catalog-reader.server.ts`
  is the only place that talks to Shopify; every retry/throttle decision
  happens inside `runQuery` (`app/app/services/shopify/catalog-reader.server.ts:200-241`),
  invisible to everything above it except through timing.
- **Worker ↔ queue** — `worker.ts`'s poll loop (`app/worker.ts:69-92`) and
  `worker-core.server.ts`'s `claimAndRunNext` (`app/app/services/scan/worker-core.server.ts:30-80`)
  are observable only via `console.log`/`console.error` to stdout,
  which Fly captures as `fly logs`.
- **Process ↔ platform** — `start-production.js` supervises both
  children and exits non-zero on either dying
  (`app/start-production.js:105-122`); Fly's machine restart is the
  visible signal an operator sees.
- **Platform ↔ world** — `/healthz` (`app/app/routes/healthz.tsx:10-15`)
  is the only externally-polled signal (Fly's `[[http_service.checks]]`
  in `app/fly.toml:33-38`), and it deliberately checks only "is Remix
  serving," not DB or worker health.

No log aggregator, no APM agent, no metrics exporter anywhere in this
map — `console.*` + the `Scan`/`Finding` tables + `fly logs` is the
entire observable surface. See `01-scan-state-machine-audit-trail.md`
for the deep walk of the most important box in this map.

## 2. reproduction-and-evidence

- **The golden eval** (`app/test/eval-fixtures.test.ts`, run via
  `npm run eval`) is the primary reproduction tool: 17 hand-built
  fixtures pushed through the real `normalizeCatalog → runChecks` seam,
  asserted against independently-derived expectations
  (`app/test/eval-fixtures.test.ts:5-16`). → see
  `04-golden-eval-regression-guard.md`.
- **Injectable clock/sleep** (`RunScanDeps.now`/`catalogSleep`,
  `app/app/services/scan/runner.server.ts:14-26`; `ReadCatalogOptions.maxRetries`/`sleep`,
  `app/app/services/shopify/catalog-reader.server.ts:23-37`) makes
  time-dependent and retry-dependent behavior reproducible without
  waiting on real timers. → see
  `05-deterministic-repro-injectable-clock-and-sleep.md`.
- **Fake admin clients in tests** reproduce realistic upstream failure
  text on purpose, to prove sanitization — e.g.
  `app/test/scan-runner.test.ts:118-120` throws
  `"Shopify GraphQL 500: internal trace id abc-123, table shard 7 unreachable"`
  and asserts it never reaches `failureMessageSafe`
  (`app/test/scan-runner.test.ts:263-264`).
- **`scripts/seed-fixtures.ts`** is the live-QA reproduction path: a
  separate, write-token script seeds a real dev store so the full
  GraphQL-fetch → normalize → checks → export path can be exercised
  end-to-end manually (see the eval file's own docstring,
  `app/test/eval-fixtures.test.ts:17-23`, naming this explicitly as
  out of the eval's scope).
- **Gap**: none of this is written down as a runbook. "How do I
  reproduce a stuck scan" lives in test file comments and tribal
  knowledge of the codebase, not a doc a new engineer could follow
  cold. Named again in lens 7.

## 3. structured-logs-and-correlation

Every log line in this repo is a plain string to `console.log` or
`console.error`. No JSON, no log levels beyond those two, no logging
library:

- `app/start-production.js:62,64,68,71,80,111,130` — all prefixed
  `[supervisor]`.
- `app/worker.ts:56,67,77,91,95` — all prefixed `[worker]`.
- `app/app/services/scan/worker-core.server.ts:60-63` — prefixed
  `[worker-core]`, includes `scan.id` and `scan.shop.shopDomain`.
- `app/app/services/scan/runner.server.ts:213` — prefixed
  `` `[scan:${scanId}]` `` — the closest thing to a correlation ID in
  this codebase, and it only appears on the failure path.
- Webhook routes log topic + shop only, by design:
  `app/app/routes/webhooks.compliance.tsx:8-10`,
  `app/app/routes/webhooks.app.uninstalled.tsx:9`,
  `app/app/routes/webhooks.app.scopes_update.tsx:7`.
- `app/app/entry.server.tsx:45-46` — Remix's own render-error hook,
  `console.error(error)`, no prefix, no request context at all.

`scanId` functions as a natural correlation key (it's the URL param,
the DB primary key, and shows up in the worker's log prefix), but
nothing threads it through the web-request path's logs — there is no
log line at all in `app.scans.$id.tsx`'s loader or `scan-api.server.ts`.
`not yet exercised`: structured/JSON logging, a redaction framework
beyond manual per-callsite discipline, request-ID middleware, log
search/aggregation. → the redaction discipline itself is covered in
`02-safe-failure-messaging.md`.

## 4. metrics-slis-slos-and-alerts

`not yet exercised`. No `prom-client`, no StatsD, no custom
counters/histograms/gauges anywhere in `app/package.json`'s
dependencies or the source tree. No SLO document, no alert
configuration beyond Fly restarting the machine when `/healthz` fails
its check (`app/fly.toml:33-38`). Fly's platform dashboard exposes
ambient per-machine CPU/memory/network graphs, but that's
infrastructure-level telemetry the app never instruments — it's not an
SLI this app defines or reads.

The closest thing to a signal today is a human running `fly logs` or
querying `Scan` rows directly. This becomes worth building the moment
there's more than one worker or concurrent scans across many shops —
`queue.server.ts`'s own comment already names that exact scaling edge
(`app/app/services/scan/queue.server.ts:54-62`, the TOCTOU note): a
queue-depth or scan-duration metric would be the first useful one to
add, because it's the first place a human wouldn't notice a problem by
eyeballing logs.

## 5. traces-and-request-lifecycles

`not yet exercised` in the industry-standard sense — no OpenTelemetry,
no spans, no propagated trace context between the UI, the worker
process, and the Shopify Admin API call.

What exists instead: the `Scan` row's own stage timestamps
(`startedAt`, `completedAt`, `failedAt` —
`app/prisma/schema.prisma:71-75`) plus its `status` enum
(`app/app/services/scan/state.ts:9-15`) function as a coarse, *persisted*
substitute for a trace — one request's lifecycle through four ordered
stages, queryable after the fact. → see
`01-scan-state-machine-audit-trail.md` for the full walk. The UI's
2500ms poll (`app/app/routes/app.scans.$id.tsx:512-519`) is the only
"live" view a user gets of that lifecycle, and it's reading persisted
state, not a real-time trace.

## 6. state-snapshots-and-debugging-boundaries

- **`Scan` row** (`app/prisma/schema.prisma:59-81`) — the primary
  state snapshot: `status`, `failureCode`, `failureMessageSafe`,
  `partial`, processed counts, stage timestamps.
- **`Finding.evidenceJson`** (`app/prisma/schema.prisma:103`) — a
  per-finding evidence blob, `JSON.stringify(f.evidence)` at persist
  time (`app/app/services/scan/runner.server.ts:168`), plus denormalized
  price/cost/SKU/barcode fields copied from the snapshot at scan time
  (`runner.server.ts:171-178`) specifically so a finding is
  self-contained without re-querying Shopify or re-reading the whole
  catalog.
- **`FindingDetailModal`** (`app/app/routes/app.scans.$id.tsx:276-381`)
  is the UI's state-snapshot viewer — it renders exactly the persisted
  fields above, nothing live-fetched.
- **Gap**: no raw-response snapshot is ever persisted for a failure —
  only the generic `failureMessageSafe`. If a merchant reports a scan
  failure, there is no stored artifact of what Shopify actually
  returned; the real detail only ever existed transiently in a
  `console.error` call. → `02-safe-failure-messaging.md` covers why
  that's a deliberate tradeoff, not an oversight.

## 7. incident-analysis-and-prevention

- **Root cause is log-only and time-limited.** The real error is
  `console.error`'d server-side (`runner.server.ts:213`,
  `worker-core.server.ts:60-63`) and nowhere else. Once Fly's log
  retention window passes, root cause for an old `FAILED` scan is gone
  except for the two-value `failureCode` taxonomy (`SCAN_FAILED`,
  `ADMIN_UNAVAILABLE`). This is the single biggest gap in this audit —
  ranked #1 in lens 8.
- **Regression prevention** is the golden eval plus 132 app tests + 83
  engine tests (per `.aipe/project/context.md`). → see
  `04-golden-eval-regression-guard.md`.
- **A real, coded incident-prevention mechanism**: the poison-pill
  guard in `claimAndRunNext`
  (`app/app/services/scan/worker-core.server.ts:47-75`). The comment
  names the exact incident class it prevents — a shop uninstalls (its
  `Session` row is deleted by the uninstall webhook) while its
  still-QUEUED scan survives; without this guard, the worker would
  re-select that same broken scan forever and no other shop's scan
  would ever run (a livelock). → see
  `03-process-supervision-and-crash-containment.md`.
- **No incident runbook.** `app/DEPLOY.md` covers deploy procedures,
  not "what do I do when a scan is stuck in `RUNNING_CHECKS`" or "the
  worker process isn't consuming the queue." That knowledge currently
  lives only in test comments and this guide.

## 8. debugging-observability-red-flags-audit

Ranked by consequence, verdict first:

1. **No durable error detail past the log-retention window.** Once
   `fly logs` rotate out, a `FAILED` scan from two weeks ago has
   nothing beyond `SCAN_FAILED`/`ADMIN_UNAVAILABLE` to go on. An
   engineer debugging an old merchant ticket has no root cause left to
   read — the detail existed exactly once, in a log line, and then it
   was gone. Evidence: `runner.server.ts:208-224`,
   `worker-core.server.ts:47-75`. Fix-shaped move (not required by this
   audit, just the honest next step): persist the real error to a
   column the UI never renders, not just to stdout.
2. **No structured logs or correlation ID threading a request across
   layers.** The `[scan:${scanId}]` prefix only appears on the
   worker's failure path (`runner.server.ts:213`); the web-request
   path (`app.scans.$id.tsx`'s loader, `scan-api.server.ts`) has zero
   log lines at all. If a merchant reports "the page is broken," there
   is nothing to grep for on the request side.
3. **No metrics or alerting.** The app could be silently failing every
   scan for every shop and the only way anyone finds out is a merchant
   complaining, or an engineer proactively tailing `fly logs`. Fly's
   own health check (lens 1) only proves the process is up, not that
   scans are succeeding.
4. **`/healthz` conflates "process up" with "system healthy."**
   `app/app/routes/healthz.tsx:6-9` deliberately checks only that
   Remix is serving — not that the worker loop is alive or the queue is
   draining. This is named in the file's own comment as intentional
   (Fly needs to distinguish "the process is up" from "the embedded
   app is fully healthy"), so it isn't a bug anyone missed — but it IS
   a live diagnostic blind spot: if the worker's `while` loop ever
   deadlocked (stuck, not crashed), Fly's health check would stay green
   forever while no scan ever completes again.
5. **TOCTOU race in `enqueueScan`** (`queue.server.ts:54-62`, already
   documented in the code's own comment as an accepted MVP-scale gap).
   Not an observability defect on its own, but paired with finding #2
   it means a duplicate-scan incident would show up as an unexplained
   mystery in the logs rather than a named, greppable event.
