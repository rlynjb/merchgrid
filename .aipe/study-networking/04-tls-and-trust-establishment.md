# TLS and trust establishment
## Industry standard: transport encryption / certificate trust / message-authenticated webhooks

## Zoom out, then zoom in

TLS answers one question — "am I really talking to the host I think I am, over a channel nobody else can read?" — and this repo has two distinct trust problems that look similar but aren't. Getting HTTPS right (browser↔edge, app↔Shopify) proves you're talking to the right *server*. Verifying a webhook proves the *payload* really came from Shopify, and that's not a TLS problem at all — anyone can stand up an HTTPS endpoint and POST to your webhook URL, so TLS alone proves nothing about who sent the request.

```
  Zoom out — two different trust problems, two different mechanisms

  ┌─ Browser ──────────────────────────────────────────────┐
  │  trusts Fly's cert for merchgrid-catalog-audit.fly.dev  │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Fly edge ★ TLS terminates here ★ ─▼───────────────────┐
  │  force_https=true → plain HTTP inside Fly's network      │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Remix app / worker ────▼────────────────────────────────┐
  │  trusts Shopify's cert (Node's default CA store)          │
  │  → outbound Admin GraphQL calls                            │
  │  ★ ALSO must verify inbound webhooks via HMAC, not TLS ★   │
  └────────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: trust — what does each side actually verify, and with what?**

| hop | what's verified | mechanism |
|---|---|---|
| browser → Fly edge | "this is really the app's domain" | TLS certificate (Fly-managed) |
| Fly edge → Remix app | nothing (same trust domain) | none — Fly's private network boundary substitutes |
| Remix app → Shopify | "this is really Shopify's API" | TLS certificate (Node's default CA bundle, no pinning) |
| Shopify → webhook route | "this payload really came from Shopify" | **HMAC-SHA256 over the raw body, not TLS** |
| browser ↔ embedded app | "this session token really came from Shopify's App Bridge" | JWT session token verification (delegated to `@shopify/shopify-app-remix`) |

The seam that trips people up: TLS and HMAC solve *different* problems and this repo needs both, at different hops. TLS on the webhook-delivery hop only proves "you're talking to a server with a valid cert for this hostname" — it says nothing about who's sending the POST, because the app's webhook URL is publicly reachable by construction (Shopify has to be able to reach it from the outside). HMAC is what actually answers "did Shopify's servers, holding the app's shared secret, produce this exact byte sequence."

## How it works

### Move 1 — the mental model

You've verified a signed URL or a webhook secret before, even if you haven't named it HMAC: the sender and receiver share a secret ahead of time, the sender hashes the payload with that secret, and the receiver redoes the same hash and checks it matches. If it matches, only someone holding the secret could have produced that hash — the payload's authenticity is proven without a certificate authority anywhere in the picture.

```
  Pattern — HMAC trust, independent of the TLS layer underneath it

  Shopify:  HMAC-SHA256(raw_body, shared_secret)  →  X-Shopify-Hmac-Sha256 header
  App:      HMAC-SHA256(raw_body, shared_secret)  →  compare to header
            match  → trust the payload
            mismatch → reject (401), regardless of what TLS already verified
```

### Move 2 — walking each trust boundary

**Browser to Fly edge — standard TLS.** `force_https = true` (`app/fly.toml:37`) means any plaintext HTTP attempt gets redirected before it's served; there's no code path in this app that ever sees an unencrypted inbound request from the public internet. Certificate management (issuance, renewal) is entirely Fly's responsibility — this repo carries zero certificate configuration.

**Fly edge to the Remix app — no TLS at all, by design.** Once terminated at the edge, traffic to `internal_port 3000` runs as plain HTTP (`fly.toml:36`). This is the standard "TLS-terminated at the edge" pattern: the trust boundary moves from "prove the cert" to "prove you're inside Fly's private network," which this repo accepts implicitly rather than re-encrypting internally. Worth being blunt about: if Fly's private network were ever compromised, this hop has no defense of its own — that's an accepted cost of the platform choice, not something this repo hardens against.

**Remix app / worker to Shopify — outbound TLS, no pinning.** Every `admin.graphql()` call (`catalog-reader.server.ts:211`) goes out over HTTPS to `{shop}.myshopify.com`, verified against Node's default CA trust store. There's no certificate pinning, no custom CA bundle — this repo trusts the same root store any Node HTTPS client trusts. That's the right call here: pinning buys protection against a compromised CA, at the cost of needing to ship cert updates yourself; a small team auditing merchant catalogs doesn't need that extra operational burden.

**OAuth's redirect URLs — HTTPS-only by config.** `app/shopify.app.toml:31-32` declares `redirect_urls = [ "https://merchgrid-catalog-audit.fly.dev/api/auth" ]` — Shopify's OAuth dance (authorization code exchanged for an offline access token) only ever completes over that HTTPS URL; there's no HTTP fallback registered anywhere in the app config.

**Session tokens for the embedded app — trust delegated to the library.** `shopify.server.ts:43-46` turns on `future.unstable_newEmbeddedAuthStrategy` and `expiringOfflineAccessTokens` — this is Shopify's App Bridge session-token flow, where the embedded iframe gets a short-lived JWT from Shopify itself and the app's `authenticate.admin(request)` call verifies that JWT's signature before trusting the request as coming from an authenticated merchant session. **This repo does not implement that verification itself** — it's inside `@shopify/shopify-app-remix`, invoked as a single function call. That's worth naming plainly rather than glossing over: the mechanism is real and load-bearing, but you won't find the JWT-verification code in this repo to read — only the config flag that turns it on.

**Webhook HMAC — also delegated, but the mechanism is worth knowing anyway.** Every webhook route starts with `authenticate.webhook(request)` — see `app/app/routes/webhooks.app.uninstalled.tsx:7`, `webhooks.compliance.tsx:6`, `webhooks.app.scopes_update.tsx:6`. Under the hood (inside the Shopify SDK, not this repo's own code), that call: reads the raw request body before any JSON parsing touches it, recomputes an HMAC-SHA256 digest using the app's `SHOPIFY_API_SECRET`, and compares it — using a constant-time comparison, to avoid a timing side-channel — against the `X-Shopify-Hmac-Sha256` header Shopify sent. A mismatch throws, and the route never runs its business logic. **This repo never rolls its own HMAC check** — every one of the three webhook routes trusts the library to have already done it by the time `authenticate.webhook(request)` returns. That's the right call: hand-rolled HMAC verification is exactly the kind of security-critical, easy-to-get-subtly-wrong code you want a maintained library owning, not three separate route files each reimplementing byte-for-byte comparison.

```
  Layers-and-hops — one webhook delivery, trust established twice

  ┌─ Shopify ──────────────┐  hop 1: HTTPS POST +          ┌─ Fly edge ──┐
  │  computes HMAC over     │  X-Shopify-Hmac-Sha256 header │  TLS term    │
  │  raw body               │───────────────────────────────►│              │
  └──────────────────────────┘                                └──────┬───────┘
                                                            hop 2 │ plain HTTP
                                                                   ▼
                                                        ┌─ webhooks.*.tsx ────┐
                                                        │ authenticate.webhook│
                                                        │ (recompute + compare)│
                                                        └──────────┬───────────┘
                                                            match  │ mismatch
                                                                   ▼        ▼
                                                        run handler    401, no-op
```

### Move 3 — the principle

TLS proves you're talking to the right server. It never proves who's talking to *you*. Anywhere a system accepts inbound calls from a partner on a public URL — a webhook, a callback, an OAuth redirect — the actual trust decision has to live in a shared secret checked against the payload, not in the certificate the request arrived over. This repo gets that distinction right by delegating both halves (session-token JWT verification, webhook HMAC verification) to the same maintained library rather than improvising either.

## Primary diagram

```
  Trust establishment across every hop — TLS vs HMAC, side by side

  ┌─ Browser ──┐ TLS (Fly cert)  ┌─ Fly edge ──┐ plain HTTP  ┌─ Remix app ──┐
  │  App Bridge │────────────────►│  terminate    │────────────►│  session-token│
  └─────────────┘                 └───────────────┘             │  JWT verify   │
                                                                  │  (delegated)  │
                                                                  └───────┬────────┘
                                                                          │ trusted
                                                                          ▼
                                                                    route handler

  ┌─ Shopify ──┐ TLS (Node CA)   ┌─ Fly edge ──┐ plain HTTP  ┌─ webhooks.*.tsx ─┐
  │  webhook    │────────────────►│  terminate    │────────────►│  HMAC verify      │
  │  delivery   │  X-Shopify-Hmac  └───────────────┘             │  (delegated)      │
  └─────────────┘  header carries the REAL trust signal here     └───────┬────────────┘
                                                                          │ match
                                                                          ▼
                                                                    handler runs
```

## Elaborate

HMAC-authenticated webhooks are the same primitive as a signed URL or a pre-signed S3 upload — a shared secret proves authorship without a certificate authority. It's older than TLS-everywhere and still the right tool anywhere a third party needs to push events at a public endpoint you don't otherwise authenticate per-request. Read next: `05-http-semantics-caching-and-cors.md` for what status code this app hands back once trust is established (or isn't), and how Shopify's redelivery logic reacts to it.

## Interview defense

**Q: Does TLS protect this app's webhook endpoint from a forged request?**
No. TLS only proves the request arrived over an encrypted channel to the right hostname — anyone can POST to a public webhook URL over HTTPS. The actual authenticity check is the HMAC-SHA256 comparison inside `authenticate.webhook(request)`, computed over the raw body with the app's shared `SHOPIFY_API_SECRET`. Anchor: `webhooks.app.uninstalled.tsx:7` (call site); the HMAC computation itself lives inside `@shopify/shopify-app-remix`, not in this repo.

**Q: Where does this repo terminate TLS, and what's the security cost of that choice?**
At Fly's edge (`force_https=true`, `fly.toml:37`); everything from there to the Remix app on `internal_port 3000` is plain HTTP inside Fly's private network. The cost: no defense-in-depth if that private network boundary is ever breached — accepted here because re-encrypting internally on a single-machine deploy buys little for the operational overhead it costs.

## See also

- `01-network-map.md` — where TLS termination sits on the full hop chain
- `05-http-semantics-caching-and-cors.md` — the status codes that follow a trust decision
- `08-networking-red-flags-audit.md` — cross-links to `study-security` for the token-at-rest-encryption question, which is a data-exposure concern rather than a wire-trust one
