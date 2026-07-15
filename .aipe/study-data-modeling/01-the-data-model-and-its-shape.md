# The data model and its shape

### Entity-Relationship Model / Schema-as-built — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the schema lives

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  Remix routes (app.scans.$id.tsx, app.settings.tsx)       │
  └───────────────────────────┬────────────────────────────────┘
                              │  function calls (same process)
  ┌─ Service layer ───────────▼────────────────────────────────┐
  │  scan-api.server.ts, runner.server.ts, shop.server.ts      │
  └───────────────────────────┬────────────────────────────────┘
                              │  Prisma Client
  ┌─ Storage layer ───────────▼────────────────────────────────┐
  │  ★ THIS CONCEPT ★                                          │
  │  schema.prisma → 5 models → one SQLite file on a Fly volume│
  └──────────────────────────────────────────────────────────┘
```

Everything downstream in this app — every route, every service function, every query — ultimately reads or writes one of five tables defined in `app/prisma/schema.prisma`. Before anything else in this guide makes sense, you need the shape of those five tables and why they're shaped that way. That's this file.

## Structure pass

**Axis: ownership — who owns whom, and what disappears when the owner disappears?**

Tracing "does deleting this row delete its children" across the schema exposes the real skeleton faster than reading field lists top to bottom:

```
  One axis, traced across every entity

  axis = "what happens on delete?"

  Session          → owns nothing, owned by nothing (orphan by shape)
  Shop             → owns ShopSettings, Scan (CASCADE)
  ShopSettings     → owned by Shop, owns nothing
  Scan             → owned by Shop, owns Finding + ScanArtifact (CASCADE)
  Finding          → owned by Scan, owns nothing
  ScanArtifact     → owned by Scan, owns nothing (and currently: owned by no code either)
```

The seam falls in exactly one place: **`Session` doesn't sit in the cascade tree at all.** Every other model traces back to `Shop` through a real foreign key with `ON DELETE CASCADE`. `Session.shop` is a bare `TEXT` column (`schema.prisma:18`) — same string value as `Shop.shopDomain`, but no `@relation`, no FK, no cascade. That's not an oversight; it's a fossil. `Session` was created by migration `20240530213853_create_session_table` — the Shopify CLI template's session-storage model, laid down before `Shop`/`Scan`/`Finding` existed at all (those arrive in `20260715004357_domain_models`, over a year later per migration timestamps). The two model families were never unified because `@shopify/shopify-app-session-storage-prisma` owns the shape of `Session` — it's a contract with a library, not a domain model this app is free to redesign.

That single seam — "one model predates and sits outside the domain-model cascade tree, four models sit inside it" — is the whole skeleton. Everything below hangs off it.

## How it works

### The kernel: one root aggregate, two cascade generations deep

**Isolate the kernel.** Strip every field down to just the relationships and you get a two-level tree rooted at `Shop`:

```
  The cascade tree — the irreducible shape

         Shop (root aggregate)
        /              \
  ShopSettings        Scan  (1:N)
   (1:1)               / \
                       /   \
                 Finding  ScanArtifact
                 (1:N)     (1:N)
```

**Name each part by what breaks when it's missing.** Drop the `Shop → Scan` cascade and uninstalling a shop (deleting its `Shop` row) leaves orphaned `Scan`/`Finding` rows with a `shopId` that no longer resolves — every scan-history query silently starts returning garbage. Drop `Scan → Finding` cascade and every re-run of a scan (`runScan`'s delete-then-insert, see `04`) would need a second manual cleanup step instead of relying on the FK. The cascade is not hardening — it's the reason `redactShop` (`app/app/models/shop.server.ts:49-51`) can be a single `prisma.shop.deleteMany({ where: { shopDomain } })` and correctly erase every trace of a shop's data for the GDPR `shop/redact` webhook in one call.

### `Session` — the Shopify template model

```ts
// app/prisma/schema.prisma:16-34
model Session {
  id                  String    @id
  shop                String        // ← plain string, no @relation to Shop
  state               String
  isOnline            Boolean   @default(false)
  ...
  accessToken         String        // encrypted at rest by EncryptedSessionStorage
                                     // (see app/app/services/session/)
}
```

`shop` here is a domain string (`"merchant.myshopify.com"`), the same value stored on `Shop.shopDomain` — but there is no foreign key tying them together, and no index on `shop` either. That's fine for its actual access pattern: `@shopify/shopify-app-session-storage-prisma` looks sessions up by `id` (the primary key) or scans by `shop` in small volumes (one active session per shop, occasionally a handful during token refresh). It is not part of this app's domain schema and shouldn't be redesigned to look like one.

### `Shop` — the root aggregate

```ts
// app/prisma/schema.prisma:36-47
model Shop {
  id             String    @id @default(cuid())
  shopDomain     String    @unique   // ← the real business key
  installStatus  String    @default("INSTALLED")
  ...
  settings       ShopSettings?
  scans          Scan[]
}
```

Two identifiers do two different jobs here: `id` is the cuid primary key every other table's foreign keys point at, and `shopDomain` is the unique business key every *lookup* actually starts from — every service function in `scan-api.server.ts` resolves a shop by `shopDomain` first (`resolveShopOrThrow`, `scan-api.server.ts:100-106`), then works in terms of `shop.id` from there on. That two-key pattern — surrogate key for joins, natural key with a `@unique` for external lookups — is the standard shape for a multi-tenant root entity, and it's applied consistently.

### `ShopSettings` — 1:1, split out on purpose

```ts
// app/prisma/schema.prisma:49-57
model ShopSettings {
  id                   String   @id @default(cuid())
  shopId               String   @unique     // ← @unique makes this 1:1, not 1:N
  shop                 Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  minimumMarginPercent Int      @default(20)
  catalogVariantLimit  Int      @default(5000)
}
```

`shopId @unique` is the one line of Prisma syntax that turns what would otherwise be a 1:N relation into 1:1 — without it, nothing stops two `ShopSettings` rows pointing at the same `Shop`. Splitting settings into their own table rather than adding two columns to `Shop` is a real modeling choice: `Shop` is written once at install and rarely again; `ShopSettings` is written every time a merchant tweaks the margin threshold (`updateMinimumMargin`, `settings.server.ts:51-65`). Separating a rarely-written root from a more-frequently-written settings blob keeps writes narrow — a settings update never touches `installStatus`/`installedAt`/`shopifyShopId`.

### `Scan` — the per-run aggregate

```ts
// app/prisma/schema.prisma:59-82
model Scan {
  id                       String    @id @default(cuid())
  shopId                   String
  shop                     Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  status                   String    @default("QUEUED")
  minimumMarginPercentUsed Int              // ← snapshot, see 02
  partial                  Boolean   @default(false)
  findings                 Finding[]
  artifacts                ScanArtifact[]
  @@index([shopId, status])
}
```

One row per audit run. `status` is a bare `TEXT` column with no `CHECK` constraint restricting it to the six legal values (`QUEUED`, `READING_CATALOG`, `RUNNING_CHECKS`, `PREPARING_RESULTS`, `COMPLETED`, `FAILED`) — the database will happily store `status = "banana"`. The state machine in `app/app/services/scan/state.ts` is the only thing enforcing the six-value, forward-only shape (walked in full in `04-transactions-and-integrity.md`).

### `Finding` — one row per detected issue, deliberately fat

```ts
// app/prisma/schema.prisma:84-125
model Finding {
  id           String   @id @default(cuid())
  scanId       String
  scan         Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  shopId       String                 // duplicated, undexed, unqueried — see 02
  checkId      String
  severity     String
  severityRank Int                    // derived — see 02
  productId    String
  variantId    String?
  price          String?              // point-in-time copy of the variant — see 02
  compareAtPrice String?
  unitCost       String?
  currencyCode   String?
  sku            String?
  barcode        String?
  productStatus  String?
  searchText     String   @default("")
  @@index([scanId, severity])
  @@index([scanId, severityRank, checkId])
}
```

`Finding` is the widest table in the schema, and that width is a decision, not an accident: `runScan` (see `04`) never re-fetches from Shopify once a scan completes, so the CSV export and the finding-detail UI need everything they'll ever show already sitting on the row. The alternative — a slim `Finding` plus a foreign key back into a persisted catalog snapshot — is explicitly rejected by the "data minimization" constraint (`.aipe/project/context.md`: "don't retain whole catalog payloads"). You'll walk exactly which of these fields are copies and why in `02-normalization-and-duplication.md`.

### `ScanArtifact` — modeled, cascaded, unexercised

```ts
// app/prisma/schema.prisma:127-135
model ScanArtifact {
  id         String   @id @default(cuid())
  scanId     String
  scan       Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  type       String
  storageKey String
  expiresAt  DateTime?
}
```

A repo-wide search for `ScanArtifact` and `scanArtifact` turns up exactly two hits — both in a code comment in `shop.server.ts` explaining what cascades when a shop is redacted. No route creates one. No service reads one. No test exercises one. **Not yet exercised**, stated plainly: this table is pre-built scaffolding for a future feature (persisted export files, presumably — `storageKey` and `expiresAt` are the tell) that hasn't shipped. It costs nothing at rest (SQLite doesn't charge for an empty table) but it is schema surface a new contributor has to read past without a clear payoff yet.

## Primary diagram

```
  MerchGrid schema — the full recap

  Session (fossil)         Shop (root)
  ┌──────────────┐         ┌──────────────────────┐
  │ id (PK)      │         │ id (PK, cuid)         │
  │ shop: TEXT   │  ≈ same │ shopDomain UNIQUE     │
  │ (no FK)      │  value  │ installStatus         │
  └──────────────┘         └──────────┬────────────┘
                                       │ 1:1 CASCADE      1:N CASCADE
                             ┌─────────┴──────────┐   ┌──┴─────────────┐
                             │ ShopSettings        │   │ Scan            │
                             │ minimumMarginPercent│   │ status (no CHECK)│
                             │ catalogVariantLimit │   │ minMarginUsed   │
                             └─────────────────────┘   │ partial         │
                                                        └──┬──────────┬──┘
                                                 1:N CASCADE│          │1:N CASCADE
                                                  ┌─────────┴──┐   ┌───┴────────────┐
                                                  │ Finding     │   │ ScanArtifact    │
                                                  │ (wide, fat) │   │ (unexercised)   │
                                                  └─────────────┘   └────────────────┘
```

## Elaborate

This shape — one root tenant entity, a settings sidecar split off for write-frequency reasons, a per-run aggregate, and a wide leaf table that denormalizes for read-completeness — is a textbook multi-tenant audit-log shape. You'd recognize the same pattern in a CI system (`Repo` → `Build` → `TestResult`) or a security scanner (`Target` → `Scan` → `Vulnerability`). The recurring principle: **the leaf table (`Finding`, `TestResult`, `Vulnerability`) is where read-time convenience wins over storage economy**, because leaf rows are read far more often than they're written, and a join back to a mutable parent risks showing the reader today's data instead of the data at scan time.

The one thing worth carrying forward from this repo specifically: `Session` staying outside the cascade tree isn't sloppiness — it's a sign of a boundary between "this library's contract" and "this app's domain model." When a third-party library owns a table's shape (session storage adapters, auth providers, background-job libraries), resist the urge to retrofit foreign keys into it just for schema tidiness. The library's contract is the actual constraint.

## Interview defense

**Q: Why doesn't `Session.shop` have a foreign key to `Shop.id`?**
A: `Session` is the Shopify CLI template's session-storage model, owned by `@shopify/shopify-app-session-storage-prisma` — its shape is a contract with that library, not something this app is free to redesign. It predates the `Shop`/`Scan`/`Finding` domain models entirely (migration `20240530213853` vs `20260715004357`, over a year apart). Retrofitting an FK would mean forking the library's expected schema for no functional gain — session lookups already go through `id` or `shop` (string) at the volumes this app runs at.

```
  Session          Shop
  shop: "x.com" ≈  shopDomain: "x.com"
       (string equality, not a DB-enforced relation)
```

**Q: What's the load-bearing part of this schema that a new contributor would miss?**
A: The cascade chain rooted at `Shop`. Everything downstream of `Shop` — settings, every scan ever run, every finding, every artifact — disappears in one `deleteMany` when a shop is GDPR-redacted (`shop.server.ts:49-51`), because every one of those tables has `onDelete: Cascade` back to its parent. Miss that, and you'd hand-roll a four-table cleanup routine that's already free.

**Q: `ScanArtifact` exists in the schema — what does it do?**
A: Nothing yet. It's modeled and cascaded correctly, but zero routes or services create or read it — confirmed by grep, not inference. It's scaffolding for a feature that hasn't shipped.

## See also

- `02-normalization-and-duplication.md` — the specific fields on `Finding` that are copies, and why (or why not) that's justified.
- `04-transactions-and-integrity.md` — what actually enforces `Scan.status`'s six legal values, since the DB doesn't.
- `.aipe/study-software-design/` — information hiding in code; this file's cascade-tree ownership axis is that same idea applied to data.
