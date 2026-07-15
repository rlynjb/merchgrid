# 02 — Per-shop tenant isolation

**Row-level authorization / anti-enumeration via same-error-shape (IDOR defense).** Industry standard concept (insecure direct object reference prevention) — project-specific implementation (`loadOwnedScan`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Trust boundary #1 — authenticate.admin ──────────────────────────┐
│  proves: this caller IS a real, currently-installed shop session   │
└──────────────────────────┬───────────────────────────────────────┬┘
                            │ session.shop = "proven-shop.myshopify.com"
                            ▼                                       │
┌─ Trust boundary #2 — scan-api.server.ts  ★ THIS CONCEPT ★ ────────┤
│  proves: this proven shop OWNS the scanId it's asking for           │
└──────────────────────────┬───────────────────────────────────────┬┘
                            ▼                                       │
┌─ Storage — one SQLite file, EVERY shop's Scan/Finding rows ────────┘
│  Scan.shopId, Finding.shopId — the only thing separating tenants   │
└──────────────────────────────────────────────────────────────────────┘
```

Authentication answers "is this a real shop session." It does not answer "does this shop own the specific scan id in the URL." Those are two different questions, and this app runs as **one process, one SQLite file, every installed shop's rows in the same tables** — so the second question is load-bearing on every single read. `scan-api.server.ts`'s `loadOwnedScan` is the one seam that answers it, reused by every route that touches a scan.

## Structure pass

**Axis: trust — what can an authenticated-but-wrong-tenant caller learn?** This is the textbook IDOR (insecure direct object reference) shape: a scan id looks like an opaque identifier, but if the app trusted it as a capability (whoever holds the id can read it), any authenticated shop could enumerate scan ids and read another merchant's pricing/margin/SKU data. The seam has to hold the answer at "nothing" — not "almost nothing," not "a 403 that at least confirms the id is real."

```
Trust flips at the ownership-check seam

axis traced = "what does an authenticated wrong-tenant request learn?"

┌─ above the seam (any proven shop) ─┐  seam: loadOwnedScan  ┌─ below (the row) ─┐
│ "give me scan X"                    │ ═══════╪═════════════► │ scan X, shopId=Y   │
│ requester's shopId = Z (Z ≠ Y)      │   (it flips here)       │ requester ≠ owner  │
└────────────────────────────────────────┘                          └──────────────────┘
                     both "doesn't exist" and "exists, not yours"
                     resolve to the SAME ScanNotFoundError / 404
```

**Why "same error shape" is the actual security property, not a nicety.** A naive implementation might return 404 for "no such scan" and 403 for "exists but not yours" — which leaks one bit per request: an attacker sweeping scan ids learns which ones are real, even without ever reading their contents. That's enough to fingerprint how many scans another shop has run, which is itself business-sensitive information this app has no business leaking. Collapsing both cases to one error, one status code, one message closes that channel entirely.

## How it works

You've built this shape before without the security framing: it's the same principle as a `.filter(item => item.userId === currentUserId)` on a list endpoint, or a WHERE clause that always includes the tenant id — except here it's centralized in one function every caller goes through, instead of re-derived per query.

### The kernel — isolate it

```
Per-shop authorization kernel

  resolveShopOrThrow(shopDomain)        // from session.shop, never client input
       │
  loadOwnedScan(shop, scanId)
       │
  fetch scan by id ALONE (no shopId in the WHERE clause)
       │
  compare: scan.shopId === shop.id ?
       │
     ┌─ no match, or no scan at all ──► throw ScanNotFoundError (SAME error, either way)
     └─ match ─────────────────────────► return scan
```

**What breaks if you fetch by id alone and skip the compare:** any authenticated shop, given any other shop's scan id (guessable — Prisma's `cuid()` ids are not sequential, but if this app ever migrated to sequential ids, or an id ever leaked via a shared link, a log line, a support ticket), reads that scan's full findings: prices, costs, margins, SKUs. That's not a hypothetical — it's the entire point of a row-level check existing at all.

**What breaks if the two failure cases return different errors:** the enumeration leak described above. This is the part people skip when they first build authz checks — they get the "must own it" comparison right but let the error handling betray which case fired.

```ts
// app/app/services/scan/scan-api.server.ts:108-120
/**
 * Loads the scan by id and verifies it belongs to `shop`. Throws
 * `ScanNotFoundError` for both "no such scan" and "scan belongs to another
 * shop" — deliberately the same error/message shape so a caller probing
 * scan ids from another tenant learns nothing.
 */
async function loadOwnedScan(shop: { id: string }, scanId: string) {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } });
  if (!scan || scan.shopId !== shop.id) {
    throw new ScanNotFoundError(`Scan not found: ${scanId}`);
  }
  return scan;
}
```

**Every caller goes through it — the discipline that makes this a control, not a one-off check.** `getScanSummary` (`scan-api.server.ts:161-168`), `getScanFindings` (`scan-api.server.ts:225-237`), and `getAllFindingsForExport` (`scan-api.server.ts:286-295`) all call `resolveShopOrThrow` then `loadOwnedScan` before doing anything else. The ordering in `getAllFindingsForExport` matters specifically: ownership is checked *before* the `scan.status !== "COMPLETED"` gate (`scan-api.server.ts:293-295`), so a wrong-owner request never learns even whether some other shop's scan has finished — if the completion check ran first, "409 not complete" vs "404 not found" would itself leak one bit about another tenant's scan state.

**The route layer never re-derives this — it just maps the error.** `api.scans.$id.tsx:43-48` and `api.scans.$id.export.tsx:40-48` both catch `ScanNotFoundError` and map it to a plain 404, with no route-specific authorization logic of its own:

```ts
// app/app/routes/api.scans.$id.tsx:30-48
try {
  const summary = await getScanSummary(session.shop, scanId);
  // ...
} catch (error) {
  if (error instanceof ScanNotFoundError) {
    return json({ error: "Not found" }, { status: 404 });
  }
  throw error;
}
```
This is the load-bearing design choice: authorization lives in exactly one place (the service layer), and every route is a thin wrapper that can't accidentally skip it or reimplement it slightly wrong. If a new route were added tomorrow that called `prisma.scan.findUnique` directly instead of going through `scan-api.server.ts`, it would bypass this control entirely — the seam only protects what actually goes through it.

**What's NOT re-derived per route: the shop identity itself.** `session.shop` always comes from the authenticated session (`authenticate.admin(request)`), never from a client-supplied parameter — `startScan(session.shop)` (`api.scans.tsx:16`) and `getScanFindings(session.shop, scanId, ...)` (`api.scans.$id.tsx:31,37`) both pass the session's own shop, so there's no path where a caller supplies "which shop am I" independently of who they authenticated as.

## Primary diagram

```
Per-shop tenant isolation — the full read path

┌─ Client (any authenticated shop) ──────────────────────────────────┐
│  GET /api/scans/:id  (scanId = someone else's scan, guessed/leaked) │
└──────────────────────────┬──────────────────────────────────────────┘
                            │ session token JWT
                            ▼
┌─ authenticate.admin (library) ──────────────────────────────────────┐
│  proves: caller is a real session for shop = "attacker-shop.myshop" │
└──────────────────────────┬──────────────────────────────────────────┘
                            │ session.shop = "attacker-shop..."
                            ▼
┌─ scan-api.server.ts:161-168  getScanSummary ────────────────────────┐
│  resolveShopOrThrow("attacker-shop...")  → shop row for attacker    │
│  loadOwnedScan(shop, scanId)                                        │
│    fetch scan by id → scan.shopId = "victim-shop-id"                │
│    "victim-shop-id" !== "attacker-shop-id"  →  ScanNotFoundError    │
└──────────────────────────┬──────────────────────────────────────────┘
                            ▼
┌─ api.scans.$id.tsx:43-48 ────────────────────────────────────────────┐
│  catch ScanNotFoundError → 404 { error: "Not found" }                │
│  (identical response to a scanId that never existed at all)         │
└───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the multi-tenant SaaS version of "insecure direct object reference" (OWASP A01, broken access control) — one of the most commonly exploited web app vulnerabilities precisely because it's easy to get authentication right and authorization wrong. The general fix pattern (scope every query by tenant id, derived from the authenticated session, never from client input) generalizes far past this codebase: it's the same shape whether the "tenant" is a Shopify shop, a Slack workspace, or a row in a multi-user SaaS database. The specific refinement here — collapsing "not found" and "not yours" into one response — is the anti-enumeration half of the same defense, and it's the part naive implementations most often skip.

## Interview defense

**Q: Why not just add `WHERE shopId = ?` to the query instead of fetching-then-comparing?**
A: Functionally equivalent and arguably tighter (never even materializes the wrong-tenant row) — either shape is defensible. The current code fetches by id alone and compares in application code, which reads slightly clearer for the "same error either way" requirement, since both branches (`!scan` and `scan.shopId !== shop.id`) explicitly hit the identical throw. A `WHERE shopId = ?` version would need the same explicit collapsing at the "zero rows returned" branch — worth calling out that whichever way you write the query, the discipline that matters is the *error handling*, not the SQL shape.

**Q: What's the actual capability an attacker gains if this check is missing?**
A: Full read access to any other installed shop's pricing, margin, cost, and SKU data — the entire findings set from any scan, by guessing or otherwise obtaining a scan id. In a single-tenant-per-database architecture this bug class doesn't exist; in a shared-table multi-tenant architecture like this one, it's the single most important check in the codebase.

**Q: This app is read-only — no mutations. Does that make missing authz here lower-severity?**
A: Lower blast radius (no data can be corrupted or deleted), but not lower severity as a *confidentiality* issue — margin and cost data is exactly the kind of information a merchant would consider commercially sensitive, and "read-only" only protects against integrity/availability attacks, not against a confidentiality breach like this one.

## See also

- `01-encrypted-session-storage-at-rest.md` — the boundary one layer up: what protects the token that gets you a `session.shop` in the first place.
- `.aipe/study-system-design/05-shop-scoped-authorization.md` — the same file walked from the architecture/single-seam-reuse angle.
- `audit.md` → lens 2 (authentication and authorization) and lens 5 (data exposure).
