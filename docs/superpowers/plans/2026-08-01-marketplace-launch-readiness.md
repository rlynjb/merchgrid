# Marketplace Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Several tasks in this plan are non-code (legal/listing content, manual QA, Shopify Partner Dashboard actions) — for those, "implement" means producing the real deliverable content or completing the checklist, not writing tests.

**Goal:** Take MerchGrid: Catalog Audit from "code complete, deployed, never touched by a real merchant" to "submitted to the Shopify App Store, publicly installable." No merchants are recruited yet — per explicit direction, launch readiness is the goal; merchant validation happens in parallel/after, not as a gate before submission.

**Architecture:** No architectural changes. This plan adds a thin structured-logging layer over the existing scan pipeline, three new unauthenticated public routes (privacy/terms/support) alongside the existing `/healthz` pattern, and produces the non-code artifacts (README, listing copy, legal text, reviewer notes) Shopify's review process requires. Everything else — the Remix app, the worker, the check engine, the Fly deploy — stays exactly as built.

**Tech Stack:** Same as the existing app — Node 22, Remix, Prisma/SQLite, Fly.io, Vitest.

## Global Constraints

- **Stay read-only.** No new write scopes, no product/inventory mutation, anywhere in this plan.
- **No billing code in this pass.** Launch free (matches the frozen MVP promise: prove the wedge before adding pricing tiers). Do not integrate the Shopify Billing API in this plan.
- **Don't touch the deploy topology.** Single Fly machine, SQLite on `/data`, web+worker together, exactly as documented in `app/DEPLOY.md`. If Task 1 (Fly billing) surfaces a real need to change this, treat that as a new decision, not something to fold in here silently.
- **Deterministic checks only.** No AI/LLM claims in any listing copy, README, or UI text (per the product spec's own explicit rule).
- **Every new route added in this plan must be reachable without Shopify authentication** (privacy/terms/support pages get linked from the App Store listing and opened outside the embedded admin context).

---

## Phase 0 — Unblock: Fly billing

### Task 0: Resume production hosting

The Fly.io free trial has ended — `fly status` currently returns `trial has ended, please add a credit card`, and the production URL (`merchgrid-catalog-audit.fly.dev`) is unreachable (`/healthz` connection-resets). This blocks two things later in this plan: the reviewer needs a live `application_url`, and you can't smoke-test the *production* build until this is fixed. It does **not** block local self-testing (Phase 1 covers that first).

- [ ] **Step 1:** Go to `https://fly.io/trial` (or Fly dashboard → Billing) and add a payment method. Expect ~$2–3/month for the current single 256MB machine + 1GB volume — treat this as a normal SaaS operating cost, not a decision to re-litigate.
- [ ] **Step 2:** Verify the machine resumes:
  ```
  fly status -a merchgrid-catalog-audit
  ```
  If it shows a machine in `started`/`stopped` state, good — Fly kept the machine and volume, it was just suspended. If `fly machine list` returns empty, the trial resources were reclaimed and you'll need to redeploy from scratch:
  ```
  cd app && fly deploy
  ```
  (Your volume `vol_vlyo75qy3ejm51m4` may or may not still exist — `fly volumes list -a merchgrid-catalog-audit` will tell you. If it's gone, re-run `fly volumes create data --size 1 --region iad` before deploying, per `app/DEPLOY.md` step 3 — this loses the current scan history, which is fine since it's all fixture data anyway.)
- [ ] **Step 3:** Confirm it's healthy:
  ```
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://merchgrid-catalog-audit.fly.dev/healthz
  ```
  Expect `HTTP 200`.

**Done when:** `/healthz` returns 200 and `fly status` shows the machine `started`.

---

## Phase 1 — Launch foundation (no merchants needed)

### Task 1: Structured scan-event logging

**Files:**
- Create: `app/app/services/observability/log-event.server.ts`
- Test: `app/test/log-event.test.ts`
- Modify: `app/app/services/scan/runner.server.ts`
- Modify: `app/app/services/scan/worker-core.server.ts`
- Modify: `app/worker.ts`

**Interfaces:**
- Produces: `logEvent(event: string, data?: Record<string, unknown>): void` — writes one JSON line to stdout: `{event, ts, ...data}`. Everything downstream (Fly logs, `fly logs | grep`, a future log shipper) consumes this shape.

This is the minimum viable version of Gate B from the launch-readiness review: not a metrics platform, not a founder dashboard — just enough that "my scan has been loading for ten minutes" is answerable by grepping `fly logs` for a `scanId`, without reproducing locally. Retry-attempt-count from `catalog-reader.server.ts` is intentionally left out of scope here — surfacing it would mean changing `readCatalog`'s return shape, which is more than this task needs; revisit only if retries turn out to be a real support issue.

- [ ] **Step 1: Write the failing test**

```ts
// app/test/log-event.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { logEvent } from "../app/services/observability/log-event.server";

describe("logEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one JSON line with the event name, an ISO timestamp, and extra fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("scan_started", { scanId: "abc123", shopId: "shop_1" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("scan_started");
    expect(parsed.scanId).toBe("abc123");
    expect(parsed.shopId).toBe("shop_1");
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("logs valid JSON with just the event name when data is omitted", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("worker_started");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.event).toBe("worker_started");
    expect(parsed.ts).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd app && npx vitest run test/log-event.test.ts
```
Expected: FAIL — `Cannot find module '../app/services/observability/log-event.server'`.

- [ ] **Step 3: Implement it**

```ts
// app/app/services/observability/log-event.server.ts
/**
 * Writes one structured JSON line to stdout for every scan-lifecycle /
 * worker-lifecycle event, so production issues ("my scan has been loading
 * for ten minutes") are answerable by grepping `fly logs` for a scanId or
 * shopId, without reproducing locally.
 */
export function logEvent(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}
```

- [ ] **Step 4: Run it to confirm it passes**

```bash
cd app && npx vitest run test/log-event.test.ts
```
Expected: PASS, 2/2.

- [ ] **Step 5: Wire it into the scan runner**

In `app/app/services/scan/runner.server.ts`:
1. Add the import: `import { logEvent } from "../observability/log-event.server";`
2. Capture `startedAt` in a local variable instead of inlining `new Date()`, so duration is computable later:
   ```ts
   // replace:
   //   data: { status: "READING_CATALOG", startedAt: new Date() },
   // with:
   const startedAt = new Date();
   await prisma.scan.update({
     where: { id: scanId },
     data: { status: "READING_CATALOG", startedAt },
   });
   currentStatus = "READING_CATALOG";
   logEvent("scan_started", { scanId, shopId: shop.id, shopDomain: shop.shopDomain });
   ```
3. Right before the final `$transaction`, capture `completedAt` and log after it succeeds:
   ```ts
   const completedAt = new Date();
   await prisma.$transaction([
     prisma.finding.deleteMany({ where: { scanId } }),
     ...(findingRows.length > 0 ? [prisma.finding.createMany({ data: findingRows })] : []),
     prisma.scan.update({
       where: { id: scanId },
       data: {
         status: "COMPLETED",
         completedAt,
         criticalCount,
         warningCount,
         unavailableCount,
         productsProcessed: snapshot.productsProcessed,
         variantsProcessed: snapshot.variantsProcessed,
         partial: snapshot.partial,
         minimumMarginPercentUsed: settings.minimumMarginPercent,
         apiVersion: CATALOG_API_VERSION,
       },
     }),
   ]);
   logEvent("scan_completed", {
     scanId,
     shopId: shop.id,
     durationMs: completedAt.getTime() - startedAt.getTime(),
     productsProcessed: snapshot.productsProcessed,
     variantsProcessed: snapshot.variantsProcessed,
     criticalCount,
     warningCount,
     unavailableCount,
     partial: snapshot.partial,
   });
   ```
4. In the `catch` block, log alongside the existing `console.error` (keep that line — it's the one place the *real* error detail is allowed to appear, server-side only):
   ```ts
   } catch (err) {
     console.error(`[scan:${scanId}] scan run failed`, err);
     logEvent("scan_failed", {
       scanId,
       shopId: shop.id,
       durationMs: startedAt ? Date.now() - startedAt.getTime() : null,
     });
     await prisma.scan.update({ /* unchanged */ });
   }
   ```
   Note `startedAt` is declared with `let startedAt: Date | undefined;` above the `try` block (not inside it) so this reference compiles even when the failure happens before the scan reaches `READING_CATALOG` (e.g. the missing-`ShopSettings` precondition).

- [ ] **Step 6: Wire it into the worker's queue claim**

In `app/app/services/scan/worker-core.server.ts`, add the import and log the queue-wait time right after finding a scan, before calling the admin factory:
```ts
import { logEvent } from "../observability/log-event.server";
// ...
if (!scan) {
  return null;
}

logEvent("scan_claimed", {
  scanId: scan.id,
  shopId: scan.shopId,
  queueWaitMs: Date.now() - scan.createdAt.getTime(),
});
```
Also replace the existing `console.error` in the poison-pill catch block with a paired `logEvent("scan_admin_unavailable", { scanId: scan.id, shopDomain: scan.shop.shopDomain })` call — keep the `console.error` too (same reasoning: real error detail stays server-side-only).

- [ ] **Step 7: Structure `worker.ts`'s lifecycle logs**

In `app/worker.ts`, replace the three existing plain `console.log`/`console.error` calls with `logEvent` equivalents: `logEvent("worker_started")`, `logEvent("worker_stopped")`, `logEvent("worker_shutdown_requested", { signal })`. Leave the fatal-error handler's `console.error` as-is (it's about to crash the process; keep it maximally simple). This file has no test suite by design (it needs real Shopify OAuth env to even import `shopify.server`) — verify by reading the diff and confirming `npm run build` still succeeds.

- [ ] **Step 8: Run the full suite and confirm nothing broke**

```bash
cd app && npm test
```
Expected: all tests green, including the 2 new ones (net +2 from wherever the suite currently stands).

```bash
cd app && npm run build
```
Expected: succeeds (this also rebuilds `build/worker.js` via esbuild, exercising the `worker.ts` edit).

- [ ] **Step 9: Commit**

```bash
git add app/app/services/observability app/test/log-event.test.ts \
  app/app/services/scan/runner.server.ts app/app/services/scan/worker-core.server.ts app/worker.ts
git commit -m "feat(observability): structured JSON logging for scan and worker lifecycle events"
```

---

### Task 2: Rewrite `app/README.md`

**Files:** Modify `app/README.md` (currently the unedited Shopify Remix template — replace its content entirely with the below).

- [ ] **Step 1: Replace the file content**

```markdown
# MerchGrid: Catalog Audit

A read-only, embedded Shopify admin app that scans a merchant's product
catalog and shows the pricing, inventory, and merchandising problems that
may be costing them sales — without ever changing store data.

## What it checks

Ten deterministic rules (no AI/LLM involved): below-cost pricing, margin
below a merchant-set threshold, zero/negative pricing, invalid or
no-op compare-at (sale) prices, duplicate or missing SKUs, duplicate
barcodes, and price outliers within a product. See
`merchgrid-catalog-audit-product-spec.md` (repo root) for the full spec,
or `.aipe/study-software-design/04-check-registry-pattern.md` for how the
check engine is built.

## Local development

```bash
npm install

# terminal 1 — the embedded web app (opens a Shopify CLI tunnel)
npm run dev

# terminal 2 — the background scan worker (required; scans stay QUEUED
# forever without it)
npm run worker
```

Seed a connected dev store with fixture products that exercise every
check (needs its own write-scoped Admin API token — never the app's own
read-only credentials):

```bash
FIXTURE_SHOP=your-dev-store.myshopify.com \
FIXTURE_ADMIN_TOKEN=shpat_xxx \
npm run seed:fixtures

# tear them down later:
npm run seed:fixtures:clean
```

## Testing

```bash
npm test        # app test suite (Prisma-backed, isolated test.sqlite)
npm run eval     # golden-set regression eval — known fixtures -> known findings
cd packages && npx vitest run   # the pure check-engine package tests
```

## Deployment

Production runbook: [`DEPLOY.md`](./DEPLOY.md). Single Fly.io machine
running the web app and worker together, SQLite on a persistent volume.

## Architecture docs

Sixteen-plus generated study guides live under `.aipe/study-*/` — start at
`.aipe/study-system-design/00-overview.md` for the whole-system picture.
```

- [ ] **Step 2: Commit**

```bash
git add app/README.md
git commit -m "docs: replace scaffolded README with real MerchGrid documentation"
```

---

### Task 3: Privacy policy, terms, support page, and data inventory

**Files:**
- Create: `app/app/routes/privacy.tsx`
- Create: `app/app/routes/terms.tsx`
- Create: `app/app/routes/support.tsx`

These mirror `app/app/routes/healthz.tsx`'s pattern: plain resource/UI routes with **no `authenticate.admin` call** — they must be openable by anyone (a merchant researching the app, or Shopify's reviewer) outside the embedded admin iframe. Keep them dependency-free (no Polaris import needed — plain HTML is fine and renders correctly whether embedded or not).

- [ ] **Step 1: Create `app/app/routes/privacy.tsx`**

```tsx
export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>MerchGrid: Catalog Audit — Privacy Policy</h1>
      <p><em>Last updated: [DATE YOU PUBLISH THIS]</em></p>

      <h2>What MerchGrid does</h2>
      <p>
        MerchGrid: Catalog Audit is a read-only Shopify app. It reads your
        product catalog to identify pricing, inventory, and merchandising
        issues, and displays that report to you inside Shopify admin. It
        never modifies your store's products, inventory, or any other data.
      </p>

      <h2>Data we collect and why</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Data</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Why we store it</th>
            <th style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>Retention</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>Shopify access token</td><td>Authenticate API requests to read your catalog. Encrypted at rest.</td><td>Until uninstall</td></tr>
          <tr><td>Shop domain and install status</td><td>Identify your store and its scan configuration</td><td>Until uninstall + GDPR deletion window</td></tr>
          <tr><td>Scan settings (margin threshold, variant limit)</td><td>Apply your chosen thresholds to each scan</td><td>Until uninstall</td></tr>
          <tr><td>Scan results and findings</td><td>Show and export your catalog audit report</td><td>Until uninstall + GDPR deletion window</td></tr>
        </tbody>
      </table>

      <h2>What we do <em>not</em> collect</h2>
      <p>
        We do not request access to, and do not store, your customers,
        orders, checkout data, or any personally identifiable information
        about your shoppers. Our app requests only read-only product and
        inventory access.
      </p>

      <h2>Data deletion</h2>
      <p>
        When you uninstall MerchGrid, your access token is deactivated
        immediately. In compliance with Shopify's mandatory data-protection
        requirements, we permanently delete your shop's stored data
        (settings, scans, findings) when Shopify sends the shop-redact
        request, typically within 48 hours of uninstall. You may also
        request deletion sooner by contacting us (see Support below).
      </p>

      <h2>Security</h2>
      <p>
        Your Shopify access token is encrypted at rest (AES-256-GCM). All
        traffic to and from the app is encrypted in transit (TLS). We
        request only the minimum Shopify API scopes required to read your
        product catalog — no write access of any kind.
      </p>

      <h2>Third parties</h2>
      <p>We do not sell or share your data with third parties.</p>

      <h2>Contact</h2>
      <p>Questions about this policy: [YOUR SUPPORT EMAIL]</p>
    </main>
  );
}
```

- [ ] **Step 2: Create `app/app/routes/terms.tsx`**

```tsx
export default function Terms() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>MerchGrid: Catalog Audit — Terms of Service</h1>
      <p><em>Last updated: [DATE YOU PUBLISH THIS]</em></p>

      <h2>The service</h2>
      <p>
        MerchGrid: Catalog Audit is provided on an as-is, as-available
        basis. Findings are review recommendations based on deterministic
        rules applied to your catalog data — they are not guarantees, and
        are not financial, tax, legal, or business advice. You are
        responsible for reviewing and deciding whether to act on any
        finding.
      </p>

      <h2>No warranty</h2>
      <p>
        The app is provided without warranties of any kind, express or
        implied, including fitness for a particular purpose. We do not
        guarantee the service will be uninterrupted or error-free.
      </p>

      <h2>Read-only, no liability for store changes</h2>
      <p>
        MerchGrid never modifies your Shopify store. Any changes you make
        to your catalog based on a finding are made by you, in your own
        Shopify admin, at your own discretion.
      </p>

      <h2>Changes to the service</h2>
      <p>
        We may modify, suspend, or discontinue the service at any time. We
        will make reasonable efforts to notify installed merchants of
        material changes.
      </p>

      <h2>Governing law</h2>
      <p>[YOUR JURISDICTION]</p>

      <h2>Contact</h2>
      <p>[YOUR SUPPORT EMAIL]</p>
    </main>
  );
}
```

- [ ] **Step 3: Create `app/app/routes/support.tsx`**

```tsx
export default function Support() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem", fontFamily: "sans-serif", lineHeight: 1.6 }}>
      <h1>MerchGrid: Catalog Audit — Support</h1>

      <p>
        Email <strong>[YOUR SUPPORT EMAIL]</strong> and we'll get back to
        you, typically within [YOUR RESPONSE TIME, e.g. 2 business days].
      </p>

      <h2>Common questions</h2>

      <h3>My scan is stuck or taking a long time</h3>
      <p>
        Scans run in the background and can take a few minutes for larger
        catalogs. If it's been stuck for over 15 minutes, uninstall and
        reinstall the app, or contact support with your shop domain and
        approximately when you started the scan.
      </p>

      <h3>A finding looks wrong or doesn't apply to me</h3>
      <p>
        Warnings in particular may reflect an intentional setup (e.g.
        deliberately reused SKUs for bundles). Findings are review
        recommendations, not guaranteed errors — see the explanation text
        on each finding for why it was flagged.
      </p>

      <h3>I don't see a finding I expected</h3>
      <p>
        Some checks require unit cost data on a variant to run (margin and
        below-cost checks). If cost data is missing, that variant shows up
        under "Could not evaluate" instead.
      </p>

      <h3>My CSV export looks wrong</h3>
      <p>
        Contact support with the scan date and which column looks
        incorrect.
      </p>

      <h3>I have a privacy or data-deletion request</h3>
      <p>
        See our <a href="/privacy">Privacy Policy</a>, or email
        [YOUR SUPPORT EMAIL] directly to request deletion sooner than the
        automatic post-uninstall window.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Fill in the placeholders**

The `[BRACKETED]` values above are the only genuine placeholders in this task — they need information only you have (your support email, response-time commitment, jurisdiction, publish date). Replace them in all three files before deploying.

- [ ] **Step 5: Verify locally**

```bash
cd app && npm run dev
```
Visit `/privacy`, `/terms`, `/support` directly in a browser (not embedded — these are plain routes, no Shopify session needed). Confirm all three render without error.

- [ ] **Step 6: Confirm the build still passes**

```bash
cd app && npm test && npm run build
```

- [ ] **Step 7: Commit**

```bash
git add app/app/routes/privacy.tsx app/app/routes/terms.tsx app/app/routes/support.tsx
git commit -m "feat(legal): add public privacy policy, terms, and support pages"
```

---

### Task 4: App Store listing copy

**Files:** Create `docs/launch/app-store-listing.md` (a plain reference doc — this is what you paste into the Partner Dashboard's listing form during Task 9; it isn't consumed by the app itself).

- [ ] **Step 1: Write the listing content**

```markdown
# App Store listing — MerchGrid: Catalog Audit

## App name
MerchGrid: Catalog Audit

## Subtitle (max ~70 chars)
Find pricing and inventory problems in your catalog — read-only.

## Introduction (short description, ~100 chars)
Scans your product catalog and shows exactly which items are priced
below cost, missing SKUs, or otherwise costing you sales — without
touching your store.

## Details (long description)
MerchGrid scans your Shopify catalog and shows you the product-data,
pricing, and merchandising problems that may be costing you sales:

- Products priced below their recorded cost
- Margins below a threshold you set
- Zero or negative pricing on active products
- Compare-at (sale) prices that don't create a real discount
- Duplicate or missing SKUs
- Duplicate barcodes
- Variant prices that are unusual outliers within a product

Every finding explains what's wrong, why it matters, and links straight
to the product in your Shopify admin so you can review and fix it
yourself. Export the full report as CSV anytime.

MerchGrid is read-only. It never edits, creates, or deletes anything in
your store — it only reads your product and inventory data to build the
report.

## Feature list (bullets)
- Detect below-cost and low-margin pricing
- Catch invalid or ineffective sale (compare-at) prices
- Find duplicate and missing SKUs
- Find duplicate barcodes
- Spot price outliers within a product's variants
- Filter and search every finding
- Export the full report as CSV
- 100% read-only — never modifies your store

## Pricing
Free

## Category
Reporting / inventory management (confirm exact Shopify category taxonomy
at submission time — it may have changed since this was written)

## Screenshots needed (see Task 5 for how to capture these)
1. Onboarding screen ("Run catalog audit")
2. Scan progress screen
3. Results dashboard with summary cards + findings table
4. Finding detail modal open
5. Settings screen (margin threshold)

## Support / legal URLs
- Privacy policy: https://merchgrid-catalog-audit.fly.dev/privacy
- Terms of service: https://merchgrid-catalog-audit.fly.dev/terms
- Support: https://merchgrid-catalog-audit.fly.dev/support
```

- [ ] **Step 2: Commit**

```bash
mkdir -p docs/launch
git add docs/launch/app-store-listing.md
git commit -m "docs: draft App Store listing copy"
```

---

### Task 5: Self-testing walkthrough (do this yourself, now)

This is a checklist, not code — you run through it personally. It's also the source of the screenshots Task 4 needs. Re-run it after any deploy as your production-rehearsal smoke test.

**Prerequisite:** Node 22, this repo, a Shopify Partner account + dev store (already set up from earlier in this project).

- [ ] **Step 1: Start the app locally**
  ```bash
  cd app && npm run dev
  ```
  (Terminal 1 — opens a Shopify CLI tunnel, prints a preview URL.)

- [ ] **Step 2: Start the worker**
  ```bash
  cd app && npm run worker
  ```
  (Terminal 2 — required. Without this, a scan sits at "Connecting..." forever.)

- [ ] **Step 3: Seed your dev store with fixtures** (skip if already seeded)

  Get a write-scoped token: dev store admin → Settings → Apps and sales channels → Develop apps → Create an app → configure Admin API scopes (`write_products`, `read_inventory`, `write_inventory`) → Install → reveal the Admin API access token.

  ```bash
  FIXTURE_SHOP=your-dev-store.myshopify.com \
  FIXTURE_ADMIN_TOKEN=shpat_xxx \
  npm run seed:fixtures
  ```

- [ ] **Step 4: Install/open the app** in your dev store admin via the CLI's preview link.

- [ ] **Step 5: Walk the full merchant journey, screenshotting each step:**
  1. **Onboarding** — confirm the read-only messaging is visible before you click anything. Screenshot.
  2. **Click "Run catalog audit."** Confirm it redirects to a progress screen.
  3. **Progress screen** — confirm it auto-advances through stages without a manual refresh. Screenshot.
  4. **Results dashboard** — confirm summary cards show non-zero Critical/Warning/Unavailable counts (the seeded fixtures should trigger all 10 checks). Screenshot.
  5. **Filters** — filter by severity "Critical," confirm the table narrows and the count updates. Clear filters.
  6. **Search** — search `BC-001` (one of the fixture SKUs), confirm exactly the matching row appears.
  7. **Finding detail** — click a finding, confirm the modal shows price/cost/margin/explanation and an "Open in Shopify" link that actually opens the right product. Screenshot.
  8. **Export CSV** — click export, open the downloaded file, confirm it has all findings and the header row matches the spec's column order.
  9. **Settings** — go to Settings, change the margin threshold to something else, save, confirm a success message. Screenshot.
  10. **Re-run a scan** — confirm the new threshold is used, but check the *previous* scan's stored `minimumMarginPercentUsed` is unchanged (past scans aren't retroactively affected).
  11. **Uninstall** the app from the dev store admin. **Reinstall** it. Confirm onboarding loads cleanly again (this exercises `afterAuth`/`ensureShop` re-provisioning).

- [ ] **Step 6: Tear down fixtures when done experimenting**
  ```bash
  npm run seed:fixtures:clean
  ```

- [ ] **Step 7: Repeat steps 4–6 against the production URL** once Task 0 (Fly billing) is resolved — this is the actual production rehearsal, proving the deployed build (not just your laptop) survives the full journey. Also specifically try: force a scan failure (temporarily revoke the store's cost-data field, or just watch what happens if you kill the worker process mid-scan and restart it) and confirm the scan ends in a clean `FAILED` state with a generic message, not stuck forever.

**Done when:** every step above completes without a manual database fix or code change, and you have the 5 screenshots Task 4 needs.

---

### Task 6: Reviewer test instructions

**Files:** Create `docs/launch/reviewer-instructions.md` (paste this into the Partner Dashboard's "instructions for the reviewer" field at submission time).

- [ ] **Step 1: Write the instructions**

```markdown
# Instructions for the App Store reviewer

MerchGrid: Catalog Audit is a **read-only** app — it never creates,
edits, or deletes any store data. It requests only `read_products` and
`read_inventory` scopes.

## How to test

1. Install the app on a test store.
2. On the first screen, click "Run catalog audit." No further setup is
   required.
3. The scan runs in the background (typically under a minute for a small
   catalog) and the screen auto-updates to show progress, then results.
4. If your test store's products have no cost data set, most findings
   will appear under "Could not evaluate" (this is expected and correct
   — see the app's own explanation text on that category). To see the
   full range of findings (below-cost pricing, duplicate SKUs, invalid
   sale prices, etc.), add cost data to a couple of products, or set one
   product's price below its cost, before scanning.
5. Every finding links directly to the affected product in your store
   admin ("Open in Shopify").
6. Findings can be exported as CSV from the results screen.
7. The margin threshold used for below-margin findings is adjustable
   under Settings.

## Privacy / data handling

See https://merchgrid-catalog-audit.fly.dev/privacy. No customer, order,
or checkout data is ever accessed.
```

- [ ] **Step 2: Commit**

```bash
git add docs/launch/reviewer-instructions.md
git commit -m "docs: add App Store reviewer test instructions"
```

---

## Phase 2 — Submission

### Task 7: Self-audit against Shopify's review checklist

**Files:** none — this is a verification pass, not a code change. If any item below fails, that's a new task, not a checkbox to fudge.

- [ ] Confirm scopes are exactly `read_products,read_inventory` in `app/shopify.app.toml` — no write scopes anywhere.
- [ ] Confirm the three mandatory GDPR webhooks + `app/uninstalled` respond correctly (already built — re-verify via Task 5's uninstall/reinstall step).
- [ ] Confirm no UI text, listing copy, or README claims "AI-powered" or similar (grep for "AI" across `app/app/routes/` and `docs/launch/`).
- [ ] Confirm the app has no billing configuration (correct for a free launch — Shopify requires the Billing API only for *paid* public apps).
- [ ] Confirm `/privacy`, `/terms`, `/support` are live at the production URL and match what's in the listing.
- [ ] Confirm the embedded app loads correctly via App Bridge with no console errors (re-check during Task 5's production rehearsal).
- [ ] Confirm `app/shopify.app.toml`'s `application_url` and `redirect_urls` point at the live production URL, not a stale tunnel address.

---

### Task 8: Submit for review

- [ ] In the Shopify Partner Dashboard → your app → **Distribution**, set distribution to "Shopify App Store" if not already.
- [ ] Fill in the listing using `docs/launch/app-store-listing.md` (Task 4) and the 5 screenshots from Task 5.
- [ ] Paste privacy/terms/support URLs.
- [ ] Paste reviewer instructions from `docs/launch/reviewer-instructions.md` (Task 6).
- [ ] Run Shopify's built-in pre-submission self-review checks in the dashboard, if offered, and resolve anything flagged.
- [ ] Submit.

### Task 9: Handle review feedback

- [ ] If Shopify's review flags an issue, respond with exact proof (a URL, the exact steps you took, a screenshot, or a short screen recording) rather than a general reply — reviewers move faster on concrete evidence.
- [ ] Avoid starting unrelated feature work while a submission is under review, so you can turn around review feedback quickly.
- [ ] On approval: the app is publicly listed. This is the actual finish line for this plan — merchant recruiting and the first paid tier (scheduled scans + alerts, per the frozen non-goals) are separate, later efforts.

---

## Self-review — plan coverage

| Launch-readiness item from the review | Covered by |
|---|---|
| Freeze the MVP promise / activation sequence | Already decided (this plan); nothing new to build for it — Global Constraints keep it frozen |
| Gate A — core user journey | Task 5 (self-test walkthrough) |
| Gate B — production reliability / instrumentation | Task 1 (structured logging) |
| Gate C — marketplace compliance / production rehearsal | Task 0 (Fly billing), Task 5 step 7, Task 7 (self-audit) |
| Gate D — security and trust / data inventory | Task 3 (privacy policy's data table) — already built: token encryption, per-shop authz, GDPR redact |
| Gate E — supportability | Task 3 (support page's category list) |
| Listing assets, reviewer instructions | Task 4, Task 6 |
| Billing | Explicitly out of scope (Global Constraints) — launch free per the frozen MVP promise |
| Founder dashboard / detailed metrics | Explicitly deferred — Task 1's structured logs are the MVP version; revisit only after real usage exists |
