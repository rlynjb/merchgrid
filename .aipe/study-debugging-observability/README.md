# Study — Debugging & Observability (MerchGrid: Catalog Audit)

Read `00-overview.md` first — it's the one-page map and tells you what's
actually here versus `not yet exercised`. Then `audit.md` for the full
8-lens walk. The numbered files are the patterns worth a deep read on
their own; each cross-links back into the lens it belongs to.

## Reading order

1. `00-overview.md` — orientation, ranked findings, what's absent
2. `audit.md` — the 8-lens audit (Pass 1)
3. `01-scan-state-machine-audit-trail.md` — the `Scan.status` FSM as a
   persisted, queryable record of what happened to a run
4. `02-safe-failure-messaging.md` — log the real error, persist/return a
   generic one; the observability-vs-privacy tension, in three places
5. `03-process-supervision-and-crash-containment.md` — the same
   "catch, log, terminate cleanly" shape at three nested altitudes:
   process, poll loop, single scan
6. `04-golden-eval-regression-guard.md` — the eval as this repo's
   primary regression/reproduction tool
7. `05-deterministic-repro-injectable-clock-and-sleep.md` — how time and
   retry delay are made testable without touching global timers

## Cross-links to neighboring guides

- `study-testing` — coverage, isolation, and the eval's design as a
  *test*, not just as a debugging tool. This guide only covers what the
  eval teaches about reproduction and regression prevention.
- `study-performance-engineering` — the retry/backoff numbers in
  `05-deterministic-repro-injectable-clock-and-sleep.md` are about
  reproducibility, not latency budgets; throughput and cost live there.
- `study-security` — `02-safe-failure-messaging.md` touches trust
  boundaries and data minimization; a full security read (secrets,
  authz, encryption at rest) lives in that guide.
