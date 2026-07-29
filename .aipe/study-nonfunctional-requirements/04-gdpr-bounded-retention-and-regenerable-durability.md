# GDPR-bounded retention and regenerable durability

### Data-value-driven retention policy — Project-specific, industry pattern (data classification)

## Zoom out, then zoom in

```
  Zoom out — two policies that only make sense read together

  ┌─ Privacy lens ─────────────────────────────────────────────────┐
  │  webhooks.compliance.tsx: SHOP_REDACT → cascading DELETE           │
  │  (fast, real, ~48h after uninstall)                                  │
  └───────────────────────┬────────────────────────────────────────┘
                         │ both driven by the same underlying
                         │ judgment about what this data IS
  ┌─ Durability lens ───────▼────────────────────────────────────────┐
  │  ★ THIS PATTERN ★ — no Litestream, no continuous backup,            │ ← we are here
  │  Fly's own daily volume snapshots are the only recovery path         │
  └────────────────────────────────────────────────────────────────┘
```

At first glance these look like opposite postures: one policy says "delete
this fast and completely the moment someone asks" (privacy); the other
says "don't bother protecting this against loss" (durability). They're
actually the same underlying call, read from two directions — this app's
`Scan`/`Finding` data is **regenerable but sensitive**: not precious enough
to warrant continuous backup, but real enough (it's the merchant's own
catalog data) to warrant prompt, complete deletion on request.

## Structure pass — layers, axis, seams

**Layers:** the GDPR webhook handler (`webhooks.compliance.tsx`) → the
delete function (`shop.server.ts`) → the durability posture named in
`DEPLOY.md`.

**The axis: what does this app believe this data is worth, and to whom?**

```
  One axis, two opposite-looking policies, one consistent answer

              "how precious is this data to keep?"    "how sensitive is it to retain?"
  privacy   →  n/a — retention is fine UNTIL asked      HIGH: delete completely,
               to stop                                    fast, on request
  durability →  LOW: don't build continuous backup,      n/a — this axis is about
               data is regenerable                          loss, not exposure

  the seam: both policies agree the data is "the merchant's own, not
  MerchGrid's own" — worth deleting fast when asked, not worth protecting
  against loss because losing it costs a re-scan, not a merchant's business
```

**Why this seam matters:** a system that got this backwards — treating
scan/finding data as precious enough to back up continuously, but lax
about deleting it on a GDPR request — would be optimizing for the wrong
owner. This app's two policies both correctly locate ownership with the
merchant, not with MerchGrid.

## How it works

### Move 1 — the mental model

You've decided before whether a piece of client state needs to survive a
page refresh (localStorage) or can just be recomputed (a derived value in
a render). Recomputable state doesn't need careful persistence; state a
user typed in and can't get back does. This app applies the identical
judgment at the infrastructure level: `Scan`/`Finding` rows are the
"recomputed" case (a merchant can just re-run the scan), so they don't get
continuous-backup treatment — but they're still real enough, and still
represent the merchant's own product data, that a deletion request has to
be honored completely and fast.

```
  Pattern: classify data by (a) is it recomputable, (b) whose is it

                          recomputable?          sensitive / whose data?
  Scan/Finding rows    →  YES (re-run scan)   →  merchant's own catalog data
                                                   → delete completely on request
                                                   → don't over-invest in backup
  Session tokens        →  NO (re-auth needed) →  MerchGrid's own OAuth credential
                                                   → encrypted at rest (separate NFR,
                                                     see .aipe/study-security/01)
```

### Move 2 — the two policies, side by side

**Policy 1 — retention until asked, then a real cascade delete.**
`app/app/routes/webhooks.app.uninstalled.tsx` marks a shop `UNINSTALLED`
but deliberately does **not** delete `Scan`/`Finding` data — it's retained
for the GDPR retention window. The actual delete only fires on the
`SHOP_REDACT` compliance topic (`app/app/routes/webhooks.compliance.tsx:19-22`):
```ts
case "SHOP_REDACT":
  // Fired ~48h after uninstall. Delete all data for the shop.
  await redactShop(shop);
  return new Response();
```
```ts
// app/app/models/shop.server.ts:49-51
export async function redactShop(shopDomain: string): Promise<void> {
  await prisma.shop.deleteMany({ where: { shopDomain } });
}
```
`Shop`'s cascade delete (declared on the Prisma relations, per
`.aipe/project/context.md`'s data model section) takes `ShopSettings`,
`Scan`, `Finding`, and `ScanArtifact` with it in one operation — this is a
real, complete deletion, not a soft-delete flag. Full mechanism:
`.aipe/study-security/04-gdpr-compliance-webhooks.md`.

**Policy 2 — no continuous backup, because the data is disposable.**
`app/DEPLOY.md`'s "Known caveats" section:
```
SQLite-on-a-volume durability is single-node. There's no replication —
if the volume is lost, the data is lost. ... consider adding Litestream
... as a later hardening step. Not implemented here.
```
And independently, in the project's own decision record
(`.aipe/project/context.md`, "Known deferred / follow-ups"): "Litestream
backups intentionally skipped (data is regenerable; volume has daily
snapshots)." Full mechanism:
`.aipe/study-database-systems/07-wal-durability-and-recovery.md`.

**Why both are correct given the same underlying fact:** the *value* of a
`Finding` row to MerchGrid is transient (re-derivable by re-running the
scan against Shopify), which is exactly why it's safe to under-invest in
backup. The *sensitivity* of that same row to the merchant (it describes
their real prices, margins, SKUs) is why deletion has to be complete and
prompt when they ask, not soft or partial. These aren't in tension — they're
the same classification, applied to two different questions (how to
protect it from loss vs. how to protect it from unwanted retention).

### Move 3 — the principle

Data-handling policy shouldn't be decided per-feature in isolation —
retention, backup, and deletion all flow from the same upstream question:
*whose data is this, and how expensive is it to lose or to keep?* Answer
that once, and the durability posture, the backup investment, and the
deletion discipline all follow consistently, rather than each being
decided ad hoc and potentially contradicting each other.

## Primary diagram

```
  Two policies, one underlying classification

  ┌─ the classification ────────────────────────────────────────────┐
  │  Scan/Finding data = regenerable (re-run scan) + merchant's own       │
  │  (real prices, SKUs, margins — not MerchGrid's business record)        │
  └───────────────────────────┬────────────────────────────────────┘
              ┌───────────────┴───────────────┐
              ▼                                ▼
  ┌─ durability policy ───────────┐  ┌─ privacy policy ─────────────┐
  │  no Litestream, Fly daily        │  │  retain until SHOP_REDACT,       │
  │  snapshots only — "regenerable"    │  │  then cascade DELETE, complete,   │
  │  justifies the lax backup            │  │  ~48h after uninstall               │
  └────────────────────────────┘  └────────────────────────────┘
       LOW investment in loss              HIGH discipline on
       protection                           deletion-on-request
```

## Elaborate

This is a specific instance of a general data-classification discipline:
before deciding backup strategy, retention window, or deletion SLA for any
dataset, name what it actually is — a system of record (irreplaceable,
back it up continuously), a cache or derived artifact (regenerable, backup
optional), or someone else's data you're processing on their behalf
(regardless of recomputability, honor their deletion rights promptly).
`Session` (OAuth tokens) and `Scan`/`Finding` sit in genuinely different
buckets in this same app — tokens get AES-256-GCM encryption at rest
because losing *those* means every merchant has to reinstall
(`.aipe/study-security/01-encrypted-session-storage-at-rest.md`), while
scan data gets no such investment because losing it just means a re-scan.

## Interview defense

**Q: "Isn't 'no backup for merchant data' a compliance risk?"**
A: No — GDPR governs how you handle personal data and honor deletion/access
rights, not whether you back the data up; there's no regulatory requirement
to protect a merchant's product catalog findings from *your own* data loss.
This app's actual compliance obligation (delete completely on
`SHOP_REDACT`) is met regardless of backup posture — the two are
independent requirements, and this app satisfies both correctly for
different reasons.
One-line anchor: *durability and compliance are different axes; conflating
them would over- or under-invest in the wrong one.*

**Q: "What would make you reconsider the no-backup call?"**
A: If `Scan`/`Finding` data ever stopped being purely re-derivable from a
fresh Shopify read — for example, if a future feature let merchants
annotate findings, override severities, or attach notes that don't exist
anywhere else. At that point the data would no longer be "regenerable," and
the backup calculus would need to be redone from the same first question:
is this now irreplaceable to someone?

## See also

- `.aipe/study-security/04-gdpr-compliance-webhooks.md` — the full
  mechanism behind the three mandatory GDPR topics.
- `.aipe/study-database-systems/07-wal-durability-and-recovery.md` — the
  full durability/recovery mechanism, including exactly what survives a
  lost machine vs. a lost volume.
- `.aipe/study-data-modeling/07-data-modeling-red-flags-audit.md` — the
  destructive-migration-with-no-rollback finding, which leans on this same
  "small tables, regenerable data" justification.
- `audit.md` lens 6 (availability/security/privacy) — where this pattern's
  evidence is cited from the NFR-verdict angle.
