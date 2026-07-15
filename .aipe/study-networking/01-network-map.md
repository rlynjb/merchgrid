# Network map — the on-the-wire path
## Industry standard: network topology / request path

## Zoom out, then zoom in

MerchGrid: Catalog Audit is a single Fly.io machine wearing two hats — a Remix web app and a background worker — sitting between a merchant's browser (inside Shopify's admin iframe) and Shopify's Admin GraphQL API. Every "screen" you look at in this app is the visible end of a hop chain that crosses at least one real network boundary, usually two.

```
  Zoom out — every hop this repo actually makes

  ┌─ Browser (Shopify admin, embedded iframe) ───────────┐
  │  Polaris UI  +  App Bridge  →  fetch() / <Form>       │
  └───────────────────────┬───────────────────────────────┘
                          │  HTTPS (force_https)
  ┌─ Fly.io edge ─────────▼───────────────────────────────┐
  │  TLS termination, anycast routing → primary_region iad│
  └───────────────────────┬───────────────────────────────┘
                          │  plain HTTP, internal_port 3000
  ┌─ Fly machine (web + worker, one process group) ──★────┐
  │  Remix loaders/actions  │  worker.ts poll loop         │
  └──────────┬──────────────────────────┬──────────────────┘
             │ file I/O (no network)    │ HTTPS
  ┌─ SQLite (/data volume) ─┐  ┌─ Shopify Admin GraphQL ───┐
  │  Scan / Finding rows    │  │  {shop}.myshopify.com/... │
  └──────────────────────────┘  └────────────────────────────┘
                                        ▲
                          HTTPS (inbound) │
                                ┌─────────┴──────────┐
                                │ Shopify webhooks    │
                                │ (uninstall/compliance)│
                                └─────────────────────┘
```

This is the map every other file in this guide zooms into. `network-map` is the one file that names every hop in one place; the rest each take one hop (or one property of a hop) and go deep.

## The structure pass

**Axis: trust and control — who decides what crosses each boundary, and who has to trust whom to accept it?**

- **Browser → Fly edge.** The browser trusts Fly's TLS certificate for `merchgrid-catalog-audit.fly.dev`. Control: the browser decides when to send a request (Polaris button click, App Bridge navigation); Fly decides whether to terminate or reject the TLS handshake.
- **Fly edge → Fly machine.** Once TLS is terminated at the edge, the hop to `internal_port 3000` runs as plain HTTP inside Fly's private network (`app/fly.toml:36`). Control flips to "trust the platform boundary" instead of "trust a certificate" — this is the seam TLS establishment walks in `04-tls-and-trust-establishment.md`.
- **Remix app → SQLite.** Not a network hop at all — Prisma talks to a file on the mounted `/data` volume (`app/fly.toml:31-33`). This is the deliberate contrast point: the data layer that most apps put behind a network round-trip (a Postgres/MySQL connection) is local file I/O here, because this deploy is a single machine by design (`app/DEPLOY.md:3-8`).
- **Remix app / worker → Shopify Admin GraphQL.** Outbound HTTPS, and this is the one hop the app fully controls the retry/error semantics for — see `app/app/services/shopify/catalog-reader.server.ts`.
- **Shopify → webhook routes.** Inbound HTTPS, and here control flips: Shopify decides when to call the app (a merchant uninstalling, a GDPR clock firing), and the app's only lever is what status code it hands back (`07-timeouts-retries-pooling-and-backpressure.md` covers what a non-2xx response actually costs).

The seam worth remembering: **everywhere control crosses a public/private boundary (browser↔edge, Shopify↔webhook), TLS + a credential (session token, HMAC) both apply. Everywhere it stays inside one trust domain (edge↔machine, app↔SQLite), one or both drop away.**

## How it works

### Move 1 — the mental model

Think of this app as three independent request/response conversations layered on one machine: (1) a merchant's browser polling its own scan status, (2) the app pulling a shop's catalog from Shopify, (3) Shopify pushing lifecycle events at the app. None of the three share a connection or a protocol beyond "HTTPS, request/response." There is no message bus, no gRPC, no persistent duplex channel anywhere in this repo.

```
  Pattern — three independent HTTP conversations, one machine

  conversation 1:  browser  ──poll──►  Remix loader   (inbound)
  conversation 2:  Remix/worker ──query──►  Shopify GraphQL   (outbound)
  conversation 3:  Shopify  ──webhook──►  Remix action   (inbound)

  all three: request → response, no shared session, no push channel
```

### Move 2 — walking each hop

**Browser to Fly edge.** The merchant's browser is inside Shopify's admin, rendering this app in an iframe (`embedded = true`, `app/shopify.app.toml:6`). Every asset and API call the iframe makes goes out over HTTPS to `merchgrid-catalog-audit.fly.dev`, enforced by `force_https = true` (`app/fly.toml:37`) — any plaintext attempt gets redirected before it reaches the app.

**Fly edge to the Fly machine.** `internal_port 3000` (`app/fly.toml:36`) is where Fly's edge hands the now-decrypted request to the container. This is also where the health check lands: `[[http_service.checks]]` polls `GET /healthz` every 15 seconds over the same internal port (`app/fly.toml:45-51`), independent of any Shopify or database dependency — see `app/app/routes/healthz.tsx:3-9`, which returns `200 ok` with no auth and no Prisma call, precisely so a database hiccup never takes the machine out of rotation.

**Fly machine, internally split in two.** One process group, two Node processes started by `app/start-production.js:84-87`: `remix-serve` (web) and `node build/worker.js` (worker), both talking to the same SQLite file on `/data`. No network hop between them — they're siblings on one machine sharing a filesystem, which is the whole reason this deploy is one machine instead of two (`app/Dockerfile:1-3`, `app/fly.toml:1-8`).

**Remix app / worker to Shopify's Admin GraphQL API.** This is the richest hop in the repo. `readCatalog()` in `app/app/services/shopify/catalog-reader.server.ts:400-452` drives a paginated GraphQL read loop against `admin.graphql(query, { variables })` — an interface (`AdminGraphqlClient`, lines 16-21) deliberately kept thin so this module never imports the Shopify SDK directly. Every call in that loop is a `query`, never a `mutation` (the file's own read-only contract, lines 39-40). The worker reaches the same endpoint through a different door: `unauthenticated.admin(shopDomain)` in `app/worker.ts:26-29`, since the worker has no inbound HTTP request to authenticate against — it looks up the shop's stored offline token instead.

```
  Layers-and-hops — a single scan's outbound leg

  ┌─ Remix action ───┐  hop 1: POST /api/scans      ┌─ Fly edge ──┐
  │  api.scans.tsx   │─────────────────────────────►│  TLS term   │
  └──────────────────┘  hop 4: 202 Accepted    ◄───── └──────┬──────┘
                                                        hop 2 │ plain HTTP
                                                              ▼
                                                       ┌─ worker ────┐
                                                       │ claimAndRun │
                                                       │ Next()      │
                                                       └──────┬──────┘
                                                        hop 3 │ HTTPS GraphQL
                                                              ▼
                                                     ┌─ Shopify Admin API ─┐
                                                     │ {shop}.myshopify... │
                                                     └──────────────────────┘
```

**Shopify to the app's webhook routes.** Three inbound webhook routes exist: `app/app/routes/webhooks.app.uninstalled.tsx`, `webhooks.app.scopes_update.tsx`, and `webhooks.compliance.tsx` (the three mandatory GDPR topics, all pointed at one route via `[webhooks.privacy_compliance]` in `app/shopify.app.toml:26-29` rather than `[[webhooks.subscriptions]]` — a deliberate distinction the app's own config comments call out). Every one of these routes calls `authenticate.webhook(request)` first (e.g. `webhooks.app.uninstalled.tsx:7`), which is where HMAC trust establishment happens — walked in full in `04-tls-and-trust-establishment.md`.

### Move 3 — the principle

A request path is never "the app talks to Shopify" — it's a chain of independently-trusted hops, and the chain is only as strong as its weakest link. This repo's chain has exactly one link where the app *itself* owns the failure handling end to end (the outbound GraphQL hop), and that's exactly the hop that turns out to need the most care — see `07-timeouts-retries-pooling-and-backpressure.md`.

## Primary diagram

```
  MerchGrid: Catalog Audit — full request-path map

  ┌─ Browser (embedded iframe, App Bridge) ────────────────────────┐
  │  Polaris UI  →  loader/action fetch  →  useRevalidator poll     │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ HTTPS, force_https=true
  ┌─ Fly.io edge (primary_region=iad) ──▼──────────────────────────┐
  │  TLS termination  │  GET /healthz every 15s, timeout 5s         │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ plain HTTP, internal_port 3000
  ┌─ Fly machine ──────────────▼─────────────────────────────────────┐
  │ ┌─ Remix (web) ──────────┐   ┌─ worker.ts (POLL_MS=5000) ──────┐ │
  │ │ loaders / actions       │   │ claimAndRunNext()               │ │
  │ └────────────┬────────────┘   └────────────┬─────────────────────┘ │
  │              │ Prisma (file I/O, no net)    │ HTTPS GraphQL         │
  │ ┌─ SQLite /data ──────────▼──────────────────▼──────────────────┐ │
  │ │  Scan / Finding rows              admin.graphql() ────────────┼─┼──►
  │ └──────────────────────────────────────────────────────────────┘ │  │
  └────────────────────────────────────────────────────────────────────┘  │
                                                                            ▼
                                                        ┌─ Shopify Admin GraphQL ─┐
                                                        │ {shop}.myshopify.com    │
                                                        └────────────┬─────────────┘
                                                                     │ HTTPS webhooks
                                                        ┌────────────▼─────────────┐
                                                        │ webhooks.*.tsx routes    │
                                                        └──────────────────────────┘
```

## Elaborate

This map is small on purpose — it's the tradeoff of a single-tenant-per-scan, single-machine deploy. A larger system (multiple worker machines, a message queue, a CDN in front of static assets) would add hops this repo doesn't have: a load balancer fan-out, a queue broker, a cache tier. None of those exist here, and the `DEPLOY.md` comments are explicit about why — SQLite-on-a-volume means exactly one writer, which means exactly one machine, which means no horizontal hop to reason about. The cost of that simplicity is named honestly in `app/DEPLOY.md:163-168`: no replication, single point of failure at the volume.

## Interview defense

**Q: Walk me through every network hop a "start scan" click makes, start to finish.**
Browser → Fly edge (TLS terminates) → Remix action over plain HTTP inside Fly's network → row written to SQLite (no network) → worker picks it up on its next poll tick → worker calls Shopify's Admin GraphQL over HTTPS → response normalized and written back to SQLite → browser's next poll (2.5s interval) picks up the new state over the same browser→edge→machine hop. One diagram: the layers-and-hops picture above with hop numbers 1-4 for the "start scan" leg, plus the worker's separate poll cycle running in parallel.

**Q: Where's the one hop in this app where the app owns 100% of the retry/error contract, and why does that matter?**
The outbound call to Shopify's Admin GraphQL API inside `catalog-reader.server.ts`. Every other hop's failure handling is delegated — Fly handles edge failures, the webhook library handles inbound trust, Prisma handles file I/O errors. This is the one place a bug in *this repo's* code can leave a user staring at a stuck scan. Anchor: `runQuery()`, `catalog-reader.server.ts:200-241`.

## See also

- `02-dns-routing-and-addressing.md` — how each hop's address gets resolved
- `04-tls-and-trust-establishment.md` — the TLS-termination and HMAC-trust seam named above
- `07-timeouts-retries-pooling-and-backpressure.md` — the outbound GraphQL hop's failure handling in full
- `08-networking-red-flags-audit.md` — ranked risks across every hop on this map
