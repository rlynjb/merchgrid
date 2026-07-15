# TCP/UDP connections and sockets
## Industry standard: transport-layer connection lifecycle

## Zoom out, then zoom in

Every hop in this repo rides on TCP. There is no UDP anywhere in the code you'd write yourself — no QUIC config, no raw datagram socket, no custom DNS-over-UDP handling (that's delegated entirely to Node/the OS resolver). The interesting question isn't "TCP or UDP" here, it's **connection lifecycle**: which hops open a new connection per request, which reuse one, and which never touch the network at all.

```
  Zoom out — where a TCP connection actually gets opened

  ┌─ Browser ─────────────────────────────────────────────┐
  │  HTTPS/TCP to Fly edge (browser-managed keep-alive)     │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Fly edge ──────────────▼────────────────────────────────┐
  │  ★ THIS CONCEPT ★  TCP to internal_port 3000              │
  │  + GET /healthz every 15s (its own short-lived connection)│
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Remix app / worker ─────▼────────────────────────────────┐
  │  ★ THIS CONCEPT ★  outbound TCP to Shopify (Node/undici)   │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ SQLite (/data) ─────────▼────────────────────────────────┐
  │  NOT a network connection — a file descriptor              │
  └────────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: connection lifecycle — per-request, kept-alive, or none at all?**

- Browser ↔ Fly edge: standard HTTPS keep-alive, managed entirely by the browser; out of this repo's control.
- Fly edge ↔ Remix app: a plain-HTTP connection per proxied request inside Fly's private network — the app never sees or manages this socket directly (`remix-serve` binds `internal_port 3000`, `fly.toml:36`).
- Fly's health checker ↔ `/healthz`: its own short, deliberately cheap connection, opened every 15 seconds regardless of app traffic (`fly.toml:45-51`).
- Remix app / worker ↔ Shopify Admin GraphQL: the one hop where *this repo's* retry loop can open many sequential connections (or reuse one, if the underlying HTTP client keeps it alive) — the pagination loop in `catalog-reader.server.ts` can issue dozens of round trips for one large catalog.
- Remix app / worker ↔ SQLite: no socket at all. Prisma opens a file handle on `/data/prod.sqlite`; there's no listener, no port, no handshake. This is the seam worth naming explicitly, because it's the one place a typical Node app *would* have a connection pool (Postgres, MySQL) and this one deliberately doesn't (`app/DEPLOY.md:3-8`).

## How it works

### Move 1 — the mental model

You've written `fetch()` calls before — under the hood, each one either opens a fresh TCP connection or reuses one the HTTP client already has warm (HTTP/1.1 keep-alive / HTTP/2 multiplexing). Node's built-in `fetch` (which `admin.graphql()` uses under the hood inside the Shopify SDK) behaves the same way, backed by `undici`'s connection pool. This repo never touches that pool directly — it's implicit, not configured — which matters once you're issuing the kind of repeated, sequential calls the catalog reader does.

```
  Pattern — sequential calls that could reuse one connection, or not

  call 1: GET products page 1  ─┐
  call 2: GET products page 2   ├─ same host → SHOULD reuse one
  call 3: GET variants (prod A) │   TCP+TLS connection via keep-alive
  call N: ...                  ─┘   (undici default; not tuned here)
```

### Move 2 — walking the connections that matter

**The health-check connection.** Fly's `[[http_service.checks]]` (`app/fly.toml:45-51`) opens a `GET /healthz` connection every 15 seconds, with a `5s` timeout and a `10s` grace period on startup. `app/app/routes/healthz.tsx:10-15` is written to make that connection as cheap as possible on purpose — no `authenticate.admin()` call, no Prisma query — the comment at lines 3-9 spells out why: the check needs to answer "is the process up" independent of "is the database or Shopify session store healthy," so it can't block on either. If this route did a DB round-trip, a slow SQLite write under load could make Fly think the whole machine is unhealthy and restart it.

**The scan pagination loop's repeated connections.** `readCatalog()` (`catalog-reader.server.ts:400-452`) calls `runQuery()` in a loop — once per products page, plus once per variant sub-page for any product with more than 100 variants (`fetchAllVariants`, lines 309-344). For a catalog near the `variantLimit` guardrail (default 5,000, from `ShopSettings.catalogVariantLimit`), that's potentially dozens of sequential HTTPS calls to the same `{shop}.myshopify.com` host. Whether those calls reuse one TCP+TLS connection or renegotiate a new one each time is entirely up to the underlying `fetch`/`undici` client's default keep-alive behavior — this repo doesn't configure a custom `Agent`, connection pool size, or idle timeout anywhere. That's a real gap named honestly in `07-timeouts-retries-pooling-and-backpressure.md`, not a defect being glossed over here.

**The retry loop reusing (or not reusing) a connection.** Every retried call inside `runQuery()` (`catalog-reader.server.ts:200-241`) is a brand-new `admin.graphql()` invocation — there's no manual socket reuse logic; whatever connection pooling exists is whatever the HTTP client does by default. What *is* explicit is the wait between attempts: `policy.sleep(computeRetryDelayMs(attempt))` (line 217, 228) — the connection for a failed/throttled call isn't kept open across that wait; a fresh request goes out when the sleep ends.

**SQLite: the non-connection.** `db.server.ts` (imported everywhere as `prisma`) opens a client against `DATABASE_URL = "file:/data/prod.sqlite"` (`fly.toml:26`). There's no `pg://` or `mysql://` here — no TCP port to a database server, no connection pool to size, no "too many connections" failure mode. The tradeoff this buys: zero network hop to the data layer, at the cost of exactly one process being allowed to write at a time — which is precisely why `app/fly.toml` deliberately has no `[processes]` block (comment, lines 1-8): splitting web and worker onto separate Fly machines would give each its own filesystem and break this single-writer assumption.

### Move 2 variant — the load-bearing skeleton of the retry connection loop

- **Kernel:** attempt counter + a call that either resolves (success/error-body) or rejects (network failure) + a sleep between attempts.
- **What breaks if the attempt counter is removed:** an infinitely retried connection against a shop whose token was revoked — every retry opens a new connection that will never succeed, forever.
- **What breaks if the sleep is removed:** every failed call immediately reopens a new connection, hammering a rate-limited host harder, which is the opposite of what backoff is for.
- **Hardening layered on top (not the kernel):** the jitter inside `computeRetryDelayMs` (`catalog-reader.server.ts:176-184`) — covered in depth in `07-timeouts-retries-pooling-and-backpressure.md`, since it's a retry-policy concern more than a raw-socket one.

### Move 3 — the principle

A connection isn't free just because your HTTP client "handles it for you." Every hop that opens one sequentially — a pagination loop, a retry loop — is a hop where connection reuse either happens by good luck (a client whose defaults are right for your call pattern) or doesn't. Naming the hop where you *don't* control that explicitly is as important as naming the hops where you do.

## Primary diagram

```
  Connection lifecycle across every hop in this repo

  ┌─ Browser ──────────┐ keep-alive  ┌─ Fly edge ─────────┐
  │  App Bridge/Polaris │◄───────────┤  TLS terminate       │
  └─────────────────────┘             └──────────┬───────────┘
                                        per-request│ plain HTTP
                                                    ▼
                                        ┌─ Remix app ────────┐
                                        │  loaders/actions     │
                                        └──────────┬───────────┘
                          undici default (untuned) │
                                                    ▼
                                        ┌─ Shopify Admin API ─┐
                                        │  N sequential calls  │
                                        │  per scan (pagination)│
                                        └───────────────────────┘

  ┌─ Fly healthcheck ──┐ new conn/15s ┌─ /healthz ──────────┐
  │  interval=15s       │─────────────►│  no DB, no auth      │
  └─────────────────────┘             └──────────────────────┘

  ┌─ Remix app / worker ┐ NO NETWORK  ┌─ SQLite /data ──────┐
  │  Prisma client       │────────────►│  file descriptor     │
  └─────────────────────┘             └──────────────────────┘
```

## Elaborate

The absence of a database connection pool here isn't an oversight to flag — it's the direct consequence of choosing SQLite-on-a-volume for a single-writer workload (`DEPLOY.md`'s own framing). The place a pool *would* matter — the outbound Shopify calls — is exactly where this repo currently has none configured, which is a legitimate gap worth carrying forward, not a design choice being defended.

## Interview defense

**Q: How many TCP connections does one full catalog scan open to Shopify?**
Not a fixed number — it's one connection attempt per `runQuery()` call, and `readCatalog()`'s loop calls it once per products page plus once per variant sub-page for oversized products, up to the point the variant-limit guardrail is hit. Whether those share one underlying TCP+TLS connection depends on undici's default keep-alive, which this repo doesn't override. Anchor: `catalog-reader.server.ts:400-452` (the loop), `200-241` (the call site).

**Q: Why does `/healthz` skip the database?**
Because Fly's health check needs to answer "is the process serving HTTP" independent of "is the SQLite file healthy" — coupling them means a slow write takes the whole machine out of rotation. Anchor: `healthz.tsx:3-15`.

## See also

- `02-dns-routing-and-addressing.md` — the resolution step immediately before every connection here
- `04-tls-and-trust-establishment.md` — what happens on top of the TCP handshake for every HTTPS hop
- `07-timeouts-retries-pooling-and-backpressure.md` — the retry loop that reopens these connections, and the pooling gap named honestly
