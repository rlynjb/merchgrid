# Transactions and integrity

### ACID transactions / referential + invariant integrity — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where correctness either gets guaranteed or hoped for

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  "Run scan" button, results page polling                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Service layer ───────────▼─────────────────────────────────┐
  │  ★ THIS CONCEPT ★                                           │
  │  runner.server.ts ($transaction), queue.server.ts (no tx),  │
  │  state.ts (app-level guard, not a DB CHECK)                 │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Storage layer ───────────▼─────────────────────────────────┐
  │  SQLite: FK CASCADE enforced by the engine; everything else │
  │  (status enum, margin range, one-active-scan) is TEXT/INT   │
  │  columns with no CHECK — the app is the only guard          │
  └──────────────────────────────────────────────────────────┘
```

Every invariant in a system is enforced *somewhere* — the question this file answers is whether that somewhere is the database (which can't be bypassed) or application code (which can be, by a bug, a race, or a second entry point nobody thought of). This repo has one exemplary case of DB-transactional correctness and one honestly-documented case where the invariant lives entirely in application code with a known race.

## Structure pass

**Axis: for each invariant in this system, what enforces it — a DB constraint, or a service function that has to be called correctly every time?**

```
  invariant                              enforced by
  ─────────────────────────────────────────────────────────────
  cascade delete on shop removal      →  DB (FK ON DELETE CASCADE)
  a finding always belongs to a       →  DB (FK, NOT NULL)
    real scan
  delete-old + insert-new + mark-     →  DB (Prisma $transaction,
    complete happens atomically           real SQL BEGIN/COMMIT)
  Scan.status is one of six values,   →  APP (state.ts assertTransition)
    moves forward only
  minimumMarginPercent is an          →  APP (settings.server.ts
    integer 0-90                          assertValidMargin)
  a shop has at most one active scan  →  APP (queue.server.ts,
    at a time                             documented race)
```

The seam is sharp: **referential integrity (FKs, cascades) and the persist-step's atomicity are DB-guaranteed; every business-rule invariant (status shape, margin range, one-active-scan) is application-only.** That's not automatically wrong — SQLite's `CHECK` constraints could enforce the first two, but Prisma's schema here doesn't use them, and a bare `TEXT`/`INTEGER` column with app-level validation is a common, defensible trade when there's exactly one write path into the table. The one place that trade gets risky is where the write path isn't as single as it looks — which is exactly the "one active scan" case below.

## How it works

### The kernel: the delete-insert-complete transaction

**Isolate the kernel.** This is the one genuinely load-bearing multi-statement write in the whole app, and it's a clean three-step atomic unit:

```
  delete old findings → insert new findings → mark scan COMPLETED
  (all three, or none — no state where only one or two happened)
```

**Name each part by what breaks when it's missing.**

```ts
// app/app/services/scan/runner.server.ts:182-207
// Delete any findings left over from a previous (failed or retried)
// attempt at this scan, insert the fresh set, and mark the scan
// COMPLETED — all in one transaction, so a crash partway through
// can never leave a scan COMPLETED with stale/duplicate findings, or
// findings persisted without a completed scan to anchor them.
await prisma.$transaction([
  prisma.finding.deleteMany({ where: { scanId } }),
  ...(findingRows.length > 0
    ? [prisma.finding.createMany({ data: findingRows })]
    : []),
  prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      criticalCount, warningCount, unavailableCount,
      productsProcessed: snapshot.productsProcessed,
      variantsProcessed: snapshot.variantsProcessed,
      partial: snapshot.partial,
      minimumMarginPercentUsed: settings.minimumMarginPercent,
      apiVersion: CATALOG_API_VERSION,
    },
  }),
]);
```

- **Drop the `deleteMany` and re-run a previously-FAILED scan:** the new findings from the retry get appended to the old, already-wrong findings from the failed attempt. A merchant re-running a scan after a transient network error would see duplicate, stale findings mixed in with correct ones.
- **Drop the array-based atomicity (run these as three separate `await` calls instead of one `$transaction([...])`):** a crash between step 1 and step 2 leaves a scan with zero findings but no `FAILED` status — silently indistinguishable from "a scan that legitimately found nothing wrong." A crash between step 2 and step 3 leaves fresh, correct findings attached to a scan still stuck at `PREPARING_RESULTS` forever.
- **Drop the conditional spread (`...(findingRows.length > 0 ? [...] : [])`):** `createMany` with an empty `data` array is what this guards against — calling it with zero rows either no-ops or errors depending on the driver, and this repo doesn't leave that to chance.

**Separate skeleton from optional hardening.** The three-statement array *is* the kernel — nothing here is retry logic or observability layered on top; it's the minimum shape that makes "always leaves the scan in a definitively COMPLETED-with-correct-findings or FAILED-with-no-partial-writes state" true. The `try`/`catch` wrapping the whole pipeline (below) is the hardening layer on top of that kernel.

### The failure path — never leaves a scan silently stuck

```ts
// app/app/services/scan/runner.server.ts:208-224
} catch (err) {
  console.error(`[scan:${scanId}] scan run failed`, err);

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "SCAN_FAILED",
      failureMessageSafe: GENERIC_FAILURE_MESSAGE,   // ← never the real error text
    },
  });
}
```

Every failure mode in the whole read → normalize → check → persist pipeline — a Shopify API error, a check throwing, a DB write failing — funnels through one `catch` that marks the scan `FAILED` with a generic, non-leaking message. The real error is logged server-side only, never written to the row or returned to the caller. That's a security/integrity move as much as an error-handling one: `failureMessageSafe` is a column name that encodes its own contract — anything landing in it has already been scrubbed of internals (query text, stack traces, upstream error bodies).

### Referential integrity — enforced by the database, not application code

```sql
-- app/prisma/migrations/20260715004357_domain_models/migration.sql
CONSTRAINT "ShopSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
CONSTRAINT "Scan_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
CONSTRAINT "Finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
CONSTRAINT "ScanArtifact_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
```

Four real foreign keys, all with `ON DELETE CASCADE`. This is the one place integrity is genuinely DB-enforced end to end — `redactShop`'s single `prisma.shop.deleteMany({ where: { shopDomain } })` (`app/app/models/shop.server.ts:49-51`) correctly deletes every `ShopSettings`/`Scan`/`Finding`/`ScanArtifact` row for that shop *because the database does it*, not because application code walks the tree. If someone deleted a `Shop` row through a raw SQL console instead of Prisma, the cascade would still fire — that's the difference between DB-enforced and app-enforced integrity: it survives a bypass of the normal write path.

### `Scan.status` — a six-value enum with no `CHECK` constraint

```ts
// app/app/services/scan/state.ts:9-15,40-56
export type ScanStatus =
  | "QUEUED" | "READING_CATALOG" | "RUNNING_CHECKS"
  | "PREPARING_RESULTS" | "COMPLETED" | "FAILED";

export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) {
    throw new Error(`Illegal scan transition: ${from} is terminal and cannot transition to ${to}.`);
  }
  if (to === "FAILED") { return; }
  if (LEGAL_FORWARD_TRANSITIONS[from] === to) { return; }
  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
```

`Scan.status` is a bare `TEXT NOT NULL DEFAULT 'QUEUED'` in the migration SQL — SQLite supports `CHECK (status IN (...))` and this schema doesn't use it. `assertTransition` is called before every `prisma.scan.update` that changes status in `runner.server.ts` (five call sites: `READING_CATALOG`, `RUNNING_CHECKS`, `PREPARING_RESULTS`, `COMPLETED`, and implicitly `FAILED` in the catch block), and it guards the *actual current* status read fresh from the row each time — not a hardcoded literal — so a mis-ordered pipeline change would trip it. That's a reasonable place to draw the line: `Scan` has exactly one writer of `status` (`runScan` plus the worker's poison-pill path in `worker-core.server.ts:64-73`), so an app-level guard covers every real write path today. It would stop being reasonable the moment a second code path started writing `Scan.status` directly.

### The one honestly-documented gap: "one active scan per shop"

```ts
// app/app/services/scan/queue.server.ts:44-78
export async function enqueueScan(shopId: string): Promise<Scan> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, include: { settings: true } });
  if (!shop || !shop.settings) { throw new Error(...); }

  // NOTE (TOCTOU): the "is a scan already active" check and the create below
  // are not atomic — under true concurrent requests for the same shop, two
  // callers could both pass the check and both create a scan. This is
  // acceptable for MVP: the API layer serializes requests per merchant
  // session in practice, and there is a single worker process consuming the
  // queue, so a duplicate QUEUED row is a low-probability, low-impact edge
  // case rather than a correctness hazard. Future hardening: a partial
  // unique index (e.g. one row per shopId where status is non-terminal)
  // enforced at the DB level would close this race properly.
  const active = await getActiveScan(shopId);
  if (active) {
    throw new ActiveScanError(`Shop ${shopId} already has an active scan (${active.id}, status ${active.status})`);
  }

  return prisma.scan.create({ data: { shopId, status: "QUEUED", ... } });
}
```

```
  The race, made visible

  Request A: getActiveScan(shop) → null  ─┐
                                            ├─ both pass the check
  Request B: getActiveScan(shop) → null  ─┘
  Request A: prisma.scan.create(...)  → Scan#1 QUEUED
  Request B: prisma.scan.create(...)  → Scan#2 QUEUED   ← invariant violated
```

Check-then-act across two separate round trips, with no transaction wrapping them and no unique constraint that would make the second `create` fail. The code's own comment names the exact fix — a partial unique index (`CREATE UNIQUE INDEX ... WHERE status NOT IN (terminal states)`, which SQLite supports as a partial index) — and explains why it's deferred: a single worker process draining the queue means a stray duplicate `QUEUED` row is a low-probability, low-cost bug (the second scan just runs a bit later, findings get overwritten by whichever completes last), not a data-corruption hazard. That's the right call today and an honest acknowledgment of exactly what would need to change (a real HTTP client retry storm, or a second worker) for it to stop being the right call.

## Primary diagram

```
  Where correctness lives — the full recap

  ┌─ DB-enforced (survives any bypass) ─────────────────────────┐
  │  FK CASCADE: Shop→ShopSettings/Scan, Scan→Finding/ScanArtifact│
  │  $transaction: delete+insert+complete (runner.server.ts)     │
  └────────────────────────────────────────────────────────────┘

  ┌─ App-enforced, single writer, currently safe ────────────────┐
  │  Scan.status forward-only (state.ts, one writer: runScan)     │
  │  minimumMarginPercent range (settings.server.ts)               │
  └────────────────────────────────────────────────────────────┘

  ┌─ App-enforced, documented race, deferred fix ─────────────────┐
  │  "one active scan per shop" — check-then-create, no tx,       │
  │  no partial unique index. Fix: CREATE UNIQUE INDEX             │
  │  ... WHERE status NOT IN ('COMPLETED','FAILED')                │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The general principle: an invariant enforced only in application code is exactly as strong as "there is exactly one code path that can violate it, and that path always runs the guard." That's a fine, common trade — you don't need a `CHECK` constraint for every business rule — but it's a trade that expires the moment a second writer, a retry, or a race condition enters the picture, and the discipline worth copying from this codebase is *naming the expiry condition in the comment*, not just leaving the gap silent. "Acceptable for MVP because X; here's the DB-level fix when X stops being true" is a far more useful comment than either silence or a defensive rewrite nobody asked for yet.

## Interview defense

**Q: Walk me through why the finding-persist step needs to be a transaction.**
A: Three writes have to happen together or not at all: delete stale findings from a prior attempt, insert the fresh set, mark the scan COMPLETED. Splitting these into separate awaited calls creates two failure windows — a crash after delete-but-before-insert leaves a scan with zero findings indistinguishable from "genuinely clean," and a crash after insert-but-before-complete leaves correct findings attached to a scan stuck mid-pipeline forever. `prisma.$transaction([...])` makes all three atomic — commit all three or roll back all three.

```
  delete ──► insert ──► mark COMPLETE
    └──────────┬───────────┘
          one transaction:
          all-or-nothing
```

**Q: The "one active scan per shop" check has a known race — why wasn't it fixed with a DB constraint?**
A: It could be — a partial unique index on `Scan(shopId) WHERE status NOT IN (terminal)` would close it at the DB level, and the code comment names that exact fix. It's deferred because the actual risk today is low: a single worker process drains the queue serially, so a duplicate `QUEUED` row from a race is a rare, low-impact edge case (a scan runs slightly later, not data corruption) rather than a correctness hazard. The honest signal here is a team that named the tradeoff rather than either ignoring it or over-engineering a fix nobody's requests currently need.

**Q: `Scan.status` has no DB-level `CHECK` constraint — is that a problem?**
A: Not today — there's exactly one write path (`runScan`, plus the worker's poison-pill FAILED path) and `assertTransition` guards every status change on the real current status, not a hardcoded assumption. It becomes a real gap the moment a second code path writes `Scan.status` directly without going through that guard.

## See also

- `01-the-data-model-and-its-shape.md` — the cascade tree that makes `redactShop` a one-line DB-enforced delete.
- `03-indexing-vs-query-patterns.md` — the same single-worker assumption that makes the "one active scan" race low-risk also makes the worker's unindexed `status='QUEUED'` query low-risk.
- `05-migrations-and-evolution.md` — the partial-unique-index fix named in the TOCTOU comment would itself be a migration; it hasn't shipped yet.
