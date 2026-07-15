# 02 — Atomic, idempotent scan pipeline

**State machine + all-or-nothing commit (write-ahead-then-swap).** Industry standard pattern — project-specific implementation (`runner.server.ts`'s `runScan`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Service layer, worker process ──────────────────────────────┐
│  claimAndRunNext() (see 01)                                    │
│       │ hands off a claimed Scan                                │
│       ▼                                                          │
│  runScan()   ★ THIS CONCEPT ★  ← we are here                    │
│    state.ts: QUEUED→READING_CATALOG→RUNNING_CHECKS→             │
│              PREPARING_RESULTS→COMPLETED|FAILED                  │
└──────────────────────────┬────────────────────────────────────┘
                            │ one $transaction: delete+insert+update
┌─ Storage layer ───────────▼────────────────────────────────────┐
│  SQLite: Scan row (status) + Finding rows                       │
└────────────────────────────────────────────────────────────────┘
```

`enqueueScan`/`claimAndRunNext` (see `01`) got a scan claimed. Now something has to actually run it — read the catalog, normalize it, run 10 checks, persist the results — and do it in a way where a crash halfway through never leaves the database in a state that lies about what happened. That's what `runScan` is for.

## Structure pass

**Axis: failure — where does an error get contained?** Every one of the four stages (read, normalize, check, persist) can throw. The pipeline's entire design point is that *no matter which stage throws*, the scan ends up in exactly one of two terminal states — `COMPLETED` with a fresh, consistent set of findings, or `FAILED` with no findings changed and a safe message — never a state in between.

**Seam:** the boundary between "the pipeline computed something" and "the database reflects it" is the single `$transaction` call. Everything before that seam is pure computation (fallible, retryable, side-effect-free on the DB); everything at that seam is one atomic write. That's the load-bearing joint — cross it and you can no longer partially fail.

```
The seam — where "computed" becomes "committed"

axis traced = "what happens to the DB if this step throws?"

┌─ read / normalize / check ─┐  seam: $transaction  ┌─ COMMITTED ─┐
│  throws → DB UNCHANGED       │ ══════════╪════════► │ all rows,    │
│  (nothing written yet)       │  (it flips)           │ or none      │
└───────────────────────────────┘                      └──────────────┘
```

## How it works

You know how a `fetch()` call has loading/success/error states, and you never want the UI to show "success" data that's actually half-written? Same discipline here, just enforced at the database layer instead of component state — a `Scan` is never allowed to say `COMPLETED` unless every finding that belongs to it is already sitting in the table.

### The kernel — isolate it

```
Scan pipeline kernel

  assertTransition-gated stage advances (read-only cost: 4 status writes)
       │
  compute findings (pure, in-memory, engine call)
       │
  ONE transaction:
    delete old findings (if retry) + insert new findings + mark COMPLETED
       │
  catch: mark FAILED, generic message, real error logged server-side only
```

**What breaks if you removed the transaction and just did three separate writes:** a crash between "insert findings" and "mark COMPLETED" leaves a scan stuck in `PREPARING_RESULTS` forever with findings already present — the UI would show "still running" while data actually exists, or a naive retry would insert a *second* copy of the same findings alongside the first. Wrapping all three in `prisma.$transaction([...])` (`runner.server.ts:187-207`) makes that interleaving impossible: either all three land, or none do.

### Stage 1 — the state machine gates every advance

`state.ts` defines the one legal forward path and makes it impossible to skip a stage or resurrect a terminal scan:

```ts
// state.ts:22-28
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```

```ts
// state.ts:40-55
export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) {
    throw new Error(`Illegal scan transition: ${from} is terminal...`);
  }
  if (to === "FAILED") return;             // FAILED reachable from anywhere non-terminal
  if (LEGAL_FORWARD_TRANSITIONS[from] === to) return;
  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
```

`runScan` calls this before every stage advance and tracks the *actual* current status locally, not a hardcoded literal:

```ts
// runner.server.ts:79-83
// Track the scan's actual current status locally as we advance it, so
// each assertTransition guards the *real* current status (protecting
// against a mis-ordered pipeline) rather than a hardcoded literal that
// would trivially always pass.
let currentStatus = scan.status as ScanStatus;
```

**What breaks without this:** nothing stops a future refactor from calling the stages out of order, or re-entering a `COMPLETED` scan's pipeline and re-running checks against stale data. The state machine converts "please don't do that" into a thrown exception at the first illegal call.

### Stage 2 — read, normalize, check (pure computation, retryable)

```ts
// runner.server.ts:102-130
const currencyCode = await fetchShopCurrencyCode(admin);
const raw = await readCatalog(admin, { variantLimit: settings.catalogVariantLimit, /* ... */ });
// assertTransition + status update to RUNNING_CHECKS happens here
const snapshot = normalizeCatalog(raw, { shopId: shop.id, shopDomain: shop.shopDomain, currencyCode, apiVersion: CATALOG_API_VERSION });
const ctx: CatalogCheckContext = { variants: snapshot.variants, settings: { minimumMarginPercent: settings.minimumMarginPercent }, now: /* injectable clock */ };
const findings = runChecks(ALL_CHECKS, ctx);
```

Nothing here touches the `Finding` table. `readCatalog` can retry internally (see `catalog-reader.server.ts`'s throttle backoff); `normalizeCatalog` and `runChecks` are pure engine functions (see `03-engine-app-boundary.md`) with no I/O at all. If any of this throws, the outer `catch` (below) handles it — no findings have been written yet, so there's nothing to unwind.

### Stage 3 — the atomic commit

```ts
// runner.server.ts:182-207
// Delete any findings left over from a previous (failed or retried)
// attempt at this scan, insert the fresh set, and mark the scan
// COMPLETED — all in one transaction, so a crash partway through
// can never leave a scan COMPLETED with stale/duplicate findings, or
// findings persisted without a completed scan to anchor them.
await prisma.$transaction([
  prisma.finding.deleteMany({ where: { scanId } }),
  ...(findingRows.length > 0 ? [prisma.finding.createMany({ data: findingRows })] : []),
  prisma.scan.update({ where: { id: scanId }, data: { status: "COMPLETED", /* counts, partial, etc */ } }),
]);
```

This is also what makes `runScan` **idempotent on retry**: the doc comment states it directly (`runner.server.ts:44-47`) — "calling it again for a scan that previously FAILED (reset back to QUEUED by the caller) re-runs the pipeline from scratch and replaces any findings left over from the prior attempt." The `deleteMany` at the front of the transaction is what makes "replaces" true rather than "duplicates."

### Stage 4 — the failure path never leaks internals

```ts
// runner.server.ts:208-224
} catch (err) {
  console.error(`[scan:${scanId}] scan run failed`, err);   // full detail, server-side only
  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "SCAN_FAILED",
      failureMessageSafe: GENERIC_FAILURE_MESSAGE,          // never the real error text
    },
  });
}
```

**What breaks without the generic message:** a Shopify error string, a Prisma constraint violation, or a stack trace could end up rendered to the merchant in `app.scans.$id.tsx`'s failure banner — an internal-leakage bug, which is exactly the failure mode this line is defending against (spec requirement, per the doc comment at `runner.server.ts:49-57`).

## Primary diagram

```
Full recap — one scan's journey through runScan

QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED
  │              │                    │                    │                 ▲
  │        readCatalog()        normalizeCatalog()    (assertTransition   ONE
  │        (retryable,          + runChecks()          gate only —        $transaction:
  │         see catalog-reader)  (pure, in-memory)       no I/O here)     delete+insert+
  │                                                                        update
  └──────────────────────── any throw, any stage ─────────────────────────► FAILED
                                                                     (generic message,
                                                                      real error logged
                                                                      server-side only)
```

## Elaborate

This is the classic **write-ahead-then-swap** shape you see in database migrations and blue/green deploys: compute the new state fully off to the side (in memory, here — nothing durable yet), then commit it in one atomic move that either fully replaces the old state or doesn't happen at all. The alternative — writing findings incrementally as they're computed — would be faster to start showing partial results, but this app deliberately doesn't do that (the UI shows a coarse 4-stage progress bar, not a running findings feed), which is exactly why "compute everything, then commit everything" is the right shape here rather than a premature optimization.

`not yet exercised`: streaming partial results to the UI mid-scan (the pipeline computes the whole findings set before any of it is visible); automatic retry-with-backoff at the scan level (a `FAILED` scan stays `FAILED` until a human starts a new one).

## Interview defense

**Q: Why not write findings as you compute them, for faster perceived progress?**
A: Because a partially-written result set that a crash then abandons is worse than no result set — a merchant could see a "completed" scan missing half its findings. Batching the whole write into one transaction trades a bit of latency for a hard guarantee: the merchant only ever sees a scan that's either fully done or clearly failed.

**Q: How is this pipeline idempotent?**
A: `deleteMany({ where: { scanId } })` runs inside the same transaction as the insert — so re-running a failed scan from scratch always fully replaces its prior (possibly non-existent) findings rather than appending to them. Diagram: point at the write-ahead-then-swap picture above.

**Q: What's the load-bearing part of the state machine most people would skip?**
A: Terminal-status enforcement — `assertTransition` throws if `from` is already `COMPLETED` or `FAILED` (`state.ts:41-45`), even for the `FAILED` target. Without it, nothing stops a stale retry from re-advancing an already-`COMPLETED` scan and silently overwriting good findings with a second run's results.

## See also

- `01-single-worker-db-queue.md` — how a scan gets claimed before `runScan` ever runs.
- `03-engine-app-boundary.md` — the pure `normalizeCatalog`/`runChecks` calls in stage 2.
- `audit.md` → lens 3 (state ownership), lens 5 (storage/durability), lens 6 (failure handling).
