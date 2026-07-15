# Idempotency, Deduplication, and Delivery Semantics

At-least-once delivery / idempotent handlers — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where idempotency lives

  ┌─ Service layer ──────────────────────────────────────────┐
  │  worker-core: claimAndRunNext() → runScan()               │
  │  webhooks: app.uninstalled.tsx, compliance.tsx             │
  └───────────────────────┬────────────────────────────────────┘
                          │ "run/handle this again — is it safe?"
  ┌─ Storage layer ───────▼────────────────────────────────────┐
  │  ★ IDEMPOTENT WRITES ★ — upsert / deleteMany / updateMany  │ ← we are here
  │  atomic $transaction (delete-then-recreate findings)        │
  └───────────────────────────────────────────────────────────────┘
```

Two different kinds of "call this twice" happen in this repo, and both are
handled the same way despite looking unrelated: Shopify redelivers webhooks
at-least-once (its own docs say so explicitly), and a scan can be re-run
after a failure (a merchant retries, or an operator resets a stuck scan back
to `QUEUED`). In both cases the fix is the same primitive — **make the
operation safe to run more than once by construction**, rather than trying
to detect and reject the duplicate.

## Structure pass — layers, axis, seams

**Layers:** the caller that might call twice (Shopify's webhook redelivery,
or a scan retry) → the handler → the store.

**The axis: guarantees — what's promised about how many times this runs?**

```
  Delivery guarantee, traced across the two mechanisms

  Shopify webhook delivery   →  at-least-once (Shopify's own contract)
  handler (uninstalled.tsx)  →  makes duplicate delivery a no-op
  ────────────────────────────────────────────────────────────
  scan retry (operator/UI)    →  at-least-once (nothing prevents a re-run)
  handler (runScan)            →  makes re-run equivalent to first run
```

**The seam: idempotency is enforced at the write, not at the read.** Neither
handler checks "have I seen this before?" with a dedup table or an
idempotency-key lookup. Instead, each write is chosen to be naturally
idempotent — `deleteMany`/`updateMany` match zero-or-more rows without
erroring, and `upsert` collapses create-or-update into one operation. That's
a real design choice worth naming: it's simpler than a dedup-key table, and
it's correct here because every affected row is looked up by a natural key
(`shopDomain`, `scanId`) rather than needing a synthetic delivery ID.

## How it works

### Move 1 — the mental model

You've written a React `useEffect` cleanup function that has to be safe to
call even if the effect itself never ran — checking `if (subscription)`
before unsubscribing instead of assuming it exists. Idempotent handlers are
that same discipline applied to a whole operation: write it so that calling
it 1 time or 5 times in a row produces the identical end state, not just the
identical "did it error" answer.

```
  Pattern: idempotent handler

  handle(event):
    perform write using a NATURAL KEY match (not "insert unconditionally")
    // deleteMany/updateMany/upsert on that key are safe to repeat —
    // zero-match is a legal, silent outcome, not an error
    return success  // regardless of whether this was the 1st or Nth call
```

### Move 2 — two real handlers, walked side by side

**Webhook redelivery — `app/app/routes/webhooks.app.uninstalled.tsx:1-23`.**
The comment on line 11-12 states Shopify's contract plainly: *"Webhook
requests can trigger multiple times and after an app has already been
uninstalled."* The handler:

```ts
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
await markShopUninstalled(shop);
```

`deleteMany` (not `delete`) is the load-bearing choice here — `delete`
throws if the row doesn't exist, `deleteMany` silently matches zero rows on
a redelivery where the session was already removed. `markShopUninstalled`
(`app/app/models/shop.server.ts:63-68`) uses `updateMany` for the identical
reason, and its own docstring says so directly: *"Idempotent: if no Shop
matches the domain, this is a no-op and does not throw."*

**Reinstall / GDPR redact — `app/app/models/shop.server.ts`.** Two more
handlers built the same way:

```ts
// ensureShop (lines 15-39) — upsert collapses "create" and "update"
const shop = await prisma.shop.upsert({
  where: { shopDomain },
  create: { shopDomain, settings: { create: {} } },
  update: { installStatus: "INSTALLED", uninstalledAt: null },
  include: { settings: true },
});

// redactShop (lines 49-51) — deleteMany, not delete
await prisma.shop.deleteMany({ where: { shopDomain } });
```
`redactShop`'s docstring is explicit: *"if no Shop matches the domain
(already redacted, or never existed), this is a no-op and does not throw."*
Three separate GDPR-relevant handlers (uninstall, redact, reinstall), three
separate idempotent primitives (`updateMany`, `deleteMany`, `upsert`) — same
underlying discipline every time: match by natural key, tolerate a
zero-row match.

**Scan retry — `runScan`, `app/app/services/scan/runner.server.ts:44-58,181-207`.**
This is the more interesting case because it isn't just "no-op on repeat" —
it's "produce the identical *correct* result on repeat," which is a
stronger guarantee. The docstring names both halves:

> *"Idempotent: calling this again for a scan that already COMPLETED is a
> no-op. Calling it again for a scan that previously FAILED ... re-runs the
> pipeline from scratch and replaces any findings left over from the prior
> attempt."*

```ts
if (scan.status === "COMPLETED") {
  return;                                     // line 73-75: no-op
}
...
await prisma.$transaction([
  prisma.finding.deleteMany({ where: { scanId } }),          // line 188
  ...(findingRows.length > 0
    ? [prisma.finding.createMany({ data: findingRows })]     // line 189-191
    : []),
  prisma.scan.update({ where: { id: scanId }, data: { status: "COMPLETED", ... } }), // line 192-206
]);
```
The `deleteMany` before the `createMany` is the deduplication mechanism:
whatever findings a prior failed attempt left behind get wiped in the same
transaction that inserts the fresh set, so a scan that fails after writing
3 findings and is retried never ends up with 3 stale findings plus N new
ones. And because all three operations are one `$transaction`, a crash
between the delete and the insert can't leave the scan `COMPLETED` with a
half-written finding set — it's all-or-nothing.

```
  Execution trace — retrying a previously-FAILED scan

  state before retry:  Scan.status=FAILED, Finding rows=[f1,f2,f3] (stale)
  caller resets:        Scan.status=QUEUED
  runScan(scanId) runs again:
    step 1  read catalog, run checks fresh → findings=[g1,g2]
    step 2  $transaction:
              deleteMany({scanId})        → f1,f2,f3 removed
              createMany([g1,g2])         → g1,g2 inserted
              update(status=COMPLETED)    → scan marked done
  state after:          Scan.status=COMPLETED, Finding rows=[g1,g2]
                        (no trace of f1,f2,f3 — retry was clean, not additive)
```

### Move 3 — the principle

At-least-once delivery is the norm for anything crossing a process or
network boundary — webhooks redeliver, retries re-run, and a message broker
that promises exactly-once is usually lying about the hard part. The fix is
never "detect the duplicate and reject it" (that needs a dedup table with
its own consistency problems); it's "make the operation naturally
idempotent" so a duplicate call is indistinguishable from the first one at
the level of end state.

## Primary diagram

```
  Idempotency across the two mechanisms in this repo

  ┌─ Webhook delivery (Shopify → this app) ────────────────────────┐
  │  app/uninstalled fires (maybe twice)                             │
  │    → db.session.deleteMany({shop})   (0 or 1 rows, never errors) │
  │    → markShopUninstalled (updateMany, 0 or 1 rows, never errors) │
  └───────────────────────────────────────────────────────────────────┘

  ┌─ Scan retry (operator/UI resets FAILED → QUEUED) ─────────────────┐
  │  runScan(scanId) runs again                                        │
  │    → COMPLETED already? return (no-op)                             │
  │    → else: $transaction[ deleteMany(findings), createMany(fresh),  │
  │             update(status=COMPLETED) ]  — atomic, replaces stale   │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The stronger form of idempotency here — "re-running replaces stale output
atomically" rather than just "re-running doesn't error" — is the same
pattern you'd reach for with an idempotency key on a payment API: you don't
just want "don't charge twice," you want "the record of what happened is
identical regardless of retry count." A dedicated idempotency-key table (a
row per `(operation, key)` recording the result of the first successful
attempt) becomes necessary once the operation has side effects outside your
own database — e.g. if `runScan` ever needed to call a paid third-party API
per attempt, you'd need to remember "did I already call it" rather than
relying on natural-key writes. This repo never reaches that case because
its one external call (`readCatalog`) is a pure read with no side effects,
so replaying it is always safe — see `02-partial-failure-timeouts-and-retries.md`.

## Interview defense

**Q: "How do you know the uninstall webhook handler is safe against Shopify
redelivering it?"**
A: Every write in it uses a "match zero-or-more, never error" operation —
`deleteMany`/`updateMany` keyed by shop domain — instead of `delete`/`update`,
which throw on a missing row. A redelivered webhook just matches zero rows
the second time and returns the same success response.
```
  webhook fires 2x ──► deleteMany/updateMany (both keyed by shop domain)
                        1st call: 1 row affected
                        2nd call: 0 rows affected — same 200 response
```
One-line anchor: *idempotency by natural-key match, not by a dedup table.*

**Q: "What's the load-bearing part of the scan retry that people forget?"**
A: The `deleteMany` for stale findings has to be in the *same* transaction
as the fresh `createMany` and the `COMPLETED` update. If you deleted stale
findings in a separate step before running the pipeline, a crash between
that delete and the new insert would leave a scan with zero findings and no
clear status — worse than the stale data it replaced.
```
  deleteMany + createMany + update(COMPLETED)  — one $transaction
  drop the atomicity → crash mid-retry can leave 0 findings, ambiguous state
```
One-line anchor: *the delete-then-recreate has to be atomic with the state
transition, or the retry itself becomes a new failure mode.*

## See also

- `08-sagas-outbox-and-cross-boundary-workflows.md` — `runScan`'s full state
  machine, of which this retry behavior is one property.
- `04-consistency-models-and-staleness.md` — why a scan's settings are
  snapshotted at enqueue time rather than re-read on each retry.
- `.aipe/study-data-modeling/` — schema-level detail on the `Finding` table
  this transaction writes to.
