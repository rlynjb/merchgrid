# Overview — Testing & Correctness: MerchGrid Catalog Audit

## The suite at a glance

```
  209 tests, three layers, one honest gap

  ┌─ Engine (pure) ───────────────────────────────────────┐
  │ app/packages/catalog-core, catalog-checks             │  83 tests
  │ 10 checks, normalize, money, csv — each unit-tested,   │  DEEPEST
  │ plus a golden-set eval running all 10 together         │  COVERAGE
  └──────────────────────────┬──────────────────────────────┘
                             │ imported via @merchgrid/* aliases
  ┌─ App services (integration, real test.sqlite) ───────▼┐
  │ scan pipeline, queue, worker-core, scan-api, session   │  ~120 tests
  │ storage, models — real Prisma, faked Shopify client    │  SOLID
  └──────────────────────────┬──────────────────────────────┘
                             │ called by
  ┌─ Routes (Remix loaders/actions + UI) ──────────────────┐
  │ app.scans.$id.tsx (636 lines), app._index.tsx,         │  0 tests
  │ api.scans*.tsx, app.settings.tsx                        │  ← THE GAP
  └──────────────────────────────────────────────────────┘
```

## Coverage map (which areas have tests, which don't)

| Area | Tested? | Depth |
|---|---|---|
| 10 checks (mg-001…mg-010) | Yes | Per-check unit tests + combined engine test + golden-set eval |
| `normalizeCatalog` | Yes | 10 tests: trim, null-safety, gid conversion, admin URL |
| Money/decimal arithmetic | Yes | 16 tests, float-drift and rounding-boundary cases |
| CSV export (engine + app layer) | Yes | RFC 4180 escaping, unicode, null-handling |
| Scan pipeline (`runScan`) | Yes | Happy path, idempotency, FAILED path, precondition failure, partial/truncation |
| Worker queue draining | Yes | Ordering, poison-pill/livelock resistance |
| Scan queue (`enqueueScan`) | Yes | Active-scan guard — TOCTOU race explicitly accepted, not tested |
| Scan API (find/filter/paginate/export) | Yes | 30 tests — the single most-tested file in the app layer |
| Session token encryption at rest | Yes | Round-trip, tamper detection, wrong-key, legacy-plaintext passthrough |
| Shop lifecycle (install/uninstall/GDPR redact) | Yes | Idempotency, cascade-delete, data retention on uninstall |
| Scan state machine | Yes | Exhaustive legal/illegal transition matrix |
| Catalog reader (Shopify GraphQL) | Yes | Pagination, sub-pagination, variant limit, retry/backoff, error safety |
| Remix routes (loaders/actions) | **No** | Zero route-level tests anywhere in `app/routes/` |
| `app.scans.$id.tsx` UI (filter bar, modal, table) | **No** | 636 lines, largest untested file in the repo |
| Worker entrypoint (`worker.ts`) | **No — by design** | Deliberately thin; needs live OAuth env vars, logic lives in tested `worker-core.server.ts` |

## The three highest-leverage gaps

1. **`app.scans.$id.tsx` has no loader test.** This is the results page a
   merchant looks at after every scan — it parses query params into filter
   options, calls `getScanFindings`, and renders the findings table + detail
   modal. The function it calls is thoroughly tested; the *wiring* (does a
   `?severity=CRITICAL&page=2` URL actually produce the request you'd
   expect) isn't verified anywhere. One loader-level test asserting the
   query-param → `getScanFindings(opts)` mapping would close the largest
   real gap in the repo.
2. **No route/component test exists anywhere.** Every `app/routes/*.tsx`
   file — including the CSV export route and the settings form — has zero
   direct coverage. Low blast-radius for a read-only app, but it means a
   Remix-specific bug (wrong loader return shape, a broken form action) can
   ship without any test catching it before manual QA does.
3. **The `enqueueScan` TOCTOU race is accepted, not closed.**
   `queue.server.ts:54-62` names the exact race in a code comment and
   defers the fix (a partial unique index) until a second worker process is
   introduced. It's honest, not hidden — but it's the one place in the repo
   where "untestable with the current single-process assumption" is also
   true, so it's worth flagging before this app ever scales past one
   worker.

## One-line verdict per lens

| Lens | Verdict |
|---|---|
| 1. What's tested / what isn't | Engine (money-bearing logic) is deepest; routes/UI is the real gap |
| 2. Test design and levels | Clean unit-heavy pyramid with a solid integration mid-layer; no e2e rung |
| 3. Tests as design pressure | Design earns its tests — two seams (`worker-core.server.ts`, `AdminGraphqlClient`) built specifically to be testable |
| 4. Determinism, isolation, flakiness | Clean — injected clock/sleep, serialized DB file access, per-test table wipe |
| 5. Edge cases and error paths | Strong on money/CSV/pagination boundaries; one untested low-risk whitespace-search fall-through |
| 6. Testing AI features | `not yet exercised` — correctly so, no LLM/model output exists in this repo |
| 7. Red flags checklist | 6 of 7 classic red flags absent; the two real findings are the route-test gap and the named TOCTOU race |

See `audit.md` for the full lens-by-lens walk, and `01`–`06` for the six
testing techniques this repo applies deliberately enough to be worth
learning as transferable patterns.
