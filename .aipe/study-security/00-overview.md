# 00 — Security overview

The trust map, then the three findings that matter most.

```
Trust map — MerchGrid: Catalog Audit

┌─ Untrusted / external ────────────────────────────────────────────────┐
│  merchant's browser (embedded admin, App Bridge session token)        │
│  Shopify webhooks (HMAC-signed: uninstall, scopes_update, compliance) │
│  Shopify Admin GraphQL API (third-party data: the merchant's catalog) │
└──────────────┬────────────────────────────┬───────────────────────────┘
     session token JWT                 HMAC-verified POST
               ▼                                  ▼
┌─ Trust boundary #1 — authenticate.admin / authenticate.webhook ───────┐
│  @shopify/shopify-app-remix verifies the caller IS a real, installed  │
│  shop session before any route body runs.        (lens 2, audit.md)  │
└──────────────┬─────────────────────────────────────────────────────────┘
               ▼
┌─ Trust boundary #2 — per-shop ownership (scan-api.server.ts) ─────────┐
│  proves the AUTHENTICATED shop owns the resource it's asking for      │
│  (a scan id is not a capability token — see 02-per-shop-tenant-       │
│  isolation.md). Same 404 for "doesn't exist" and "someone else's".    │
└──────────────┬─────────────────────────────────────────────────────────┘
               ▼
┌─ Storage layer — one SQLite file, every shop's rows ──────────────────┐
│  Session (accessToken: AES-256-GCM ciphertext, see 01)                │
│  Shop / ShopSettings / Scan / Finding — tenant-scoped by shopId        │
└─────────────────────────────────────────────────────────────────────┬─┘
                                                                       │
┌─ Secrets — Fly secrets, never in git ──────────────────────────────┐│
│  SHOPIFY_API_SECRET · SESSION_ENCRYPTION_KEY · SESSION_SECRET      ││
└─────────────────────────────────────────────────────────────────────┘│
                                                                        │
┌─ Deploy / supply chain ───────────────────────────────────────────────┘
│  package-lock.json committed · @shopify/shopify-api pinned via        │
│  overrides · 18 known vulns in the production dependency tree         │
└────────────────────────────────────────────────────────────────────────
```

## The three highest-risk findings

1. **DEPLOY.md's own "known caveats" section is stale and contradicts the code.** `app/DEPLOY.md:169-177` still says "Shopify access tokens are stored unencrypted at the application layer" — true when that runbook was written (commit `dd5a9dc`), false since `ef7ec2d`/`42b3319`/`ee9af2b` shipped `EncryptedSessionStorage`. A reader of the deploy runbook alone would conclude a control is missing that has, in fact, shipped and is wired in via `SESSION_ENCRYPTION_KEY`. Low exploitability (it's a doc, not code) but real: stale security documentation gets trusted at face value during an incident. Fix: delete or rewrite that caveat. See `01-encrypted-session-storage-at-rest.md`.

2. **18 known vulnerabilities in the production dependency tree (`npm audit --production`: 0 critical / 12 high / 6 moderate), rooted almost entirely in `@remix-run/dev` being listed under `"dependencies"` instead of `"devDependencies"` (`app/package.json:37`).** `@remix-run/dev` bundles the Vite/esbuild toolchain used only at build time — it never runs in the request path — but because it's a production dependency on paper, every audit tool (and a future SCA gate) will flag it as live-surface risk it isn't. The fix is a one-line move to `devDependencies`; it collapses the production-audit count without touching any runtime behavior. See `audit.md` → lens 6.

3. **The webhook payload cast in `webhooks.app.scopes_update.tsx:9`** (`const current = payload.current as string[];`) trusts the *shape* of an HMAC-verified payload without validating it. HMAC proves the payload came from Shopify unmodified; it does not prove the payload matches this route's assumed shape if Shopify ever changes the `app/scopes_update` schema. A malformed or missing `current` field would write a stringified `undefined` into `Session.scope` rather than fail loudly. Low severity today (Shopify controls both ends), but it's the one input-validation gap in an otherwise disciplined webhook surface. See `audit.md` → lens 3.

## Per-primitive verdict

| Primitive | Verdict |
|---|---|
| Trust boundaries | Every mutable-looking action funnels through `authenticate.admin` or `authenticate.webhook` before touching data — no route skips the gate. |
| Authentication | Session-token JWT exchange, library-enforced (`@shopify/shopify-app-remix`). Not reimplemented in app code — correct call for an embedded Shopify app. |
| Authorization | Per-shop row ownership, enforced in one seam (`loadOwnedScan`) reused by every read — not re-derived per route. See `02`. |
| Input validation | Prisma parameterizes every query (no raw SQL surface); numeric params are clamped; the one gap is the webhook payload cast above. |
| Secrets | Fly secrets, never in `fly.toml`/git; `SESSION_ENCRYPTION_KEY` validated at process start, with a hard "never rotate" constraint documented — the deploy runbook itself is stale (finding #1). |
| Data exposure | Denormalized findings carry only display-needed fields (not the whole catalog); cross-tenant probes get identical 404s; failures return a generic message, never the real error. One open gap: CSV export doesn't defuse formula-injection prefixes. |
| Dependencies | Lockfile committed, one pinned override to avoid a duplicate-package type mismatch; audit count is inflated by a devDependency misclassification (finding #2), not runtime-reachable vulnerabilities. |
| LLM/agent security | **Not yet exercised.** No LLM, no agent loop, no tool-calling anywhere in this codebase. |

Full lens-by-lens grounding: `audit.md`. Deep mechanism walks: `01`–`05`.
