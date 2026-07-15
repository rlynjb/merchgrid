# 05 — Shop-scoped authorization

**Row-level multi-tenancy / anti-enumeration via uniform error shape.** Industry standard pattern — project-specific implementation (`scan-api.server.ts`'s `loadOwnedScan`/`resolveShopOrThrow`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ UI layer ───────────────────────────────────────────────────┐
│  merchant's browser, one shop's App Bridge session             │
└──────────────────────────┬────────────────────────────────────┘
                            │ session.shop (from authenticate.admin)
┌─ Service layer ────────────▼───────────────────────────────────┐
│  scan-api.server.ts   ★ THIS CONCEPT ★  ← we are here          │
│  resolveShopOrThrow / loadOwnedScan — every read gated here      │
└──────────────────────────┬────────────────────────────────────┘
                            │ WHERE scanId=? AND shopId=?  (in effect)
┌─ Storage layer ────────────▼────────────────────────────────────┐
│  SQLite: one table, ALL shops' Scan/Finding rows mixed together  │
└────────────────────────────────────────────────────────────────┘
```

Every shop's data lives in the same tables — there's no per-tenant database, no schema-per-shop, no row-level security policy in SQLite itself (SQLite has none). The only thing standing between one merchant and another merchant's findings is application code checking ownership on every single read. This pattern is that check, done consistently and in a way that never confirms or denies another tenant's data exists.

## Structure pass

**Axis: trust — what can a caller who knows (or guesses) a scan id learn?** Without ownership checks: a merchant who knows or brute-forces a scan id (cuid, but still) could read another shop's pricing/margin/SKU data — a straight cross-tenant data leak in a multi-tenant SaaS app. With it: a wrong-owner request and a genuinely-nonexistent request are indistinguishable from the outside.

**Seam:** every public function in `scan-api.server.ts` resolves the shop *first*, then loads the scan and checks `scan.shopId === shop.id`, and only *then* does anything else (including a completion-status check). That ordering is the seam — get it backwards (check completion before ownership) and you leak "this scan exists and its status is X" to a caller who doesn't own it.

```
The seam — same error, two different real causes

axis traced = "what does the caller learn from an error?"

┌─ caller (any shop) ────┐   seam: ScanNotFoundError   ┌─ two real causes ─┐
│ sees ONE outcome:         │ ═══════════╪═════════════► │ scan doesn't exist  │
│ "not found" (404)          │  (both collapse to it)      │  OR belongs to       │
└─────────────────────────────┘                            │  another shop        │
                                                            └──────────────────────┘
```

## How it works

You've built a DB table with rows and a primary key before — the natural next question for any multi-tenant table is "how do I make sure a query only ever touches rows the caller is allowed to see?" This codebase answers it with one small helper that every read funnels through, rather than trusting each route to remember the check.

### The kernel — isolate it

```
Authorization kernel

  resolveShopOrThrow(shopDomain)  ──► Shop row, or throw ScanNotFoundError
       │
  loadOwnedScan(shop, scanId)     ──► Scan row IF scan.shopId === shop.id
       │                               ELSE throw ScanNotFoundError (SAME error)
       ▼
  (only now) any scan-specific gate, e.g. "is it COMPLETED yet?"
```

**What breaks if you swapped the order** (checked "is this scan completed" before ownership): a caller probing another tenant's scan id learns whether that scan is done or still running, from the *type* of error they get back — a real information leak, even without ever seeing the findings themselves.

### `loadOwnedScan` — one function, every read routes through it

```ts
// scan-api.server.ts:108-120
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

Notice this is a plain `findUnique({ where: { id: scanId } })` — not `findUnique({ where: { id: scanId, shopId: shop.id } })`. The ownership check happens *after* the fetch, in application code, not as part of the query's `WHERE` clause. Functionally equivalent for correctness (either way, a mismatched shop never gets the row back), but it means the authorization logic is readable in one place as an explicit `if`, not implicit in a query filter someone could accidentally drop from a future query.

**Every caller uses it** — `getScanSummary` (`scan-api.server.ts:161-168`), `getScanFindings` (`225-237`), and `getAllFindingsForExport` (`286-296`) all call `resolveShopOrThrow` then `loadOwnedScan` as their first two lines, before doing anything else specific to that function. That repetition is deliberate: there's no single "authorize this request" middleware in front of these — each function re-asserts ownership itself, so no future function can accidentally skip it by being added downstream of some other check.

### The export route — ownership checked before the completion gate

```ts
// scan-api.server.ts:286-296
export async function getAllFindingsForExport(shopDomain: string, scanId: string) {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);          // ownership FIRST

  if (scan.status !== "COMPLETED") {                        // status check SECOND
    throw new ScanNotCompletedError(`Scan not completed: ${scanId}`);
  }
  // ...
}
```

The doc comment above this function states the ordering rule explicitly: "Same per-shop authorization as `getScanSummary`, checked *before* the completion gate so a wrong-owner request still gets `ScanNotFoundError`, never leaking another tenant's scan status." This is the exact seam-ordering rule from the Structure pass, applied concretely — and it's the kind of detail that's easy to get backwards under time pressure, because both checks look like simple guard clauses and nothing forces you to order them correctly except discipline (and, ideally, a test).

### The route layer maps the same error to the same status code, every time

```ts
// api.scans.$id.export.tsx:40-48
} catch (error) {
  if (error instanceof ScanNotFoundError) {
    throw new Response("Not found", { status: 404 });
  }
  if (error instanceof ScanNotCompletedError) {
    throw new Response("Scan is not complete", { status: 409 });
  }
  throw error;
}
```

`app.scans.$id.tsx:81-88` does the identical mapping for the results page. **What breaks if these two routes mapped `ScanNotFoundError` to different status codes or messages:** an attacker could distinguish "wrong shop" from "genuinely missing" by which route they hit, even if neither route leaks it individually — consistency across every call site is what makes the anti-enumeration property actually hold system-wide, not just function-by-function.

### The denormalized `shopId` on `Finding` — authorization has a storage-layer echo

`schema.prisma:88-90` duplicates `shopId` directly onto the `Finding` table even though it's derivable by joining through `Scan`:

```
// schema.prisma:88-90
// Intentional denormalization: shopId is duplicated here (no relation/index
// by design) so shop-scoped finding queries and retention cleanup can filter
// without joining through Scan. Do not "fix" this into a relation.
```

This isn't the authorization check itself (that still runs in `scan-api.server.ts` via `loadOwnedScan` before any `Finding` query happens), but it's the same "shop boundary" concern showing up a second time, at the schema level, for a different reason: cheap shop-scoped bulk operations (like `redactShop`'s cascade delete) without an extra join.

## Move 3 — the principle

The strongest anti-enumeration property isn't "check ownership" — every reasonable multi-tenant app does that. It's "make every failure path — wrong owner, doesn't exist, wrong status — collapse to the *same observable outcome* from outside." The moment two different internal reasons produce two different external signals (different messages, different status codes, different response timing), you've built a side channel, even with correct authorization logic underneath.

## Primary diagram

```
Full recap — the authorization gate every read passes through

  shopDomain, scanId (from an authenticated request)
        │
  resolveShopOrThrow(shopDomain) ──► unknown domain? ──► ScanNotFoundError
        │ known shop
        ▼
  loadOwnedScan(shop, scanId) ──► scan missing OR scan.shopId≠shop.id?
        │                              └──► ScanNotFoundError (SAME error, both cases)
        │ owned
        ▼
  (optional) status-specific gate, e.g. COMPLETED-only for export
        │
        ▼
  data returned — only ever this shop's own rows
```

## Elaborate

This is the standard shape of row-level multi-tenancy enforced in application code rather than at the database layer (as, say, Postgres row-level-security policies would do). SQLite has no equivalent to RLS, so the discipline has to live in every function that touches a tenant-scoped table — which is exactly why this codebase centralizes it into two small helpers (`resolveShopOrThrow`, `loadOwnedScan`) that every caller must go through, rather than repeating the `shopId` check inline at each call site.

`not yet exercised`: no automated test explicitly named "cross-tenant scan id returns 404" was found in this pass — the guarantee is enforced by code structure and doc comments, not (as far as this audit inspected) a dedicated regression test. That would be the natural next thing to add if this pattern is worth defending in an interview.

## Interview defense

**Q: How does this app prevent one merchant from reading another merchant's scan?**
A: Every read goes through `loadOwnedScan`, which fetches by id and then checks `scan.shopId === shop.id` in application code, before returning anything. There's no per-tenant database or RLS — SQLite has neither — so this check is the entire boundary.

**Q: Why does a wrong-owner request return the exact same error as a nonexistent scan?**
A: To prevent enumeration — if wrong-owner and nonexistent returned different errors, a caller could learn that a given scan id belongs to *some* other shop even without ever seeing its contents. `loadOwnedScan` deliberately throws one error type for both cases (`scan-api.server.ts:114-119`).

**Q: What's the ordering rule that's easy to get wrong here?**
A: Authorization must be checked before any other gate that could reveal state — `getAllFindingsForExport` checks ownership before the "is this scan COMPLETED yet" check, specifically so a wrong-owner request can't learn whether another tenant's scan has finished (`scan-api.server.ts:290-294`).

## See also

- `04-encrypted-token-at-rest.md` — protects the token that lets an app act *as* a shop; this pattern protects data *within* the multi-tenant table once authenticated.
- `audit.md` → lens 1 (trust boundaries), lens 8 (system-design red flags).
