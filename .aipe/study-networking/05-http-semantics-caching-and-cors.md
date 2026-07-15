# HTTP semantics, caching, and CORS
## Industry standard: HTTP methods, status codes, caching headers, cross-origin policy

## Zoom out, then zoom in

Every route in this Remix app is a method-and-status-code contract. There's no bespoke response envelope, no custom "success: true/false" wrapper — the HTTP layer itself carries the meaning: `202` means "queued, come back later," `409` means "you already have one of these," `404` means "not found or not yours." Caching and CORS are the two levers most HTTP APIs lean on that this one deliberately doesn't need, and it's worth being precise about *why* rather than treating their absence as an oversight.

```
  Zoom out — HTTP semantics carrying the app's actual business logic

  ┌─ Browser ─────────────────────────────────────────────┐
  │  POST /api/scans  →  202 / 409 / 404                   │
  │  GET  /app/scans/:id  →  loader, polled every 2.5s       │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Remix routes ★ THIS CONCEPT ★ ─▼──────────────────────┐
  │  status codes ARE the API contract                       │
  │  frame-ancestors CSP, not classic CORS                    │
  └────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: who decides the status code, and what does the other side do in response?**

- `api.scans.tsx`'s `action` decides the code (`202`, `409`, `404`) — the browser's `fetch` caller decides what to do with it (show a banner, retry, redirect).
- Webhook routes decide their own status implicitly — a bare `new Response()` (200) or a thrown `Response("Unhandled webhook topic", { status: 404 })` in `webhooks.compliance.tsx:27` — and here the seam flips: **once you hand Shopify anything other than 2xx, control passes to Shopify's webhook-redelivery system, not this app's.** This repo doesn't implement its own retry-on-failure for inbound webhooks; it relies entirely on Shopify's redelivery schedule kicking in when it sees a non-2xx.
- CORS and caching decisions are, structurally, absent rather than configured — there is no cross-origin JavaScript `fetch` in this codebase's own code that a CORS header would need to permit, and no `Cache-Control` header set anywhere in the app's routes.

## How it works

### Move 1 — the mental model

You've built a `fetch()` call and branched on `response.status` before — `200` render the data, `404` show a not-found state, `409` show a conflict message. This app's own server side is doing the mirror image: the route handler is the one *choosing* which of those codes to hand back, and it's choosing deliberately, not defaulting to 200-and-a-JSON-error-field.

```
  Pattern — status code as the contract, not a wrapper object

  POST /api/scans
    no active scan     → 202 Accepted   { id, status: "QUEUED" }
    scan already active → 409 Conflict  { error: "..." }
    shop not found       → 404 Not Found { error: "Not found" }
```

### Move 2 — walking the semantics

**202 Accepted for async work.** `app/app/routes/api.scans.tsx:16-19` returns `json(scan, { status: 202 })` on a successful enqueue. `202` is the precise code here, not `200` or `201` — the scan hasn't *finished*, it's been accepted for asynchronous processing by the worker; the browser is expected to poll for the real result rather than treat this response as the final answer.

**409 Conflict for a business-rule collision.** The same action catches `ActiveScanError` (thrown by `enqueueScan()` when a non-terminal scan already exists for the shop, `app/app/services/scan/queue.server.ts:63-68`) and turns it into `json({ error: "A scan is already running for this shop." }, { status: 409 })` (`api.scans.tsx:20-23`). `409` is the right code because the request is well-formed but conflicts with the current server state — not a validation error (`400`), not a missing resource (`404`).

**404 for "not found or not yours."** Two different 404 paths exist in this repo and they mean subtly different things by design. `api.scans.tsx:24-26` returns a JSON `404` when `ScanNotFoundError` is thrown. `app/app/routes/app.scans.$id.tsx:83-88` throws a bare `Response("Not found", { status: 404 })` when `getScanSummary` can't find the scan for *this* shop's session — which is also the response for "the scan exists but belongs to a different store," a deliberate choice: `getScanSummary`/`getScanFindings` are per-shop authorized reads (per the project context), so a cross-tenant lookup fails the same way a nonexistent one does, rather than leaking a `403` that would confirm the scan ID is real.

**Webhook status codes control Shopify's redelivery, not this app's retry logic.** `webhooks.compliance.tsx:26-28` throws `new Response("Unhandled webhook topic", { status: 404 })` for any topic outside the three it switches on. Every successful branch returns a bare `new Response()` — Remix defaults that to `200`. This matters because Shopify's own delivery system watches the status code: a non-2xx response makes Shopify schedule a retry on its own backoff, entirely outside this app's control — see `07-timeouts-retries-pooling-and-backpressure.md` for the contrast with the retry logic this app *does* own (the outbound GraphQL calls).

**Frame-ancestors, not CORS — the actual cross-origin concern here.** This is an embedded app running inside Shopify's admin iframe (`embedded = true`, `shopify.app.toml:6`). The header that matters for that is `Content-Security-Policy: frame-ancestors`, not `Access-Control-Allow-Origin` — the browser needs to be *told it's allowed to frame this app inside admin.shopify.com*, which is a framing policy, not a cross-origin-fetch policy. That header is set by the Shopify SDK's own helpers: `addDocumentResponseHeaders` (called from `app/app/entry.server.tsx:19`, imported from `shopify.server.ts:54`) and `boundary.headers` (`app/app/routes/app.tsx:39-41`). This repo never sets `Access-Control-Allow-Origin` anywhere — a repo-wide grep confirms it — because nothing in this app's own JavaScript makes a cross-origin `fetch()` call to a different domain that would need one. The one place that looks like it could be cross-origin, the CSV export button in `app/app/routes/app.scans.$id.tsx:583-585` (`<Button url={...} external>`), is a full browser navigation to `/api/scans/:id/export`, not a JavaScript fetch — so no CORS preflight is ever involved.

```
  Layers-and-hops — the framing-policy hop vs. the CORS hop that doesn't exist here

  ┌─ Shopify admin (admin.shopify.com) ─┐  iframe src   ┌─ this app ────┐
  │  parent page                          │──────────────►│  CSP: frame-   │
  │                                        │◄ ─ ─ allowed ─│  ancestors set │
  └────────────────────────────────────────┘               └────────────────┘
                                     (this is the real cross-origin concern)

  ┌─ this app's own JS ─┐  NO cross-origin fetch() anywhere in this repo
  │  no CORS headers set │  → nothing to permit, nothing missing
  └───────────────────────┘
```

**Caching — absent because nothing here is cacheable in the way `Cache-Control` assumes.** No route in this app sets `Cache-Control`. Every loader reads per-shop, per-scan, authorization-gated data (`getScanSummary`, `getScanFindings`) that's wrong to cache across sessions and changes on every poll anyway (scan status updates every 2.5 seconds while a scan is in flight) — caching it would mean serving stale scan progress. The one genuinely static, cacheable asset the app depends on — Shopify's shared Inter font CSS (`root.tsx:16-19`) — is served from `cdn.shopify.com`, not this app, so its cache headers are Shopify's to set, not this repo's.

### Move 3 — the principle

Status codes and CORS/caching headers are both *interfaces*, not implementation details — a `409` tells every future caller of this endpoint "conflict, don't retry blindly," the way a type signature tells a caller what to expect, without either side needing to read the other's source. Skipping CORS and caching here isn't an omission to fix; it's the correct response to a system with no cross-origin fetch consumer and no cacheable-across-sessions data.

## Primary diagram

```
  HTTP semantics across every route family in this repo

  ┌─ POST /api/scans ────────────────────────────────────────┐
  │  202 Accepted   → queued, poll for status                  │
  │  409 Conflict    → active scan exists                       │
  │  404 Not Found   → shop/settings missing                    │
  └───────────────────────────────────────────────────────────┘

  ┌─ GET /app/scans/:id ──────────────────────────────────────┐
  │  200 + loader data     → normal render                      │
  │  404 (thrown Response) → not found OR belongs to other shop │
  └───────────────────────────────────────────────────────────┘

  ┌─ POST /webhooks/* ─────────────────────────────────────────┐
  │  200 (bare Response())  → Shopify stops retrying             │
  │  404 (unhandled topic)  → Shopify's OWN redelivery kicks in  │
  └───────────────────────────────────────────────────────────┘

  ┌─ Cross-origin / caching ───────────────────────────────────┐
  │  CSP frame-ancestors: set (delegated to Shopify SDK helpers) │
  │  Access-Control-Allow-Origin: NOT SET anywhere (no need)      │
  │  Cache-Control: NOT SET anywhere (nothing here is cacheable)  │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The `frame-ancestors` vs. CORS distinction is one of the more commonly confused pieces of browser security policy — both look like "which origins can talk to me," but one governs *framing* (can you embed me in an iframe) and the other governs *fetch/XHR* (can your JavaScript read my response). Embedded Shopify apps need the former and, absent a public API consumed by third-party JS, often don't need the latter at all — which is exactly this repo's shape.

## Interview defense

**Q: Why is a duplicate scan request a 409 and not a 400?**
The request itself is perfectly well-formed — a valid shop asking to start a scan. It conflicts with existing server state (an active scan), which is precisely what `409 Conflict` means; `400` would incorrectly suggest something was wrong with the request body/params. Anchor: `api.scans.tsx:20-23`, `queue.server.ts:63-68`.

**Q: This app doesn't set any CORS headers. Is that a bug?**
No — CORS headers permit cross-origin JavaScript `fetch`/XHR, and nothing in this codebase makes one. The actual cross-origin concern for an embedded Shopify app is framing (`frame-ancestors` in the CSP), which the Shopify SDK's `addDocumentResponseHeaders`/`boundary.headers` set. Anchor: `entry.server.tsx:19`, `app.tsx:39-41`.

## See also

- `04-tls-and-trust-establishment.md` — the trust layer these status codes sit on top of
- `06-websockets-sse-streaming-and-realtime.md` — the polling loop that repeatedly hits the `GET /app/scans/:id` semantics above
- `07-timeouts-retries-pooling-and-backpressure.md` — what a non-2xx webhook response actually costs (Shopify's own redelivery schedule)
