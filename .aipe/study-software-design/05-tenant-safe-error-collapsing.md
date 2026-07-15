# Tenant-safe error collapsing (`ScanNotFoundError`)

### Information hiding for security / existence-leak prevention — Project-specific (a named instance of a general pattern)

## Zoom out, then zoom in

```
  Zoom out — where the collapsed error lives

  ┌─ Route layer ────────────────────────────────────────────────┐
  │  api.scans.$id.tsx      api.scans.$id.export.tsx              │
  │       │  catch (ScanNotFoundError) → 404, same message either │
  │       │  way (wrong-shop vs. missing-scan look identical)     │
  └───────┼────────────────────────────────────────────────────┘
          │
  ┌─ Service layer (scan-api.server.ts) ─────────────────────────┐
  │  ★ loadOwnedScan / resolveShopOrThrow ★  ← THIS CONCEPT        │
  │  three distinct real conditions → ONE thrown error type       │
  └─────────────────────┬────────────────────────────────────────┘
                        │
  ┌─ Storage layer ──────▼───────────────────────────────────────┐
  │  Scan table (shopId column — the actual ownership check)      │
  └────────────────────────────────────────────────────────────┘
```

A merchant's scan id is guessable-ish (it's a cuid, not sequential, but
still an opaque string a curious or malicious actor could try swapping
into a URL). The question this pattern answers: when shop A requests
scan id X that belongs to shop B, what does shop A get told? The answer
this codebase gives — deliberately — is "the exact same thing you'd get
for a scan id that doesn't exist at all."

## Structure pass

**Axis: what information does an error response leak?**

```
  Trace "what does the caller learn from an error" across three real cases

  case 1: scan id doesn't exist anywhere      → ScanNotFoundError → 404
  case 2: scan id exists, belongs to shop B   → ScanNotFoundError → 404
  case 3: shop domain itself doesn't resolve  → ScanNotFoundError → 404

  same axis answer for all three: "learns nothing distinguishing them"
```

**Seam — the boundary between "ownership check" and "existence check" is
deliberately erased.** `loadOwnedScan`
(`scan-api.server.ts:108-120`) does both checks in one function and
throws one error type for both failure modes:

```typescript
async function loadOwnedScan(shop: { id: string }, scanId: string) {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } });
  if (!scan || scan.shopId !== shop.id) {
    throw new ScanNotFoundError(`Scan not found: ${scanId}`);
  }
  return scan;
}
```
A less careful version of this function would throw `ScanNotFoundError`
for "no row" and a distinct `ScanForbiddenError` (or a 403) for "row
exists, wrong owner." That distinction is exactly the leak this pattern
exists to prevent — a 403 vs. 404 difference tells an attacker whether the
id they guessed belongs to *someone*, even if not to them.

**Ordering matters and is checked explicitly — the seam that makes this
airtight.** `getAllFindingsForExport`
(`scan-api.server.ts:286-304`) checks ownership (`loadOwnedScan`,
line 291) *before* checking completion status (line 293). The doc comment
above the function (lines 17-24) states this precisely: "Checked *after*
ownership... so a wrong-owner request still resolves to
`ScanNotFoundError`, never leaking another tenant's scan status." If the
completion check ran first, a wrong-shop caller could learn "this scan
exists and isn't done yet" (a `ScanNotCompletedError` → 409) before ever
being told they don't own it — leaking the existence *and* the status of
another tenant's resource through a completely different error path than
the one this pattern closes.

## How it works

### Move 1 — the mental model

You've built a login form that says "invalid email or password" instead
of "that email doesn't exist" — same shape, one layer deeper: instead of
collapsing two *messages* into one, this collapses two *exception types*
into one, so every layer above the service function (the route, the HTTP
status mapper) physically cannot tell the cases apart even if it wanted
to.

```
  The kernel

  three real conditions:
    (a) no Scan row with this id
    (b) Scan row exists, scan.shopId !== caller's shopId
    (c) shop domain itself unknown
       │
       ▼
  ONE thrown type: ScanNotFoundError
       │
       ▼
  ONE HTTP mapping: 404, generic message, at every route that touches it
```

### Move 2 — the walkthrough

**Every read path funnels through the same two gate functions.**
`resolveShopOrThrow` (`scan-api.server.ts:100-106`) and `loadOwnedScan`
(108-120) are called at the top of `getScanSummary` (161-168),
`getScanFindings` (225-237), and `getAllFindingsForExport` (286-291) — all
three public read functions the routes call. There is no fourth path that
loads a `Scan` row without going through one of these two gates first
(confirmed by reading every exported function in this file: `startScan`,
`getActiveScanForShop`, `getScanSummary`, `getScanFindings`,
`getAllFindingsForExport` — the two unauthenticated cases,
`startScan`/`getActiveScanForShop`, only ever look up by the caller's own
resolved shop, never by an externally-supplied scan id).

**The route layer inherits the collapse for free — it doesn't re-decide
anything.**
```typescript
// app/app/routes/api.scans.$id.export.tsx:40-48
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
The route's `catch` block has exactly two `instanceof` branches. It never
sees "wrong owner" as a distinct case because the service layer never
produced one — the route can't leak what it was never told.

**A second, narrower error type exists specifically so completion-status
information is *not* over-collapsed.** `ScanNotCompletedError`
(line 25) is intentionally a *different* error from
`ScanNotFoundError` — the doc comment (lines 16-24) is explicit that this
distinction is safe to expose *because* it only fires after ownership is
already confirmed. This is the pattern's real subtlety: collapsing
information is not "hide everything" — it's "hide exactly the fact that
would leak tenant existence, and nothing else." A scan the caller
legitimately owns but that isn't finished yet gets a precise 409, not a
generic 404.

## Primary diagram

```
  What three different real failures look like from outside

  shop A requests scan X:

  X doesn't exist anywhere        ──┐
  X exists, owned by shop B       ──┼──► loadOwnedScan throws
  shop A's domain doesn't resolve ──┘    ScanNotFoundError
                                              │
                                              ▼
                                    every route: 404 "Not found"
                                    (identical response, all 3 cases)

  X exists, owned by shop A, not COMPLETED yet:
                                    getAllFindingsForExport throws
                                    ScanNotCompletedError
                                              │
                                              ▼
                                    409 "Scan is not complete"
                                    (a DIFFERENT, precise response —
                                     safe because ownership already passed)
```

## Elaborate

This is information hiding applied to a security boundary rather than an
implementation detail — the general principle (don't expose internal
state distinctions the caller doesn't need) is the same one that makes
`money.ts` or the scan state machine deep modules; here the "internal
state" being hidden is "does this resource exist for someone else,"
which is exactly the kind of fact a multi-tenant API must never
distinguish in its error surface. The transferable version of this
lesson: whenever an authorization check and an existence check can fail
independently, collapse them to the same externally-visible outcome, and
order any *subsequent* checks (like completion status here) strictly
after the ownership gate — never before it.

## Interview defense

**Q: "How would you test that this doesn't leak tenant existence?"**
A: Two requests: one for a scan id that truly doesn't exist, one for a
real scan id belonging to a different shop, both from shop A's session.
Assert the HTTP status, body, and headers are byte-identical (or at least
that no field varies) between the two responses — not just that both
happen to be "some 404." `scan-api.test.ts` exercises the wrong-owner and
not-found cases resolving to the same `ScanNotFoundError` type, which is
the property that guarantees the routes can't diverge on it.

**Q: "Why is `ScanNotCompletedError` a separate type instead of also
being folded into `ScanNotFoundError`?"**
A: Because by the time that check runs, ownership is already confirmed —
telling a scan's *owner* that their own scan isn't done yet leaks nothing
about another tenant. Over-collapsing here would just make the export
route's error messages less useful with no security benefit; the pattern
is "hide the specific fact that's dangerous," not "hide everything."

**Q: "Where's the edge this pattern doesn't cover?"**
A: Timing. Both `ScanNotFoundError` paths involve slightly different
database work (a shop lookup that fails immediately vs. a shop lookup
that succeeds, then a scan lookup, then an ownership comparison) —
if an attacker could measure response-time differences precisely enough,
that's a side channel this pattern doesn't close. At MVP scale, over a
real network, that's not a practical risk worth building constant-time
comparisons for — but it's the honest boundary of what "same error type"
actually guarantees.

## See also

- `audit.md` lens 4 (layers) and lens 6 (errors) — where this pattern is
  first named.
- `app/app/services/scan/scan-api.server.ts` — the full gate implementation.
- `test/scan-api.test.ts` — the ownership/not-found test coverage.
