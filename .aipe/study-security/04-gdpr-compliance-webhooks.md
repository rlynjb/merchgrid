# 04 — GDPR compliance webhooks

**Mandatory data-subject-rights webhooks (right to erasure / right to access) + PII-minimized logging.** Industry standard (GDPR Art. 17, Shopify's mandatory app compliance topics) — project-specific implementation (`webhooks.compliance.tsx`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ External — Shopify's compliance dispatcher ───────────────────────┐
│  fires CUSTOMERS_DATA_REQUEST / CUSTOMERS_REDACT / SHOP_REDACT       │
│  ~48h after uninstall, HMAC-signed POST                              │
└──────────────────────────┬───────────────────────────────────────┬──┘
                            │ POST /webhooks/compliance              │
                            ▼                                       │
┌─ Trust boundary — webhooks.compliance.tsx  ★ THIS CONCEPT ★ ───────┤
│  authenticate.webhook (HMAC) → switch(topic) → redactShop           │
└──────────────────────────┬───────────────────────────────────────┬──┘
                            ▼                                       │
┌─ Storage — Shop row + cascading Scan/Finding/ScanArtifact ─────────┘
│  SHOP_REDACT: entire shop's data tree deleted                       │
└─────────────────────────────────────────────────────────────────────┘
```

A privacy webhook that either doesn't handle every mandatory topic, mishandles one, or logs the very PII it's supposed to be protecting is a compliance failure with real legal weight — Shopify requires all three compliance topics wired to get App Store approval, and mishandling `CUSTOMERS_REDACT`/`SHOP_REDACT` is a GDPR erasure-right failure, not just a bug. `webhooks.compliance.tsx` is where this app proves it takes the "delete my data" request seriously, both in what it deletes and in what it never writes to a log line in the process.

## Structure pass

**Axis: trust — what's the honest answer to "what data do you hold on this person/shop," and does the code match the answer?** This app's honest answer for *customer* data is "none — MerchGrid never reads or stores customer PII" (scopes are `read_products,read_inventory` only, never `read_customers`). The code has to match that claim exactly, or the webhook handler becomes a second place the claim could quietly become false.

```
Trust flips at "does deleting my data actually delete it?"

axis traced = "after SHOP_REDACT fires, what's left?"

┌─ before redactShop ────────────┐  seam: shop.server.ts  ┌─ after redactShop ─────┐
│ Shop, ShopSettings, every Scan,  │ ══════╪══════════════► │ zero rows for this shop │
│ every Finding, every ScanArtifact│  (cascade delete)       │ (all foreign keys       │
│ for this shopDomain              │                          │  cascaded, not orphaned)│
└─────────────────────────────────────┘                          └──────────────────────────┘
```

**Seam:** a single Prisma `deleteMany` on the `Shop` row (`shop.server.ts:49-51`), relying on `onDelete: Cascade` declared on every child relation in `prisma/schema.prisma` — `ShopSettings` (`schema.prisma:52`), `Scan` (`schema.prisma:62`), `Finding` (`schema.prisma:87`), `ScanArtifact` (`schema.prisma:130`). One deletion point, enforced at the database level, is the property that makes "we deleted everything" actually true instead of "we deleted everything we remembered to delete."

## How it works

Think of the three mandatory topics like three different tickets that can each land on your desk: "tell me what you have on me," "delete what you have on me," and "the whole account is closing, delete everything." Each needs a distinct, correct answer, and Shopify requires all three wired to even list an app in its store — this file is where the correct answer for each is decided.

### The kernel — isolate it

```
Compliance webhook kernel

  authenticate.webhook(request)          // HMAC verification (library)
       │
  switch (topic)
       │
    ├─ CUSTOMERS_DATA_REQUEST ──► no customer data held → empty 200
    ├─ CUSTOMERS_REDACT ────────► no customer data held → empty 200
    ├─ SHOP_REDACT ─────────────► redactShop(shop) → cascade delete → 200
    └─ default ──────────────────► 404 (unhandled topic — fail loudly,
                                      never silently accept an unknown one)
```

**What breaks if `CUSTOMERS_DATA_REQUEST`/`CUSTOMERS_REDACT` returned an error instead of an empty 200:** Shopify would flag the app as failing its mandatory compliance topics, jeopardizing App Store standing — even though "we hold no customer data" is a perfectly valid, correct answer to both requests. The right response to "I have nothing to give you" is a clean 200, not a 4xx.

**What breaks if the `default` case didn't throw:** a new mandatory topic Shopify adds in the future would silently return 200 without doing anything — looking compliant while actually ignoring a request the app was supposed to handle. Failing loudly on an unrecognized topic is the correct posture for a compliance surface: silent success is the worst failure mode here, because nothing downstream would ever notice.

```ts
// app/app/routes/webhooks.compliance.tsx:1-29
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);

  // Do NOT log the payload: customers/data_request and customers/redact
  // payloads contain customer PII (id, email, phone). Log topic + shop only.
  console.log(`Received compliance webhook ${topic} for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      return new Response();              // MerchGrid stores no customer data
    case "CUSTOMERS_REDACT":
      return new Response();              // MerchGrid stores no customer data
    case "SHOP_REDACT":
      await redactShop(shop);             // ~48h after uninstall
      return new Response();
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }
};
```

**The log line is the part easy to get wrong, and this code gets it right on purpose.** The comment at line 8-9 doesn't just avoid logging PII — it names *why*, specific to the two topics that actually carry it (`CUSTOMERS_DATA_REQUEST`/`CUSTOMERS_REDACT` payloads include customer id/email/phone per Shopify's webhook schema). `console.log` here only ever receives `topic` and `shop` — both of which are operationally necessary to debug "did this webhook fire" without ever writing a customer's email address into a log aggregator that a different set of people can read than the production database.

**`redactShop` is intentionally a single delete, not a manual sweep of tables:**
```ts
// app/app/models/shop.server.ts:49-51
export async function redactShop(shopDomain: string): Promise<void> {
  await prisma.shop.deleteMany({ where: { shopDomain } });
}
```
**What breaks if this were instead five separate deletes (Shop, ShopSettings, Scan, Finding, ScanArtifact) in application code:** any one omitted or reordered delete leaves orphaned rows — a `Finding` row with no `Scan`, a `Scan` with no `Shop`, all still holding data that should be gone. Relying on the database's own `onDelete: Cascade` (declared once per relation in `schema.prisma`, not re-implemented per deletion call site) means the deletion is correct by construction: there is no code path where the cascade is "forgotten" for a new child table added later, because the constraint lives on the schema, not on the deletion call.

**The uninstall/redact split is a deliberate retention-window design, not an oversight.** `app/uninstalled` (`webhooks.app.uninstalled.tsx`) only flips `installStatus`/`uninstalledAt` (`shop.server.ts:63-68`) — it does *not* delete Scan/Finding data. `shop/redact` (fired ~48h later, per Shopify's own compliance timing) is what actually deletes everything. This means there's a real window (uninstall → redact) where a shop's audit history still exists in the database even though the app is uninstalled — intentional, to preserve scan history during Shopify's own mandated retention window, and it's Shopify's `shop/redact` timing that closes it, not this app's own clock.

## Primary diagram

```
The three mandatory compliance topics, one route, one switch

┌─ Shopify compliance dispatcher (external, HMAC-signed) ─────────────┐
│  fires one of three topics at /webhooks/compliance                   │
└───────┬──────────────────┬──────────────────┬────────────────────────┘
        │ CUSTOMERS_        │ CUSTOMERS_       │ SHOP_REDACT
        │ DATA_REQUEST      │ REDACT           │ (~48h post-uninstall)
        ▼                   ▼                  ▼
┌─ authenticate.webhook (HMAC verified) ─────────────────────────────────┐
│  console.log(topic, shop)  ← NEVER the payload (comment at line 8-9)  │
└───────┬──────────────────┬──────────────────┬──────────────────────────┘
        ▼                   ▼                  ▼
   empty 200            empty 200        redactShop(shop)
   ("we hold no         ("we hold no           │
    customer data")      customer data")       ▼
                                        ┌─ prisma.shop.deleteMany ────┐
                                        │  cascades: ShopSettings,     │
                                        │  every Scan, every Finding,  │
                                        │  every ScanArtifact          │
                                        │  (onDelete: Cascade, schema  │
                                        │   level — schema.prisma      │
                                        │   :52,:62,:87,:130)          │
                                        └──────────────────────────────┘
```

## Elaborate

This is the right-to-erasure half of GDPR (and CCPA's equivalent deletion right) implemented at the app-integration level Shopify requires of every App Store listing — the three topics here (`customers/data_request`, `customers/redact`, `shop/redact`) are Shopify's own mandated compliance surface, declared not as regular webhook subscriptions but under `shopify.app.toml`'s `[webhooks.privacy_compliance]` block, which is why all three route to the same handler rather than three separate `[[webhooks.subscriptions]]` entries. The pattern generalizes: any app integrating with a platform that has its own data-subject-rights obligations needs (1) an honest inventory of what it actually stores about the data subject, (2) a deletion path that's correct-by-construction rather than manually swept, and (3) logging discipline that doesn't leak the very data the deletion request is about.

## Interview defense

**Q: Why does `app/uninstalled` not just delete everything immediately?**
A: Because Shopify's `shop/redact` webhook — fired roughly 48 hours after uninstall — is the actual mandated erasure signal; `app/uninstalled` is a different event (the merchant removed the app, which might be a mistake they reverse) and deleting audit history immediately on uninstall would be premature. The retention window between the two preserves scan history in case of a quick reinstall, while still honoring the erasure obligation on its own mandated timeline.

**Q: What would you check first if this webhook silently stopped firing in production?**
A: Whether `shopify.app.toml`'s `[webhooks.privacy_compliance]` URLs (`customer_data_request_url`/`customer_deletion_url`/`shop_deletion_url`, all `/webhooks/compliance`) are still correctly pointed at the deployed `application_url`, and whether the last `shopify app deploy` actually pushed that config to Shopify's side — these are registered with Shopify directly, not inferred from route file presence, so a stale config push is the most likely silent failure mode.

**Q: The `default` case throws a 404 for an unrecognized topic. Is that the right failure mode for a compliance-critical route?**
A: Yes, specifically because the alternative (silently returning 200) is the failure mode that actually matters here: a new Shopify-added compliance topic this app doesn't yet handle would look successful in Shopify's dispatcher logs while doing nothing, and nobody would notice until an actual compliance audit. A loud 404 surfaces in monitoring immediately.

## See also

- `05-sanitized-failure-boundary.md` — the same "log the safe thing, not the dangerous thing" discipline applied to scan-pipeline errors instead of webhook payloads.
- `audit.md` → lens 5 (data exposure and privacy).
