# 05 — Sanitized failure boundary

**Generic error responses / safe error messaging (information-disclosure prevention).** Industry standard concept (OWASP: verbose error messages as an information-leak vector) — project-specific implementation (the `failureMessageSafe` seam, recurring across the scan pipeline).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ External — Shopify Admin GraphQL API ──────────────────────────────┐
│  can fail: throttled, malformed response, transient 5xx               │
└──────────────────────────┬─────────────────────────────────────────┬─┘
                            │ real error (query text, stack, upstream │
                            │ error body) — DANGEROUS to expose        │
                            ▼                                         │
┌─ Service layer — runner.server.ts / worker-core.server.ts ──────────┤
│         ★ THIS CONCEPT: the sanitized failure boundary ★             │ every catch
│  catch → console.error(real error) → write GENERIC message to DB     │ block
└──────────────────────────┬─────────────────────────────────────────┬─┘
                            │ failureMessageSafe: a fixed, safe string │
                            ▼                                         │
┌─ Client — embedded admin UI ─────────────────────────────────────────┘
│  sees only the generic message, never the underlying error            │
└─────────────────────────────────────────────────────────────────────────┘
```

Every failure in the scan pipeline touches something an attacker (or just a curious merchant) could learn from if it leaked verbatim: GraphQL query text (reveals internal schema assumptions), Prisma error messages (can reveal table/column names or constraint internals), Shopify's own upstream error bodies (may contain request internals). This app's answer, applied consistently rather than ad hoc per route, is: log the real thing where only the operator can see it, return a fixed generic string everywhere else.

## Structure pass

**Axis: trust — what does the caller learn when something goes wrong?** Trace the same question across every failure site in the pipeline:

```
One axis, three failure sites — "what does the caller see on failure?"

┌─ catalog-reader.server.ts:232-236 ──┐  → fixed string: "Failed to read
│  GraphQL error body (query text,      │     catalog from Shopify: the
│  schema internals) available here     │     GraphQL request returned errors."
└──────────────────────────────────────┘

┌─ runner.server.ts:208-224 ───────────┐  → fixed string: GENERIC_FAILURE_
│  real `err` (any exception from the   │     MESSAGE, "The scan could not
│  whole read→normalize→check→persist   │     be completed. Please try again."
│  pipeline) available here             │
└──────────────────────────────────────┘

┌─ worker-core.server.ts:44-75 ────────┐  → fixed string: same generic
│  admin-factory failure (uninstalled   │     message, distinct failureCode
│  shop's session already deleted)      │     ("ADMIN_UNAVAILABLE")
└──────────────────────────────────────┘

              same answer at every altitude: real error → server log only
                                              generic string → everything else
```

**Seam:** the boundary is wherever a `catch` block sits between "an exception with real detail" and "a value written to `Scan.failureMessageSafe` or returned to an HTTP caller." The naming convention itself (`failureMessageSafe` as a distinct column from whatever the real error was) makes the seam visible in the schema, not just in code discipline.

## How it works

You already reach for this instinctively in any production system: you don't return a raw stack trace to a user-facing error page, you show "something went wrong" and log the real thing where an engineer can find it. The scan pipeline here does the same thing, consistently, at every point something outside this app's control (Shopify's API, a database write) can fail.

### The kernel — isolate it

```
Sanitized failure boundary kernel

  try {
    <operation that can throw for reasons outside this app's control>
  } catch (err) {
    console.error(<context>, err)          // full detail, SERVER-SIDE ONLY
    <persist or return>(GENERIC_MESSAGE)   // fixed string, never `err.message`
  }
```

**What breaks if you return `err.message` instead of the fixed string:** a Prisma constraint-violation error can name the exact column and constraint that failed; a GraphQL error body can echo back query text or Shopify-internal error codes; a network error can include hostnames or internal retry-count details. None of these are secrets exactly, but all of them are reconnaissance value for free — information a legitimate error page has no business handing to whoever's looking at it, whether that's a curious merchant or someone actively probing for how the backend is built.

**`runner.server.ts`'s version — the pipeline-wide catch-all:**
```ts
// app/app/services/scan/runner.server.ts:11-12, 208-224
const GENERIC_FAILURE_MESSAGE =
  "The scan could not be completed. Please try again.";
// ...
} catch (err) {
  // Log the real error server-side only — never expose internals
  // (query text, stack traces, upstream error text) to the scan record
  // or, transitively, to end users (spec: no internal leakage to end users).
  console.error(`[scan:${scanId}] scan run failed`, err);

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "SCAN_FAILED",
      failureMessageSafe: GENERIC_FAILURE_MESSAGE,
    },
  });
}
```
This one `catch` sits around the *entire* read → normalize → check → persist pipeline (`runScan`, `runner.server.ts:59-225`) — a Shopify API failure, a Prisma write failure, a bug in a check function, all funnel through the same sanitization point. **What breaks if each stage had its own separate catch with its own message:** every new failure mode added later would need its own sanitization decision made correctly, instead of inheriting it automatically from one boundary that already exists.

**`catalog-reader.server.ts`'s version — sanitizing at the point of contact with the untrusted third party, before the error even reaches the pipeline's own catch:**
```ts
// app/app/services/shopify/catalog-reader.server.ts:232-236
// Don't leak internal GraphQL error details (query text, schema
// internals, etc.) to callers/logs beyond this safe message.
throw new Error(
  "Failed to read catalog from Shopify: the GraphQL request returned errors.",
);
```
This matters as a *second* layer, not a redundant one: even the error `runner.server.ts`'s catch block logs via `console.error` is already scrubbed of raw GraphQL error bodies by the time it gets there — a defense-in-depth choice, since `console.error`'s output could itself end up somewhere less trusted than the original intent (a log aggregator with different access controls than the production database, for instance).

**`worker-core.server.ts`'s version — the poison-pill case, where the failure isn't even inside `runScan`'s own try/catch:**
```ts
// app/app/services/scan/worker-core.server.ts:56-74
} catch (err) {
  console.error(
    `[worker-core] admin factory failed for scan ${scan.id} (shop ${scan.shop.shopDomain})`,
    err,
  );
  await prisma.scan.update({
    where: { id: scan.id },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "ADMIN_UNAVAILABLE",
      failureMessageSafe:
        "The scan could not be completed. Please try again.",
    },
  });
  return scan.id;
}
```
**What this specific catch defends against, beyond information disclosure:** the comment above it (`worker-core.server.ts:47-59`) names a livelock hazard — if obtaining the Admin client for an uninstalled shop's leftover queued scan threw *unhandled*, the worker would re-select that same broken scan on every poll forever, since it always claims the globally-oldest QUEUED row. Sanitizing the failure here isn't only about not leaking Shopify's internal error text; it's also what lets the worker mark this scan FAILED and move on to the next shop's scan instead of getting stuck. The security property (no leaked internals) and the availability property (no livelock) are enforced by the same one catch block.

**The `failureCode` field is a deliberate, narrow exception to "never expose detail."** `SCAN_FAILED` and `ADMIN_UNAVAILABLE` are coarse-grained enum-like strings, not the underlying exception — they carry just enough signal for an operator dashboard to distinguish failure classes without ever reconstructing what actually went wrong from the code alone. That's the right amount of detail to expose: useful for triage, useless for reconnaissance.

## Primary diagram

```
Sanitized failure boundary — every catch, same discipline

┌─ Shopify Admin GraphQL API ─────────────────────────────────────────┐
│  THROTTLED / malformed / genuine query error                          │
└──────────────────────────┬───────────────────────────────────────────┘
                            ▼
┌─ catalog-reader.server.ts:232-236 ───────────────────────────────────┐
│  scrub → generic "Failed to read catalog from Shopify..." Error       │
└──────────────────────────┬───────────────────────────────────────────┘
                            ▼
┌─ runner.server.ts:208-224 (pipeline-wide catch) ─────────────────────┐
│  console.error(full detail) ── SERVER LOGS ONLY, never persisted      │
│  prisma.scan.update(failureMessageSafe = GENERIC_FAILURE_MESSAGE)     │
└──────────────────────────┬───────────────────────────────────────────┘
                            ▼
┌─ api.scans.$id.tsx (loader) ─────────────────────────────────────────┐
│  returns scan summary INCLUDING failureMessageSafe — never the raw   │
│  error, because it was never written down anywhere the API can read  │
└──────────────────────────┬───────────────────────────────────────────┘
                            ▼
┌─ Embedded admin UI (merchant's browser) ─────────────────────────────┐
│  "The scan could not be completed. Please try again."                 │
│  — no query text, no stack trace, no upstream error body, ever        │
└───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same discipline behind "don't return a 500 page with a stack trace in production" — OWASP calls the failure mode this defends against "improper error handling" / verbose error messages, and it's a perennial finding in real security audits precisely because it's easy to get right in the happy path and forget in the tenth edge-case catch block someone adds six months later. What makes this codebase's version worth studying rather than assuming: the pattern is *centralized enough* to survive that six-months-later addition — a new failure mode added to `runScan` inherits the sanitization for free, because it's still inside the one enclosing try/catch, rather than needing its own new decision made correctly.

## Interview defense

**Q: What's the difference between this and just wrapping every route in a generic 500 handler?**
A: A generic top-level 500 handler protects against *unhandled* exceptions reaching the client; this pattern protects against *handled* ones too — a Shopify API failure here is fully anticipated and caught, and even so, the anticipated, expected failure path still sanitizes what it persists. The risk this closes isn't "the app crashed and leaked a stack trace," it's "the app worked exactly as designed and still would have leaked internals if the catch block just relayed `err.message`."

**Q: Why log the real error at all, if the goal is not leaking internals?**
A: Because "never expose internals to the end user" and "never record internals anywhere" are different requirements — an operator debugging a real production failure needs the actual error, and `console.error` writes to server-side logs that (in this app's deployment) only reach `fly logs`, not the database row the API reads from or the merchant's browser. The sanitization boundary is specifically at the point where data crosses from "operator-visible" to "merchant-visible or persisted-to-a-row-the-API-serves," not at "was this ever written down anywhere."

**Q: This same defensive shape (catch → log real, expose generic) appears in three separate files. Why isn't it one shared helper?**
A: A fair critique — right now the discipline is enforced by convention (a doc comment at each site explaining the same reasoning) rather than by a shared `sanitizeAndFail()` utility that all three call. The current shape is defensible for three call sites with slightly different persistence targets (`Scan.failureMessageSafe` vs. a thrown `Error` vs. a route-level `Response`), but a fourth call site added later without noticing the existing convention is exactly the failure mode a shared helper would close. That's the concrete "what would change this" answer: once there's a fourth site, extract it.

## See also

- `04-gdpr-compliance-webhooks.md` — the same "log the safe thing, never the dangerous thing" discipline, applied to webhook payload logging instead of pipeline errors.
- `audit.md` → lens 1 (trust boundaries — the GraphQL response as a third-party trust boundary) and lens 5 (data exposure).
