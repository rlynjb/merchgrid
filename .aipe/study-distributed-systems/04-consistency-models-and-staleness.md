# Consistency Models and Staleness

Snapshot isolation / read-your-writes — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the consistency question sits

  ┌─ Service layer ────────────────────────────────────────────┐
  │  enqueueScan() reads ShopSettings                            │
  │  ...minutes later... runScan() reads ShopSettings AGAIN?     │
  └───────────────────────┬───────────────────────────────────────┘
                          │
  ┌─ Storage layer ───────▼───────────────────────────────────────┐
  │  ★ SNAPSHOT-AT-ENQUEUE ★ — minimumMarginPercentUsed,          │ ← we are here
  │  apiVersion frozen onto the Scan row itself                   │
  └────────────────────────────────────────────────────────────────┘
```

A scan isn't instantaneous — it moves through `QUEUED → READING_CATALOG →
RUNNING_CHECKS → PREPARING_RESULTS → COMPLETED`, and that whole pipeline can
take long enough (thousands of variants, retried Shopify calls) that a
merchant could change their margin threshold in `ShopSettings` *while a scan
against the old threshold is still running*. That's a staleness question in
miniature: which value should the in-flight scan use — the one that was
true when it started, or whatever's true right now? This repo answers it
explicitly, and the answer is the same one distributed systems reach for
constantly: **snapshot the input at the start of the operation, don't
re-read live state partway through.**

## Structure pass — layers, axis, seams

**Layers:** `ShopSettings` (the mutable, merchant-editable source of truth)
→ `Scan` (a row that freezes a copy of the settings that mattered) →
`Finding` (rows that inherit that frozen value transitively).

**The axis: state — who owns the value, and when is it read?**

```
  State axis across the scan's lifetime

  ShopSettings.minimumMarginPercent  →  merchant owns it, mutable ANY time
  Scan.minimumMarginPercentUsed      →  frozen copy, read ONCE at enqueue
  CatalogCheckContext.settings       →  reads the FROZEN copy, not live table
  Finding rows                       →  reflect whichever value was frozen
```

**The seam: the freeze happens at `enqueueScan`, not at `runScan`.** That
ordering is the whole mechanism. If the freeze happened when the worker
picks up the scan instead of when it's created, a setting change made
between "merchant clicks scan" and "worker claims it" (which can be up to
`POLL_MS` — 5 seconds — later) would silently change what gets checked,
and the merchant would have no way to know which threshold their results
reflect.

## How it works

### Move 1 — the mental model

You've built a form that snapshots `defaultValue` at mount instead of
re-reading a prop that keeps changing underneath it — so the user's typed
input doesn't get stomped by an unrelated re-render. This is the same
instinct at the data layer: `runScan` doesn't ask "what's the merchant's
margin threshold *right now*" — it asks "what was frozen onto this specific
scan when it was created," so the scan's *own* history stays internally
consistent regardless of what happens to `ShopSettings` afterward.

```
  Pattern: snapshot-at-creation, not read-at-use

  enqueueScan(shopId):
    settings = READ ShopSettings (current value)
    CREATE Scan { minimumMarginPercentUsed: settings.minimumMarginPercent,
                  apiVersion: CATALOG_API_VERSION }   // frozen, once

  runScan(scanId):
    scan = READ Scan               // has its OWN frozen settings.minimumMarginPercent
    ctx.settings = scan.shop.settings   // NOTE: reads live table — see caveat below
    findings = runChecks(ctx)
```

### Move 2 — the mechanism, and its actual caveat

**The freeze at enqueue time**
(`app/app/services/scan/queue.server.ts:44-77`):

```ts
export async function enqueueScan(shopId: string): Promise<Scan> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { settings: true },
  });
  ...
  return prisma.scan.create({
    data: {
      shopId,
      status: "QUEUED",
      apiVersion: CATALOG_API_VERSION,
      minimumMarginPercentUsed: shop.settings.minimumMarginPercent,
    },
  });
}
```
`minimumMarginPercentUsed` and `apiVersion` are copied onto the `Scan` row
at creation. The docstring (lines 36-39) names exactly why: *"snapshotting
the API version and the shop's current minimum-margin setting onto the scan
row so a later settings change never retroactively changes what an
already-run scan checked against."* This is read-your-writes in the most
literal sense — once the scan exists, its own record of "what threshold did
I use" never drifts, no matter how many times the merchant edits
`ShopSettings` afterward.

**The honest caveat — `runScan` actually reads live settings for the run
itself.** Look closely at `app/app/services/scan/runner.server.ts:90-91,125-129`:

```ts
const { settings } = shop;                          // shop.settings — LIVE table read
...
const ctx: CatalogCheckContext = {
  variants: snapshot.variants,
  settings: { minimumMarginPercent: settings.minimumMarginPercent },  // live value
  now: (deps?.now ?? defaultNowIso)(),
};
```
The checks actually run against whatever `ShopSettings.minimumMarginPercent`
is *at the moment the worker executes*, not the value frozen at enqueue
time — the frozen `minimumMarginPercentUsed` column only gets written back
onto the `Scan` row at completion (`runner.server.ts:203`, using the
same live `settings.minimumMarginPercent`), as a record of what was used,
not as the input to the run. So the two writes (enqueue-time freeze,
completion-time record) happen to agree in the common case only because
nothing re-reads the enqueue-time value in between — if a merchant changes
their margin threshold while a scan sits `QUEUED` for a few seconds, the
scan runs against the *new* value, and `minimumMarginPercentUsed` faithfully
records that new value, not the one that was live when the merchant clicked
"scan." That's a real (small) staleness window, worth naming precisely
rather than glossing: the field's docstring promise ("a later settings
change never retroactively changes what an already-run scan checked
against") holds once a scan starts running, but not during the few seconds
it can sit `QUEUED`.

```
  Execution trace — the staleness window, made concrete

  t0   merchant sets minimumMarginPercent = 20%, clicks "Scan"
  t0   enqueueScan creates Scan{ minimumMarginPercentUsed: 20 }  (QUEUED)
  t1   merchant edits ShopSettings.minimumMarginPercent → 30%    (before worker claims it)
  t2   worker claims scan, runScan reads shop.settings LIVE → 30%
  t2   runChecks(ctx) uses 30%, not the 20% recorded at t0
  t3   scan COMPLETED, minimumMarginPercentUsed OVERWRITTEN to 30
         (runner.server.ts:203 — matches what actually ran, so the record
          is honest about what was used, just not what queue.server.ts froze)
```

**API version, by contrast, has no such gap** — `CATALOG_API_VERSION`
(`app/app/config.ts`) is a build-time constant, not a merchant-editable
value, so there's nothing to drift between enqueue and run; the `apiVersion`
column really is a pure snapshot with no live re-read anywhere.

### Move 3 — the principle

"Snapshot at creation" only delivers the consistency guarantee you think it
does if *every* downstream read actually consumes the snapshot instead of
re-reading the live source. A partial snapshot — frozen at write time,
re-read live at execution time — isn't wrong, but it's a narrower guarantee
than the docstring states, and the gap only shows up under a race a test
suite is unlikely to hit (a settings edit landing inside a multi-second
queue wait). Naming the gap precisely is more valuable than either
over-trusting the docstring or dismissing the whole mechanism as broken —
it isn't; it just guarantees less than it appears to.

## Primary diagram

```
  Consistency across the scan lifecycle

  ShopSettings (mutable, merchant-owned)
       │
       │ read @ t0 (enqueueScan)             read @ t2 (runScan, LIVE)
       ▼                                            ▼
  Scan.minimumMarginPercentUsed=20   ⋯⋯⋯⋯⋯⋯>  runChecks uses whatever's
  (frozen @ t0, but NOT the input          live at t2 — may differ from
   to the actual check run)                 the t0 snapshot if edited
                                             between t0 and t2
       │
       │ overwritten @ completion to match what ACTUALLY ran
       ▼
  Scan.minimumMarginPercentUsed=<value used at t2>   (final, accurate record)
```

## Elaborate

This is the same tension every "snapshot vs. read-through" design faces:
Postgres's `REPEATABLE READ` isolation snapshots the whole transaction's
view of the data at its start, versus `READ COMMITTED`, which lets each
statement see the latest commit. This repo is effectively `READ COMMITTED`
for the settings input (each phase reads the live row) while presenting the
`apiVersion`/`minimumMarginPercentUsed` columns as though they were
snapshot-isolated. Closing the gap for real would mean `enqueueScan` writing
the frozen value and `runScan` reading *that* column instead of
`shop.settings.minimumMarginPercent` directly — a small, deliberate change
if the merchant-facing guarantee ever needs to be airtight. `01-distributed-system-map.md`
covers why there's no risk of the *opposite* problem (a stale read from a
lagging replica) — there's only ever one copy of this data.

## Interview defense

**Q: "If a merchant changes their margin threshold while a scan is
running, which value gets used?"**
A: Whatever's live in `ShopSettings` at the moment `runScan` executes the
checks, not whatever was frozen onto the `Scan` row at enqueue time — the
frozen column is written to *record* what was used, not to *supply* the
input. The two only disagree if the setting changes during the (short)
window a scan sits `QUEUED`.
```
  enqueue: freeze 20%  ──(settings edited)──►  run: reads LIVE 30%, uses it
```
One-line anchor: *the "snapshot" column is a record of what ran, not a
guarantee of what will run.*

**Q: "Is there any stale-read risk from replication lag here?"**
A: No — one SQLite file, one writer, no replicas. The staleness that exists
is entirely about *timing within a single source of truth* (settings
changing between enqueue and execution), not about reading a copy that
hasn't caught up. That distinction matters: the fix for a timing gap is
"read the frozen column instead of the live one"; the fix for replica lag
would be a completely different mechanism (read-your-writes routing, quorum
reads).
One-line anchor: *staleness here is a race in time, not a lag between
copies.*

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — how retries
  interact with this same settings snapshot (a retried scan re-reads live
  settings again, same caveat applies).
- `05-replication-partitioning-and-quorums.md` — what genuine replica
  staleness would look like, and why this repo doesn't have it yet.
- `.aipe/study-database-systems/` — SQLite's own isolation guarantees,
  which this file assumes but doesn't re-derive.
