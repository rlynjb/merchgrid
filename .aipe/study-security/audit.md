# Audit — the 8-lens walk

Every lens below names what the codebase actually does, with `file:line` grounding, or says `not yet exercised` plainly. Where a finding is deep enough to earn its own file, it cross-links instead of repeating the walk.

## 1. Trust boundaries and attack surface

Four places untrusted input crosses into this app's trusted code:

- **The embedded admin UI** (merchant's browser, inside Shopify's iframe). Every loader/action under `app/routes/app*.tsx` and `app/routes/api.scans*.tsx` calls `authenticate.admin(request)` first (e.g. `app/app/routes/api.scans.$id.tsx:18`, `app/app/routes/app.tsx:13`, `app/app/routes/app.settings.tsx:17,25`) — this validates the App Bridge session token before any handler body runs.
- **Shopify webhooks** (`app/app/routes/webhooks.*.tsx`). Each calls `authenticate.webhook(request)` (`webhooks.app.uninstalled.tsx:7`, `webhooks.compliance.tsx:6`, `webhooks.app.scopes_update.tsx:6`), which verifies the HMAC signature Shopify signs every webhook POST with. A request without a valid signature never reaches the handler body — this is library-enforced, not app code, and it's the correct call: reimplementing HMAC verification in-app would be pure risk for no benefit.
- **The Shopify Admin GraphQL API response** (`app/app/services/shopify/catalog-reader.server.ts`). This is third-party data flowing in — the merchant's own catalog, but still data this app didn't produce. `requireData` (`catalog-reader.server.ts:248-256`) refuses to trust a well-formed-but-missing `data` field rather than letting a raw `TypeError` propagate, and GraphQL error bodies are never surfaced verbatim to callers (`catalog-reader.server.ts:232-236`) — see `05-sanitized-failure-boundary.md`.
- **Environment variables / Fly secrets** at process boundary (`shopify.server.ts:26-30`, `SESSION_ENCRYPTION_KEY` at `shopify.server.ts:18`) — see lens 4.

Red flag check: **no input here is treated as trusted "because it comes from our own frontend."** Every embedded-UI route re-authenticates via the session token on every request; nothing is cached as "already checked." Passes.

## 2. Authentication and authorization

**Who-are-you (authn):** session-token JWT exchange, entirely delegated to `@shopify/shopify-app-remix`'s `authenticate.admin` / `authenticate.webhook` (`shopify.server.ts:55`). The app never issues, verifies, or stores its own session tokens/JWTs — it hands that to the library and only ever consumes `session.shop` after the fact. Correct scope for an embedded Shopify app: authn is Shopify's problem, not this app's.

**What-can-you-do (authz):** every read of a `Scan`/`Finding` goes through `loadOwnedScan(shop, scanId)` (`app/app/services/scan/scan-api.server.ts:114-120`), which checks `scan.shopId !== shop.id` and throws the *same* `ScanNotFoundError` whether the scan doesn't exist or belongs to another shop. `getScanSummary` (`scan-api.server.ts:161-168`), `getScanFindings` (`scan-api.server.ts:225-237`), and `getAllFindingsForExport` (`scan-api.server.ts:286-295`, ownership checked *before* the completion-status gate) all funnel through it. → full walk in `02-per-shop-tenant-isolation.md`.

The classic gap this lens hunts for — **authn present, authz assumed** — does not fire here: `startScan` (`scan-api.server.ts:130-135`) and `enqueueScan` (`queue.server.ts:44-77`) both resolve the shop by the *authenticated* `session.shop` domain, never by a client-supplied shop id, so there's no way for an authenticated caller to enqueue or read against a shop it isn't.

## 3. Input validation and injection

**SQL injection:** not reachable. Every query goes through Prisma's query builder (`prisma.scan.findUnique`, `prisma.finding.findMany`, etc. throughout `scan-api.server.ts`) — no raw SQL, no string-built queries anywhere in the app layer.

**Numeric input bounds:** pagination params are parsed with `Number()` and clamped rather than trusted raw — `getScanFindings`'s `page`/`pageSize` (`scan-api.server.ts:239-245`) floors to a minimum of 1 and caps `pageSize` at `MAX_PAGE_SIZE = 200` (`scan-api.server.ts:28`) regardless of what the query string asks for. The margin-percent setting is validated as an integer in `[MARGIN_MIN, MARGIN_MAX]` before it's ever persisted (`app/app/models/settings.server.ts:8-20`).

**The one real gap — webhook payload shape trusted without validation.** `webhooks.app.scopes_update.tsx:9`:
```ts
const current = payload.current as string[];
```
`authenticate.webhook` proves the *bytes* came from Shopify (HMAC), but nothing here proves `payload.current` is actually a `string[]` — it's a type assertion, not a runtime check. If Shopify ever sends a differently-shaped `app/scopes_update` payload, this silently calls `.toString()` (`webhooks.app.scopes_update.tsx:16`) on whatever `current` actually is and writes the result into `Session.scope` (`webhooks.app.scopes_update.tsx:11-18`) rather than failing loudly. Fix: a runtime shape check (`Array.isArray(current) && current.every(...)`) before the cast, falling back to logging-and-skipping the update on a mismatch.

**CSV export / formula injection:** `escapeCsvField` (`packages/catalog-checks/src/csv.ts:43-48`) implements RFC 4180 quoting (commas, quotes, CRLF) but does not defuse a field that *starts* with `=`, `+`, `-`, or `@` — the classic CSV-formula-injection vector where Excel/Sheets executes a leading `=` as a formula on open. The realistic path here is thin (the fields that flow through, `productTitle`/`variantTitle`/`sku`/`barcode`/`explanation`, all originate from the merchant's *own* Shopify catalog — see `catalog-reader.server.ts:41-79` — so the "attacker" would have to be the merchant's own staff naming their own products maliciously), but it's a real gap in an otherwise careful escaper and a one-line fix: prefix a `'` (or a bare quote-wrap) on any field starting with one of those four characters before the RFC-4180 escape.

**Prompt injection:** not applicable — no LLM anywhere in this codebase (see lens 7).

## 4. Secrets and configuration

Everything sensitive is a **Fly secret**, never committed: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SESSION_SECRET`, `SESSION_ENCRYPTION_KEY` (`app/DEPLOY.md:75-82`). `shopify.app.toml` (committed) holds only the `client_id` (`shopify.app.toml:3`) — a Partner Dashboard identifier, not a secret; the actual client secret lives exclusively in the Fly secret, matching Shopify's own threat model for these values.

`SESSION_ENCRYPTION_KEY` is validated eagerly at process construction — `assertValidKey` (`token-crypto.server.ts:33-39`) runs from `EncryptedSessionStorage`'s constructor (`encrypted-session-storage.server.ts:31`), so a misconfigured key (wrong length, non-hex) fails at boot, caught by Fly's health check, instead of surfacing deep inside an OAuth callback on the first real write. → full walk in `01-encrypted-session-storage-at-rest.md`.

**A documented, deliberate constraint that's also a real operational risk:** `SESSION_ENCRYPTION_KEY` must never be rotated once tokens are encrypted with it (`app/DEPLOY.md:91-96`, `.aipe/project/context.md`) — rotating it orphans every encrypted token and forces every merchant to reinstall. This is a one-way door with no rotation path built in; it's the right tradeoff for a key that's rarely touched, but it means a leaked key has no in-place remediation short of a mass reinstall.

**Stale security documentation:** `DEPLOY.md`'s "Known caveats" section (`DEPLOY.md:169-177`) still asserts "Shopify access tokens are stored unencrypted at the application layer" — written in commit `dd5a9dc`, before `ef7ec2d`/`42b3319`/`ee9af2b` shipped encryption. The claim is false as of the current code. See `00-overview.md` finding #1.

## 5. Data exposure and privacy

**Data minimization by design.** `Finding` rows persist only the per-variant fields the UI/CSV actually need (`prisma/schema.prisma:107-122`, comment: "Deliberately NOT the whole catalog") — the full `CatalogSnapshot` read from Shopify is never persisted, only denormalized onto findings that already fired.

**Anti-enumeration on every cross-tenant probe.** A wrong-shop scan id resolves to the identical `ScanNotFoundError` → generic 404 as a genuinely-missing scan id, in both `api.scans.$id.tsx:43-48` and `api.scans.$id.export.tsx:40-48`. An attacker probing scan ids from another tenant learns nothing — not even "that id exists but isn't yours." → `02-per-shop-tenant-isolation.md`.

**No PII in webhook logs.** `webhooks.compliance.tsx:8-10` explicitly logs only `topic` + `shop`, with an inline comment naming *why*: `CUSTOMERS_DATA_REQUEST`/`CUSTOMERS_REDACT` payloads carry customer id/email/phone, and none of that reaches `console.log`.

**Verbose error messages:** never. Every failure path in the scan pipeline writes a generic, pre-written string to the DB and to the caller — the actual error (query text, stack trace, upstream Shopify error body) is logged server-side only (`console.error`) and never returned. → `05-sanitized-failure-boundary.md`.

**Open gap:** the CSV-formula-injection edge case from lens 3 is a data-exposure-adjacent finding too — a formula field, if it ever fired, would execute in whatever spreadsheet tool opens the export, not leak data from this app, but it's the right lens to also flag it under.

## 6. Dependencies and supply chain

**Lockfile hygiene:** `package-lock.json` is present and committed (`app/package-lock.json`) — reproducible installs, no "whatever npm resolves today" surface.

**A deliberate, documented pin:** `package.json:91` overrides `@shopify/shopify-api` to `13.1.0` — forcing every transitive consumer (`@shopify/shopify-app-remix`, `@shopify/shopify-app-session-storage-prisma`) onto one copy instead of two divergent nested versions. `DEPLOY.md:178-185` documents the type-mismatch this was fixing and is honest that it's cosmetic (a `tsc --noEmit` type error, not a runtime bug) — a good example of naming a real, current limitation instead of hiding it.

**`npm audit --production`: 0 critical / 12 high / 6 moderate (18 total).** Nearly all of it traces back to one root cause: `@remix-run/dev` is listed under `"dependencies"` (`package.json:37`) instead of `"devDependencies"`, even though it's Remix's build-time compiler/dev-server (Vite + esbuild) and never runs in the deployed request path (`remix-serve ./build/server/index.js` at runtime — `package.json:14` — never imports `@remix-run/dev`). Because `npm audit --production` walks whatever's under `"dependencies"`, this misclassification drags a build-tool's transitive esbuild/Vite CVEs into the "production" audit surface where they don't belong. **The fix is a one-line move** (`@remix-run/dev` and its Remix-tooling siblings `@remix-run/fs-routes`/`@remix-run/route-config` into `devDependencies`) that would collapse the reported production-vuln count without changing what code actually ships. Full non-production audit (including real devDependencies) is 36 high / 6 moderate — worth periodic review, but none of it sits on the request path a live attacker can reach.

**`trustedDependencies: ["@shopify/plugin-cloudflare"]`** (`package.json:75-77`) opts one package into running lifecycle (postinstall) scripts under whatever package manager honors this field — a narrow, explicit allowlist rather than a blanket "allow all postinstall scripts," which is the right default posture.

## 7. LLM and agent security

**Not yet exercised.** This repo has no LLM calls, no prompt construction, no tool-calling loop, and no agent of any kind — `.aipe/project/context.md` states this as a hard constraint: "Deterministic, not AI... do not add LLM/AI to the first app." Every one of the 10 catalog checks (`packages/catalog-checks/src/checks/mg-0*.ts`) is a pure, deterministic function over normalized variant data.

If the planned future "MerchGrid: Bulk AI" product (mentioned in `.aipe/project/context.md`) adds an LLM-driven changeset-preflight feature, the load-bearing questions this lens would then ask: does model output ever reach a sink (a Shopify mutation call, a shell command, a SQL string) without a gate in between; does the agent's tool/permission scope exceed its task (e.g. a "preflight" agent that can also write); is retrieved/user content ever concatenated into a prompt without a boundary marker. None of these apply to the current, deterministic MVP.

## 8. Security red-flags audit — consolidated checklist

| Red flag | Fires? | Location | Severity | Fix |
|---|---|---|---|---|
| Input treated as trusted because it's "from our own frontend" | No | — | — | — |
| Endpoint checks logged-in but not allowed (authn without authz) | No | `scan-api.server.ts:114-120` enforces ownership on every read | — | — |
| String-built query/prompt with user input | No | Prisma parameterizes everywhere; no LLM | — | — |
| Webhook/API payload shape trusted without runtime validation | **Yes** | `webhooks.app.scopes_update.tsx:9` | Low | Runtime shape-check `payload.current` before the `as string[]` cast |
| Secret in source, client bundle, or logs | No | Secrets are Fly-only (`DEPLOY.md:75-82`); webhook logs exclude PII (`webhooks.compliance.tsx:8-10`) | — | — |
| Error/response returns more than the caller is entitled to | No | Generic 404 for cross-tenant probes; generic failure messages (`05`) | — | — |
| CSV/export field not defused against formula injection | **Yes** | `packages/catalog-checks/src/csv.ts:43-48` | Low | Prefix a `'` on fields starting with `=+-@` |
| No lockfile, or known CVEs unpatched | Partial | Lockfile present; 18 audit findings, but root-caused to a `devDependencies` misclassification (`package.json:37`), not an unpatched runtime CVE | Low–Medium (documentation/audit-hygiene, not exploitable) | Move `@remix-run/dev` (+ siblings) to `devDependencies` |
| Stale/incorrect security documentation | **Yes** | `DEPLOY.md:169-177` | Low (docs, not code) | Rewrite the caveat now that encryption has shipped |
| Agent with tool scope exceeding its task; ungated model output reaching a sink | N/A | No LLM/agent code exists | — | — |

Three real, low-severity fires; nothing critical or high-severity in the app's own code. The dependency-audit number is the only one that reads scary out of context — lens 6 above explains why it isn't.
