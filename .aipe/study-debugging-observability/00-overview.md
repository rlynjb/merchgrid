# Overview — Debugging & Observability

MerchGrid: Catalog Audit is a read-only Shopify admin app: one Fly.io
machine running a Remix web process and a background scan worker side
by side, sharing one SQLite database. There is no APM vendor, no
structured-log pipeline, and no metrics backend anywhere in this repo —
what you get when something goes wrong is `fly logs`, a handful of
`console.log`/`console.error` calls, and the `Scan` row itself. That's
not a gap this guide papers over; it's the actual shape of the system,
and it's worth understanding *why* it's enough for what this app does
before reaching for more.

```
  Where evidence lives — the whole observability surface

  ┌─ UI (Polaris + Remix) ───────────────────────────────────────────┐
  │  app.scans.$id.tsx — polls every 2500ms while non-terminal        │
  │  (app/app/routes/app.scans.$id.tsx:512-519)                       │
  └───────────────────────────┬────────────────────────────────────┘
                              │ GET (revalidate)
  ┌─ Route / Service layer ───▼────────────────────────────────────┐
  │  scan-api.server.ts getScanSummary/getScanFindings              │
  │  runner.server.ts runScan — state transitions + try/catch       │
  │  worker-core.server.ts claimAndRunNext — poison-pill guard       │
  │  catalog-reader.server.ts — retry/backoff on Shopify throttling  │
  │  console.log/console.error only — no structured logger           │
  └───────────────────────────┬────────────────────────────────────┘
                              │ Prisma
  ┌─ Storage (SQLite) ────────▼────────────────────────────────────┐
  │  Scan row: status, failureCode, failureMessageSafe, partial      │
  │  ← THIS is the state-snapshot / audit-trail story                │
  │  Finding row: evidenceJson (per-finding evidence blob)           │
  └───────────────────────────────────────────────────────────────┘
                              │
  ┌─ Process / Platform (Fly.io) ─────────────────────────────────┐
  │  start-production.js — supervises web+worker, crash-only        │
  │  worker.ts — poll loop, per-iteration try/catch                 │
  │  /healthz — process-up check only, no DB/worker liveness         │
  │  `fly logs` — the only place console output is ever searchable  │
  └───────────────────────────────────────────────────────────────┘
```

## Ranked findings

1. **The `Scan` row is the real observability story here** — status,
   `failureCode`, `failureMessageSafe`, `partial`, and stage timestamps
   persist a coarse but genuinely useful state machine for every scan
   ever run. See `01-scan-state-machine-audit-trail.md`.
2. **Errors are deliberately asymmetric: full detail server-side, a
   fixed generic string everywhere else** — three independent call
   sites (`runner.server.ts`, `worker-core.server.ts`,
   `catalog-reader.server.ts`) apply the same discipline, and
   `webhooks.compliance.tsx` goes one step further and refuses to log a
   PII payload at all. See `02-safe-failure-messaging.md`.
3. **Crash containment is layered, not flat** — a machine-level
   supervisor that intentionally kills a healthy sibling process
   alongside a per-scan poison-pill guard that intentionally does NOT
   crash the worker. Same underlying shape, two altitudes. See
   `03-process-supervision-and-crash-containment.md`.
4. **The golden eval is the primary regression/reproduction tool in
   this repo**, not an afterthought bolted onto CI. See
   `04-golden-eval-regression-guard.md`.
5. **Time and retry delay are pushed behind an injectable seam** so
   retry/backoff and timestamp-dependent behavior are reproducible in
   milliseconds in tests. See
   `05-deterministic-repro-injectable-clock-and-sleep.md`.
6. **The biggest blind spot**: once a machine's log retention window
   passes, a `FAILED` scan's root cause is gone forever except for a
   two-value `failureCode` taxonomy (`SCAN_FAILED` /
   `ADMIN_UNAVAILABLE`). Ranked and explained in
   `audit.md` §8 (debugging-observability-red-flags-audit).

## What's genuinely `not yet exercised`

- **Structured (JSON) logs** — every log line in this repo is a plain
  string passed to `console.log`/`console.error`. No `pino`/`winston`,
  no log levels beyond "log" and "error," no consistent machine-parseable
  fields.
- **Correlation IDs across a request** — `scanId` shows up in some log
  lines (`[scan:${scanId}]`) but nothing threads a single ID through
  the UI-poll → loader → service chain the way a request-ID middleware
  would.
- **Metrics, SLIs/SLOs, alerting** — no `prom-client`, no custom
  counters/histograms, no alert rules beyond Fly restarting the machine
  when the health check fails. Fly's own per-machine CPU/memory graphs
  exist ambiently at the platform level but nothing in this app emits
  to them.
- **Distributed tracing / spans** — no OpenTelemetry, no span
  propagation between the UI, the worker, and the Shopify Admin API.
  The closest analog is the `Scan` row's own stage timestamps — a
  coarse, persisted substitute for a trace, covered in
  `01-scan-state-machine-audit-trail.md`.

These aren't oversights to apologize for — this is a single-tenant-at-a-time,
one-worker, one-machine MVP. The honest engineering call is: add real
metrics/tracing when there's a second worker, concurrent scans across
many shops, or an on-call rotation that needs paging — not before.
`audit.md` names exactly where that line sits for each lens.
