# 00 — System overview

MerchGrid: Catalog Audit in one picture, then a legend for every box.

```
Whole system — MerchGrid: Catalog Audit

┌─ UI layer (embedded admin, merchant's browser) ─────────────────────────┐
│  Polaris + App Bridge  →  app._index (onboarding) / app.scans.$id       │
│  (poll every 2.5s while running)  / app.settings                        │
└──────────────────────────┬───────────────────────────────────────────┬─┘
        session-token JWT  │  HTTP (Remix loaders/actions)             │
                            ▼                                          │
┌─ Service layer — Fly machine, process 1: Remix web (remix-serve) ───┐ │
│                                                                       │ │
│  routes/  app.tsx (authenticate.admin) ─────────────────────────────┐│ │
│    api.scans.tsx (POST enqueue) · api.scans.$id.tsx (GET summary)  ││ │
│    api.scans.$id.export.tsx (GET CSV) · webhooks.*.tsx              ││ │
│                     │                                                ││ │
│  services/scan/scan-api.server.ts  (shop-scoped reads, §05)         ││ │
│  services/scan/queue.server.ts     (enqueueScan, §01)               ││ │
│  services/session/encrypted-session-storage.server.ts (§04)         ││ │
└──────────────────────────┬────────────────────────────────────────────┘ │
                            │ shared SQLite file (/data/prod.sqlite)       │
                            ▼                                              │
┌─ Storage layer — Fly volume "data" ──────────────────────────────────┐  │
│  SQLite via Prisma:  Session · Shop · ShopSettings ·                 │  │
│    Scan (state machine) · Finding (denormalized, indexed) ·          │  │
│    ScanArtifact                                                      │  │
└──────────────────────────┬────────────────────────────────────────────┘  │
                            │ same file, same machine                      │
                            ▼                                              │
┌─ Service layer — Fly machine, process 2: worker (node build/worker.js)┐  │
│                                                                        │  │
│  worker.ts (poll loop, 5s)                                            │  │
│    → worker-core.server.ts claimAndRunNext (§01)                      │  │
│    → runner.server.ts runScan (§02: state machine + atomic persist)   │  │
│       → services/shopify/catalog-reader.server.ts (paginate + retry) ─┼──┘
│       → @merchgrid/catalog-core normalizeCatalog (§03, engine)        │
│       → @merchgrid/catalog-checks runChecks × 10 checks (§03, engine) │
└─────────────────────────────────────────────────────────────────────┬─┘
        Admin GraphQL, offline token, read-only (query only)          │
                                                                        ▼
                                              ┌─ External / Provider ──────┐
                                              │  Shopify Admin GraphQL API │
                                              │  (products/variants query, │
                                              │   cost-throttled)          │
                                              └────────────────────────────┘

  supervisor (start-production.js) spawns web + worker as sibling
  processes on ONE Fly machine; both boxes above share it and the volume.
```

## Legend — what each box is, owns, and talks to

| Box | What it is | What it owns | Talks to |
|---|---|---|---|
| **UI layer** | Embedded Shopify admin surface: Polaris components + App Bridge, rendered inside Shopify's admin iframe | Client-side UI state (selected finding, filter form draft) and a 2.5s poll interval while a scan is running | Remix loaders/actions over HTTP, authenticated by App Bridge's session token |
| **Remix web process** | `remix-serve`, one of two sibling processes on the Fly machine | Request/response cycle, OAuth (`authenticate.admin`), the scan-trigger and read APIs | SQLite (via Prisma), the worker only indirectly (via the `Scan` row each writes/reads) |
| **worker process** | `node build/worker.js`, the other sibling process, no inbound HTTP | The poll loop and the entire scan pipeline execution | SQLite (via Prisma), Shopify Admin GraphQL API (offline token) |
| **SQLite (Fly volume)** | The one and only datastore — sessions, tenants, scans, findings | Durable state for everything: OAuth tokens, shop settings, scan state machine, findings | Both processes, over the same file path, on the same machine |
| **engine packages** | `@merchgrid/catalog-core` + `@merchgrid/catalog-checks`, pure functions, zero I/O | Normalization rules and the 10 deterministic checks (MG-001…MG-010) | Nothing — no imports out to Shopify/Prisma/Remix; called in-process by the worker's `runner.server.ts` and, for names/descriptions only, by the web process's UI routes |
| **Shopify Admin GraphQL API** | External provider, OAuth-scoped `read_products,read_inventory` | The merchant's actual catalog data | The worker only, via `readCatalog` — read-only, paginated, cost-throttle-aware retries |

## Map of the concept files

- `audit.md` — walks all 8 lenses against this map; start there for the "is X exercised here?" answer on any topic.
- `01-single-worker-db-queue.md` — the arrow from `enqueueScan` → `claimAndRunNext` → `worker.ts`'s poll loop.
- `02-atomic-idempotent-scan-pipeline.md` — the arrow from `runner.server.ts`'s state machine through the `$transaction` commit.
- `03-engine-app-boundary.md` — the `packages/` box's zero-I/O contract and why it's shaped that way.
- `04-encrypted-token-at-rest.md` — what sits between `PrismaSessionStorage` and the `Session` table.
- `05-shop-scoped-authorization.md` — the authorization check every read in `scan-api.server.ts` runs before touching a row.
- `06-single-machine-shared-volume.md` — why the two service-layer boxes above are siblings on one machine, not two.
