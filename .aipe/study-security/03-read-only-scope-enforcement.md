# 03 — Read-only scope enforcement

**Least privilege / principle of least authority, enforced in depth.** Industry standard concept — project-specific implementation (`read_products,read_inventory` scopes + query-only GraphQL client).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Config layer — shopify.app.toml ──────────────────────────────────┐
│  scopes = "read_products,read_inventory"   ← what Shopify GRANTS    │
└──────────────────────────┬──────────────────────────────────────────┘
                            │ OAuth grants exactly these scopes
                            ▼
┌─ Service layer — catalog-reader.server.ts  ★ THIS CONCEPT ★ ───────┐
│  every GraphQL operation is `query`, never `mutation`                │
│                                    ← what the CODE actually issues   │
└──────────────────────────┬──────────────────────────────────────────┘
                            ▼
┌─ External — Shopify Admin GraphQL API ──────────────────────────────┐
│  even if code tried to mutate, the granted scopes would reject it   │
└───────────────────────────────────────────────────────────────────────┘
```

"This app never writes to a merchant's store" is the single most load-bearing security claim MerchGrid makes — it's the sentence that lets a merchant install an app that reads their entire pricing and cost data with some confidence nothing gets touched. That claim is enforced at three independent layers, not just asserted in a README: the OAuth scope grant, the shape of every GraphQL query issued, and the absence of any write-capable code path in the deployed app at all.

## Structure pass

**Axis: trust — what could a compromised or buggy code path actually DO to the merchant's store?** Trace it across each layer:

```
One axis, three layers — "if this app's code were malicious or buggy,
                            what's the worst it could do to the store?"

┌─ shopify.app.toml scope grant ───┐   → could ask Shopify for a mutation,
│  read_products, read_inventory     │      Shopify REJECTS it (scope missing)
└───────────────────────────────────┘

┌─ catalog-reader.server.ts ─────────┐   → the ONLY GraphQL client in the app;
│  hand-written queries, no mutation │      it structurally cannot construct
│  operations exist in this file      │      a mutation string to send
└───────────────────────────────────┘

┌─ rest of the app (routes, worker) ──┐   → no other file calls admin.graphql
│  no other Admin API caller exists   │      at all — nothing to bypass the
└───────────────────────────────────────┘      one read-only client through
```

**Seam:** each layer is independently sufficient. Even if a future PR accidentally wrote a mutation string into `catalog-reader.server.ts`, the scope grant would still reject it server-side at Shopify. Even if the scope grant were mistakenly widened, no code in this app constructs a mutation to take advantage of it. That's defense in depth: the property doesn't rest on any single layer being perfect.

## How it works

You've built the "give the caller the minimum access it needs" version of this before, even if you called it something else — an API key scoped to `read-only`, a Postgres role with `SELECT` but no `INSERT`/`UPDATE` grants, an IAM policy with one action allowed. The idea transfers directly: prove the *narrowest* capability and enforce it in more than one place, so a mistake in one layer doesn't become the only thing standing between "read" and "write."

### Layer 1 — the OAuth scope grant

```toml
# shopify.app.toml:8-10
[access_scopes]
scopes = "read_products,read_inventory"
```
This is what Shopify's OAuth flow actually grants at install time — the merchant sees exactly these two scopes on the consent screen, and the resulting access token is only valid for `read_*` operations against products and inventory. No `write_products`, no `write_inventory`, no scope for orders, customers, discounts, or anything else in the Admin API surface. `shopify.server.ts:29` reads this from `process.env.SCOPES`, matching `shopify.app.toml`'s declared list — the two must stay in sync (Shopify enforces the *installed* scopes, not whatever the app happens to request at runtime).

**What breaks if a scope is added without a corresponding code change:** nothing automatically — Shopify would grant the wider access, but nothing in this app's code would use it, because layer 2 below is a separate, independent constraint. That's the point of having two layers: a scope-file mistake alone doesn't create a mutation path.

### Layer 2 — the GraphQL client only ever constructs `query` operations

`catalog-reader.server.ts` is the **only** module in this app that calls `admin.graphql(...)` for catalog data (verify: `AdminGraphqlClient.graphql` is the sole interface for issuing Admin API calls, and this is the only file implementing a caller against it for product/variant reads). Every operation string in the file is a GraphQL `query`, never a `mutation`:

```ts
// app/app/services/shopify/catalog-reader.server.ts:39-40
// Read-only: this module must never issue a mutation. Only `query`
// operations below.
```

```ts
// catalog-reader.server.ts:41-43 (PRODUCTS_PAGE_QUERY) and :87-89
// (PRODUCT_VARIANTS_PAGE_QUERY) — both start with `query`, never `mutation`
const PRODUCTS_PAGE_QUERY = `#graphql
  query CatalogReaderProducts($cursor: String) { ... }
`;
```

**What breaks if someone pastes a mutation here by mistake:** layer 1 catches it — Shopify's Admin API rejects a `mutation` operation against a token that was only granted `read_*` scopes, regardless of what the app's code sends. The two layers are independent checks on the same property, which is exactly what makes this "defense in depth" rather than one control with a backup name.

### Layer 3 — no other write-capable path exists in the deployed app

Grepping the entire `app/app` and `app/packages` trees for `mutation` turns up exactly one hit outside test files: the comment in `catalog-reader.server.ts` explaining the constraint. There is no admin-mutation helper, no "update inventory" route, no write-capable service anywhere the worker or web process could reach. The only place a Shopify *mutation* string exists anywhere in this repository is `app/scripts/seed-fixtures.ts` — and that script is deliberately architected to be unreachable from the deployed app:

```ts
// app/scripts/seed-fixtures.ts:7, 82-85
// token (`FIXTURE_ADMIN_TOKEN`), supplied only via environment variables.
// ...
// "write-scoped Admin API token — it never reuses the MerchGrid app's..."
```

It's a standalone CLI script, run manually by a developer against a dev store, authenticated with its own separate `FIXTURE_ADMIN_TOKEN` env var (`seed-fixtures.ts:491-500`) — never the app's own OAuth session, never invoked by any route or the worker. **What breaks if this separation were ever blurred** (e.g. the seed script's write token accidentally got wired into the running app's config): the entire "read-only" security claim would become false for real, not just architecturally implausible. Keeping the write-capable tooling in a script with its own explicitly-separate credential is what makes "the deployed app cannot write" a fact about the shipped code, not just a fact about the files most people read.

## Primary diagram

```
Read-only enforced at three independent layers

┌─ Shopify (external) ────────────────────────────────────────────────┐
│  OAuth grants EXACTLY: read_products, read_inventory                 │
│  (shopify.app.toml:8-10, shopify.server.ts:29)                        │
│  → any `mutation` sent with this token: REJECTED server-side          │
└──────────────────────────┬─────────────────────────────────────────┬─┘
                            │ token usable for query ops only          │ scope check
                            ▼                                          │ independent
┌─ catalog-reader.server.ts (the only Admin API caller) ────────────────┤ of layer 2
│  PRODUCTS_PAGE_QUERY, PRODUCT_VARIANTS_PAGE_QUERY — both `query`      │
│  no mutation string exists anywhere in this file                      │
└──────────────────────────┬─────────────────────────────────────────┬─┘
                            │ no other caller exists                   │
                            ▼                                          │
┌─ Rest of the deployed app (routes/, worker.ts) ────────────────────────┘
│  zero other admin.graphql callers — nothing to route a mutation through │
└──────────────────────────────────────────────────────────────────────────┘

┌─ app/scripts/seed-fixtures.ts (standalone, dev-only, separate token) ───┐
│  the ONLY mutation strings in the repo — never reachable from the app  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the principle of least privilege applied at multiple altitudes simultaneously — the same discipline behind scoping a cloud IAM role to exactly the actions a service needs, or granting a database user `SELECT`-only on a reporting replica. What makes it worth a dedicated file here rather than a one-line audit note is the *depth*: most apps stop at "we only requested read scopes" and call it done. This one backs that claim with an architectural constraint (one client module, no mutation strings) and a process-level separation (the one place mutations do exist is unreachable from the running service). Each layer alone would be a reasonable security posture; together they mean a single mistake in any one layer doesn't undo the claim.

## Interview defense

**Q: If the scope grant already prevents mutations at the API level, why also enforce query-only in application code?**
A: Because scopes are a runtime enforcement point you don't control the failure mode of — if Shopify's API ever had a scope-enforcement bug, or a future engineer widened the scope list without thinking it through, the *only* thing standing between "read-only" and "can write" would be Shopify's server-side check. Enforcing it again in the client code means a scope misconfiguration alone can't produce a write — you'd need both layers to fail at once.

**Q: The seed-fixtures script clearly contains mutations. Doesn't that undermine the read-only claim?**
A: No — and this is the right answer to give, not a dodge: the claim is about the *deployed app*, not about every file in the repository. The script is explicitly a separate, manually-run dev tool with its own credential (`FIXTURE_ADMIN_TOKEN`), never wired into `shopify.server.ts`'s OAuth session, never invoked by any route or the worker process. The comment at `seed-fixtures.ts:85` states the separation is deliberate. Naming that clearly — rather than pretending the script doesn't exist — is what makes the read-only claim about the *product* credible.

**Q: What's the actual attacker capability this defends against?**
A: A compromised or buggy code path attempting to modify the merchant's store — pricing, inventory counts, product visibility — anything a `write_products`/`write_inventory` scope would permit. Because the scope was never granted and the code never attempts a mutation, that capability doesn't exist even if an attacker achieved code execution inside the running app; the *worst* they could do via the Shopify API is exactly what the app already legitimately does: read the catalog.

## See also

- `02-per-shop-tenant-isolation.md` — read-only scope answers "can this app write," this answers "which shop's data can a read touch."
- `audit.md` → lens 1 (trust boundaries) — the Admin GraphQL response is the third-party-data trust boundary this control sits behind.
