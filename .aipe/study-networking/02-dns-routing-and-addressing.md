# DNS, routing, and addressing
## Industry standard: DNS resolution / anycast routing / origin addressing

## Zoom out, then zoom in

Before any TCP handshake or TLS negotiation can happen, something has to turn a name into an address. This repo has three separate name-resolution stories running at once, and they resolve to three different kinds of thing: a Fly.io anycast address for the app itself, a per-shop `myshopify.com` (or custom) domain for every outbound Shopify call, and a third-party CDN host the browser is told to warm up before it's even asked for.

```
  Zoom out — three names this system resolves

  ┌─ Browser ────────────────────────────────────────────┐
  │  merchgrid-catalog-audit.fly.dev  ★ THIS CONCEPT ★     │
  │  cdn.shopify.com (preconnect hint)                     │
  └───────────────────────┬─────────────────────────────────┘
                          │
  ┌─ Fly.io edge (anycast) ▼──────────────────────────────┐
  │  routes to primary_region = iad                        │
  └───────────────────────┬─────────────────────────────────┘
  ┌─ Remix app / worker ───▼──────────────────────────────┐
  │  {shop}.myshopify.com  ★ THIS CONCEPT ★                │
  │  (or SHOP_CUSTOM_DOMAIN, if set)                       │
  └────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: who resolves the name, and how often does the answer change?**

- The browser resolves `merchgrid-catalog-audit.fly.dev` once per page load-ish (subject to the OS/browser DNS cache); Fly's anycast network then decides which physical edge answers, which can change hop to hop without the DNS answer itself changing — an anycast address is one IP that many machines answer to.
- The app resolves a *different* hostname per shop: `{shop}.myshopify.com`. This name is stable per merchant but the set of names the app talks to grows with every install — there's no single "the Shopify API host," there's one host per tenant.
- The browser resolves `cdn.shopify.com` speculatively, before it's needed, via a `<link rel="preconnect">` hint — this one never changes and is shared across every merchant using the app.

The seam: **the app-identity hostname (fly.dev) is one name behind Fly's routing layer; the Shopify-identity hostname is per-tenant and picked at request time from data (`session.shop`), not configuration.** Anywhere code hardcodes a Shopify hostname instead of reading it off the session, that's a bug waiting to happen — this repo doesn't do that; every outbound call goes through `admin.graphql()` on the client the Shopify SDK already built with the right shop domain baked in.

## How it works

### Move 1 — the mental model

You already know the shape from ordinary web dev: a browser doesn't connect to "example.com," it connects to whatever IP DNS handed back for that name, and the server behind that IP can be one machine or a whole anycast fleet. The twist here is that the *app itself* is also a DNS client — every time it wants a merchant's catalog, it has to address a different remote host, because the host **is** the tenant identity.

```
  Pattern — one name resolved by the browser, N names resolved by the app

  browser:        one name  →  one anycast IP  →  nearest edge
  app (per call):  N names  →  N myshopify.com origins  →  1 per shop
```

### Move 2 — walking each resolution

**The app's own hostname, resolved by the browser.** `merchgrid-catalog-audit.fly.dev` is the address Fly assigns when the app is created (`app/DEPLOY.md:33-43`, `fly apps create merchgrid-catalog-audit`). Fly's edge network answers for that name from whichever point of presence is closest to the requester, then internally routes the request to wherever the actual machine lives — `primary_region = "iad"` in `app/fly.toml:16` pins that machine (and its volume) to one AWS-region-equivalent, with a comment explaining why the machine and the volume must share a region (`fly.toml:12-13`). DNS resolution answers "which edge," not "which exact machine" — that's a second, internal routing decision Fly makes after the DNS step.

**Per-shop hostnames, resolved by the app for every outbound Shopify call.** There is no single "Shopify API" hostname in this codebase. The Admin GraphQL endpoint is always `https://{shop-domain}/admin/api/{version}/graphql.json`, and `{shop-domain}` comes from the authenticated session (`authenticate.admin(request)` in a route loader) or, for the worker, from the `Shop.shopDomain` column read off the queue (`app/app/services/scan/worker-core.server.ts:34-46`, then `unauthenticated.admin(scan.shop.shopDomain)` inside the injected `adminFactory` — see `app/worker.ts:22-25`). Every scan resolves a fresh hostname; nothing is cached or memoized at the app layer beyond whatever the OS/Node DNS cache does by default.

```
  Layers-and-hops — resolving the target for one scan's GraphQL call

  ┌─ worker-core.server.ts ─┐  reads       ┌─ Scan row ────────┐
  │  claimAndRunNext()      │─────────────►│  shop.shopDomain   │
  └────────────┬─────────────┘  (DB, no DNS) └────────────────────┘
               │ shopDomain string
               ▼
  ┌─ worker.ts adminFactory ─┐  DNS lookup  ┌─ {shop}.myshopify.com ─┐
  │  unauthenticated.admin() │─────────────►│  resolved per call      │
  └────────────────────────────┘             └──────────────────────────┘
```

**The optional custom domain.** `shopify.server.ts:47-49` reads `SHOP_CUSTOM_DOMAIN` and, if set, adds it to `customShopDomains` in the `shopifyApp()` config — this is how a merchant on a Shopify Plus custom storefront domain (rather than the default `myshopify.com`) gets recognized as the same shop. `DEPLOY.md` never sets this variable in its runbook, so in the deployment this repo actually documents, every shop is addressed by its default `myshopify.com` domain.

**The speculative resolution.** `app/app/root.tsx:15` — `<link rel="preconnect" href="https://cdn.shopify.com/" />` — tells the browser to run DNS lookup, TCP handshake, and TLS negotiation for that host *before* the stylesheet request on the next line (`root.tsx:16-19`) actually needs it, shaving one full round trip off loading Shopify's shared font CSS. This is the only preconnect hint in the app; nothing else gets this treatment (not the app's own domain, which the browser already has an open connection to by the time it's rendering `<head>`).

### Move 3 — the principle

DNS resolution answers "which edge/region," not "which tenant." Multi-tenant systems that talk to a partner API on behalf of many customers end up doing their *own* resolution decision on top of DNS — reading an identifier from data and turning it into a hostname per call. That data-driven addressing step is exactly as load-bearing as DNS itself, and a bug in it (hardcoding one shop's domain, say) is invisible to every DNS-layer tool you'd normally reach for to debug connectivity.

## Primary diagram

```
  Every name this system resolves, and who resolves it

  ┌─ Browser ──────────────────────────────────────────────┐
  │  merchgrid-catalog-audit.fly.dev → Fly anycast edge      │
  │  cdn.shopify.com → preconnect (root.tsx:15)               │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ Fly.io edge ─────────────▼───────────────────────────────┐
  │  routes into primary_region = iad (fly.toml:16)             │
  └──────────────────────────┬─────────────────────────────────┘
  ┌─ Remix app / worker ───────▼───────────────────────────────┐
  │  session.shop  /  scan.shop.shopDomain  (from DB, not DNS)  │
  │        │                                                     │
  │        ▼                                                     │
  │  {shop}.myshopify.com   ── or ──   SHOP_CUSTOM_DOMAIN         │
  │  (shopify.server.ts:47-49)                                    │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Anycast routing and per-tenant addressing are both instances of the same underlying idea: a name is a level of indirection, and who controls that indirection determines who controls failover, load balancing, and multi-tenancy. Fly owns the indirection for the app's own address (you don't choose which edge answers); this repo owns the indirection for Shopify addresses (the shop domain is read from data, not hardcoded), which is exactly the property that makes one codebase serve every merchant without a per-tenant deploy.

## Interview defense

**Q: Is there a single "Shopify API endpoint" this app talks to?**
No — there's one endpoint shape (`{shop}.myshopify.com/admin/api/{version}/graphql.json`) instantiated per shop, with the shop domain read from the authenticated session or the `Shop` row, never hardcoded. Anchor: `worker-core.server.ts:34-46` + `worker.ts:22-25`.

**Q: What does the `preconnect` hint in root.tsx actually save?**
It runs DNS + TCP + TLS for `cdn.shopify.com` ahead of the stylesheet request that needs it, so that request only pays the HTTP round trip instead of the full connection-establishment cost. One-line diagram: `DNS → TCP → TLS` happens early; `HTTP GET` happens on schedule.

## See also

- `01-network-map.md` — where each of these resolved addresses sits on the full request path
- `03-tcp-udp-connections-and-sockets.md` — what happens right after a name resolves to an address
- `04-tls-and-trust-establishment.md` — the TLS handshake immediately following DNS + TCP for every HTTPS hop here
