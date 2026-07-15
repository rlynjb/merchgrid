# Negative-space authorization testing (tenant-isolation tests)

### Industry names: negative testing / authorization boundary test / multi-tenant isolation test — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Route layer ─────────────────────────────────────────────────┐
  │  api.scans.$id.tsx, api.scans.$id.export.tsx                    │
  │       (authenticate.admin(request) resolves the caller's shop)   │
  └──────────────────────────┬─────────────────────────────────────┘
                             │ shopDomain passed down
  ┌─ scan-api.server.ts ───────▼───────────────────────────────────┐
  │  ★ loadOwnedScan(shop, scanId) ★  — the ownership check          │ ← we are here
  │  same ScanNotFoundError for "doesn't exist" AND "wrong owner"      │
  └──────────────────────────┬─────────────────────────────────────┘
                             │
  ┌─ Test layer ───────────────▼───────────────────────────────────┐
  │  scan-api.test.ts — asserts what a wrong-shop caller does NOT     │
  │  learn, not just what a right-shop caller gets                     │
  └────────────────────────────────────────────────────────────────┘
```

Most tests assert "given this input, I get this output." This pattern
asserts something harder to get right: "given a caller who should be denied,
they get *exactly the same response shape* as a caller asking about
something that never existed" — so a wrong-tenant request can never learn
anything about a scan it doesn't own, not even whether it exists.

## Structure pass

**Layers:** `shopDomain` (asserted caller identity, from the authenticated
session) → `loadOwnedScan` (the single ownership gate) → every reader
function (`getScanSummary`, `getScanFindings`, `getAllFindingsForExport`)
that calls it.

**Axis: what does a wrong-tenant caller learn?** This is the axis this
pattern is built to hold at zero, and the tests are what prove it stays
there:

```
  "what does an attacker asking about shop B's scan ID learn from shop A?"

  scan doesn't exist at all:        ScanNotFoundError
  scan exists, owned by shop B:     ScanNotFoundError   ← SAME error, same message shape
  scan exists, still QUEUED:        (see precedence test below)
```

If those first two rows returned *different* errors, a caller could binary-
search across scan IDs and learn which ones exist for other tenants —
existence itself becomes the leak, even with zero data returned. Collapsing
both cases to the same error is the whole point.

**Seam:** `loadOwnedScan` in `scan-api.server.ts:108-120` is the one place
this collapse happens; every reader function funnels through it rather than
each writing its own ownership check.

## How it works

### Move 1 — the mental model

You've written an `if (resource.ownerId !== currentUser.id) return 404`
check before — the standard move for "don't leak someone else's row." The
part that's easy to get subtly wrong is treating "doesn't exist" and
"exists but isn't yours" as two different code paths that happen to both
return a 404 today — if they ever drift (one becomes a 403, one gets a
slightly different message), the difference itself becomes an oracle an
attacker can use to enumerate valid IDs.

```
  the trap                              the fix (this codebase)
  ────────                              ────────────────────────
  if (!scan) throw NotFound              if (!scan || scan.shopId !== shop.id)
  if (scan.shopId !== shop.id)             throw ScanNotFoundError(...)
    throw Forbidden                        — ONE branch, ONE error type,
  — two branches, two error shapes         indistinguishable from outside
```

### Move 2 — the walkthrough

**The ownership check collapses both failure modes into one.**

```typescript
// app/services/scan/scan-api.server.ts:114-120
async function loadOwnedScan(shop: { id: string }, scanId: string) {
  const scan = await prisma.scan.findUnique({ where: { id: scanId } });
  if (!scan || scan.shopId !== shop.id) {
    throw new ScanNotFoundError(`Scan not found: ${scanId}`);
  }
  return scan;
}
```

The comment directly above `ScanNotFoundError`'s class declaration
(`scan-api.server.ts:6-13`) states the reasoning explicitly: *"the API
never confirms or denies that a scan id belongs to some other shop."*

**Every reader is tested against both failure modes, asserting the same
error type.** `scan-api.test.ts` runs this exact pair for `getScanSummary`
(`scan-api.test.ts:162-178`), `getScanFindings`
(`scan-api.test.ts:304-313`), and `getAllFindingsForExport`
(`scan-api.test.ts:571-588`) — three different reader functions, the same
two-case shape each time:

```
  test-per-reader pattern (repeated 3x)

  it("throws ScanNotFoundError when a different shop requests X")
      shopA owns scan  →  shopB requests it  →  expect ScanNotFoundError

  it("throws ScanNotFoundError for a nonexistent scan id")
      no scan exists   →  shopA requests it  →  expect ScanNotFoundError
```

**A precedence test proves the ordering, not just the outcome.** The
sharpest test in this file is the one that names *which check runs first*
when two failure conditions could both apply:

```typescript
// scan-api.test.ts:619-627
it("authz precedence: a wrong-owner request for a non-completed scan still throws ScanNotFoundError, not ScanNotCompletedError", async () => {
  const shopA = await seedShop("scan-api-export-authz-precedence-a.myshopify.com");
  const shopB = await seedShop("scan-api-export-authz-precedence-b.myshopify.com");
  const scan = await seedScan(shopA.id, { status: "QUEUED" });

  await expect(
    getAllFindingsForExport(shopB.shopDomain, scan.id),
  ).rejects.toThrow(ScanNotFoundError);
});
```

`getAllFindingsForExport` has *two* possible rejections: `ScanNotFoundError`
(wrong owner) and `ScanNotCompletedError` (right owner, scan not done yet).
This test seeds a scan that's both wrong-owner *and* not-completed, and
asserts the *authorization* error wins. Read the source ordering that makes
this true:

```typescript
// scan-api.server.ts:286-296 (trimmed)
export async function getAllFindingsForExport(shopDomain, scanId) {
  const shop = await resolveShopOrThrow(shopDomain);
  const scan = await loadOwnedScan(shop, scanId);   // ownership FIRST
  if (scan.status !== "COMPLETED") {
    throw new ScanNotCompletedError(...);            // completion gate SECOND
  }
  ...
}
```

If that ordering were flipped, a wrong-tenant caller could learn a scan
they don't own hasn't completed yet — a smaller leak than full data
exposure, but still information about another tenant's resource they should
never receive. The test pins the ordering, not just the final error type,
so a future refactor that accidentally swaps the two checks fails loudly.

### Move 3 — the principle

The generalizable move: when two failure conditions can both be true for
the same request, test which one wins — don't just test that *a* rejection
happens. Authorization checks belong ahead of any check that could reveal
state about a resource the caller doesn't own, and the only way to prove
that ordering holds (and keeps holding after a refactor) is a test that
deliberately constructs a request where both conditions are true at once.

## Primary diagram

```
  The full authorization test matrix, per reader function

                          scan doesn't exist      scan exists, wrong shop
  getScanSummary          ScanNotFoundError    →  ScanNotFoundError
  getScanFindings          ScanNotFoundError    →  ScanNotFoundError
  getAllFindingsForExport  ScanNotFoundError    →  ScanNotFoundError
                                                     │
                                                     │ + precedence test:
                                                     ▼
                                          wrong shop AND not-completed
                                          → STILL ScanNotFoundError
                                            (ownership checked first)
```

## Elaborate

This is the same discipline security engineers call "avoiding an oracle" —
any observable difference between "resource doesn't exist" and "resource
exists but you can't have it" is itself exploitable information, even when
zero actual data leaks. The classic real-world version is login forms that
say "no such user" vs. "wrong password," which lets an attacker enumerate
valid usernames without ever guessing a password. This codebase applies the
identical principle to scan IDs. `study-security` would go deeper on the
threat-model side of this (what an attacker could do with tenant
enumeration); this file stays on the testing side — the point here is that
the *test* asserting "no oracle" has to construct the adversarial case
(both failure modes true at once) rather than testing each mode in
isolation, or the precedence bug would slip through untested.

## Interview defense

**Q: Why does `loadOwnedScan` throw the same error for "scan doesn't
exist" and "scan exists but belongs to another shop"?**
Because if those returned different errors, an attacker could tell the two
cases apart from the outside and enumerate which scan IDs exist for other
tenants — existence itself becomes a leak, independent of whether any
actual finding data is exposed.

**Q: What does the "authz precedence" test actually prove that the two
simpler tests don't?**
The simpler tests each prove one failure mode raises the right error in
isolation. The precedence test constructs a request where *both* failure
conditions are true simultaneously (wrong shop AND not-completed) and
asserts the authorization check wins — proving the ordering in the source,
not just that some rejection happens. Without it, a refactor that
accidentally checked completion status before ownership would leak "this
scan isn't done yet" to a caller who shouldn't even know the scan exists.

```
  two failure conditions, one request:  wrong owner + not completed
  test asserts:  ScanNotFoundError wins  (ownership gate runs first)
```

**Q: Would you write this same pattern for a single-tenant app?**
No — the entire pattern exists because this app is multi-tenant (every shop
is a tenant sharing one `Scan`/`Finding` table set). A single-tenant app has
no "wrong owner" case to collapse into "doesn't exist" in the first place.

## See also

- `audit.md` lens 5 (edge cases and error paths) — this pattern is the
  deepest instance of that lens.
- `02-sqlite-integration-test-harness.md` — every test here seeds multiple
  real `Shop` rows via that harness to construct the cross-tenant scenario.
- `study-security` (if generated) — the threat-model framing of why tenant
  enumeration matters; this file stays on the test-design side of that
  finding.
