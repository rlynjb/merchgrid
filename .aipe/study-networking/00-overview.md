# Study — Networking: MerchGrid: Catalog Audit
## one-page orientation for `.aipe/study-networking/`

## What this repo actually does on the wire

MerchGrid: Catalog Audit is a single always-on Fly.io machine that runs a Remix web app and a background worker side by side, talking to Shopify's Admin GraphQL API over HTTPS and to a local SQLite file with no network hop at all. It's a small, well-bounded networking surface — one outbound API dependency, three inbound webhook routes, one polled UI screen — and the interesting engineering is concentrated almost entirely in one file: `app/app/services/shopify/catalog-reader.server.ts`.

```
  The whole wire picture, one diagram

  ┌─ Browser (embedded iframe, App Bridge) ───────────────────┐
  │  Polaris UI  →  fetch/Form  →  useRevalidator poll (2.5s)    │
  └───────────────────────┬────────────────────────────────────────┘
                          │ HTTPS, force_https=true
  ┌─ Fly.io edge (primary_region=iad) ─▼───────────────────────────┐
  │  TLS termination  │  GET /healthz every 15s (no DB, no auth)     │
  └───────────────────────┬────────────────────────────────────────────┘
                          │ plain HTTP, internal_port 3000
  ┌─ Fly machine ────────────▼──────────────────────────────────────────┐
  │ ┌─ Remix (web) ─────┐    ┌─ worker.ts (POLL_MS=5000) ─────────────┐ │
  │ │ loaders / actions   │    │ claimAndRunNext() → runScan()           │ │
  │ └─────────┬────────────┘    └────────────┬───────────────────────────┘ │
  │           │ Prisma (file I/O, no network)  │ HTTPS GraphQL, retried      │
  │ ┌─ SQLite /data ──▼────────────────────────▼──────────────────────┐   │
  │ │  Scan / Finding rows            admin.graphql() ─────────────────┼───┼──►
  │ └────────────────────────────────────────────────────────────────┘   │   │
  └──────────────────────────────────────────────────────────────────────┘   │
                                                                               ▼
                                                          ┌─ Shopify Admin GraphQL ─┐
                                                          │  {shop}.myshopify.com    │
                                                          └────────────┬─────────────┘
                                                                       │ HTTPS webhooks
                                                          ┌────────────▼─────────────┐
                                                          │ webhooks.*.tsx routes    │
                                                          │ (HMAC-verified inbound)   │
                                                          └──────────────────────────┘
```

## Where study-networking sits

```
  study-networking        WHAT happens on the wire and why.
  study-security          WHETHER each trust boundary is safe.
  study-system-design      WHERE network boundaries belong in the architecture.
```

This guide teaches protocol mechanics and failure modes — DNS, TCP, TLS, HTTP semantics, realtime transports, timeouts/retries/pooling. It does not re-adjudicate whether tokens are encrypted at rest (that's `study-security`) or whether a race condition in the scan queue is a correctness bug (that's `study-database-systems`/`study-distributed-systems`) — those are cross-linked from `08-networking-red-flags-audit.md`, not re-taught here.

## Reading order

1. `01-network-map.md` — every hop, named once, in one place.
2. `02-dns-routing-and-addressing.md` — how each hop's address gets resolved (Fly anycast, per-shop `myshopify.com` domains).
3. `03-tcp-udp-connections-and-sockets.md` — connection lifecycle at each hop; the one place this app deliberately has no network connection at all (SQLite).
4. `04-tls-and-trust-establishment.md` — where TLS terminates, and why webhook trust is a completely different mechanism (HMAC) than TLS.
5. `05-http-semantics-caching-and-cors.md` — status codes as the actual API contract; why there's no CORS and no caching, and why that's correct here.
6. `06-websockets-sse-streaming-and-realtime.md` — **not yet exercised**: polling stands in for push, and the file is explicit about why and when that would change.
7. `07-timeouts-retries-pooling-and-backpressure.md` — the richest file: the retry/backoff/jitter kernel in `catalog-reader.server.ts`, and the one real gap in it.
8. `08-networking-red-flags-audit.md` — every finding above, ranked by consequence.

## Ranked findings (full detail in `08-networking-red-flags-audit.md`)

1. **No wall-clock timeout around outbound Shopify GraphQL calls** (`catalog-reader.server.ts:211`) — the retry policy bounds attempt count, not attempt duration; a hung call can block a scan, and with one worker process, block every other shop's queue behind it. Highest consequence, cheapest fix.
2. **Single machine, single region, no network-level failover** (`fly.toml:16`, `DEPLOY.md:163-168`) — a named, accepted tradeoff of the single-SQLite-writer architecture, not an oversight.
3. **Outbound connection pooling is unconfigured** (relies on `undici` defaults) — low risk at current scale, worth revisiting only if concurrency grows.
4. **Fixed 2.5-second poll interval** (`app.scans.$id.tsx:514-516`) — a deliberate, currently-correct tradeoff of simplicity over instant push; the condition under which it would flip is named explicitly in file 06.

## Not yet exercised — named explicitly

- **WebSockets, Server-Sent Events, or any persistent push connection.** This repo uses HTTP polling (`useRevalidator`, `app/app/routes/app.scans.$id.tsx:510-519`) for the one screen that needs live updates. Full treatment, including the specific condition under which SSE would become the right next step, lives in `06-websockets-sse-streaming-and-realtime.md`.
- **CORS (`Access-Control-Allow-Origin`).** Nothing in this codebase's own JavaScript makes a cross-origin `fetch`; the actual cross-origin concern for an embedded Shopify app (`frame-ancestors` in the CSP) is handled by the Shopify SDK's own header helpers. Detailed in `05-http-semantics-caching-and-cors.md`.
- **HTTP response caching (`Cache-Control`).** No route sets it — every loader serves per-shop, authorization-gated, frequently-changing scan data that would be actively wrong to cache. Detailed in `05-http-semantics-caching-and-cors.md`.
- **Custom TLS configuration (pinning, custom CA, explicit cipher/version control).** TLS termination is entirely Fly-managed at the edge; outbound calls trust Node's default CA store. Detailed in `04-tls-and-trust-establishment.md`.
- **A custom-configured HTTP connection pool/Agent for outbound Shopify calls.** Relies on `undici`'s defaults, unverified against this app's specific call pattern. Detailed in `03-tcp-udp-connections-and-sockets.md` and ranked in `08-networking-red-flags-audit.md`.
- **UDP transport of any kind.** Every hop in this repo is TCP-based HTTP/HTTPS; there's no QUIC configuration, no raw datagram socket, no custom DNS-over-UDP handling in application code.

## The richest anchor in this codebase

If you only read one file's worth of real code from this guide, make it `app/app/services/shopify/catalog-reader.server.ts`. It's the one place this repo owns a full resilience story end to end — retry-with-backoff-and-jitter against Shopify's cost-throttling, a genuine-vs-transient error distinction, a soft variant-count budget enforced mid-pagination, and sanitized error messages that never leak GraphQL internals. It's also the one place with a real, fixable gap (no per-call timeout) — both halves are walked in full in `07-timeouts-retries-pooling-and-backpressure.md`.
