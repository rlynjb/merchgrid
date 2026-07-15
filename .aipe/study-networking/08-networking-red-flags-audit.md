# Networking red-flags audit
## Ranked protocol and network-failure risks, grounded in this repo

## Zoom out, then zoom in

Every other file in this guide teaches one mechanism end to end. This file inverts the lens: instead of "how does X work," it asks "where, across everything this repo does on the wire, is a real failure most likely to originate — and how consequential is it?" The ranking below is ordered by consequence, not by how interesting each finding is to explain.

```
  Zoom out — where the ranked risks sit on the network map

  ┌─ Browser ─────────────────────────────────────────────┐
  │  #4 fixed poll interval — low risk at current scale      │
  └───────────────────────┬──────────────────────────────────┘
  ┌─ Fly edge / machine ─────▼────────────────────────────────┐
  │  #2 single machine, single region — no failover             │
  │  #5 health check can't see DB/Shopify health (by design)     │
  └───────────────────────┬──────────────────────────────────────┘
  ┌─ catalog-reader.server.ts ★ #1, #3 — highest-consequence ★──┐
  │  no per-call timeout · unconfigured connection pooling         │
  └────────────────────────────────────────────────────────────────┘
```

## The structure pass

**Axis: blast radius — how much of the system does each finding actually threaten if it fires?**

- Findings #1 and #3 (below) sit on the one hop this app fully owns end to end (the outbound Shopify GraphQL calls) — a failure there can stall a single scan or, in the timeout case, block the worker from ever advancing past a stuck one.
- Finding #2 sits at the infrastructure layer — its blast radius is the entire app, but its likelihood is low (Fly region outages are rare, and this is an accepted tradeoff of the single-machine architecture, not a bug).
- Finding #4 is a cost/scale concern, not a correctness one — its blast radius grows only if usage patterns change.
- A few adjacent findings belong to a different generator's lens entirely and are cross-linked rather than re-analyzed here, per this guide's partition seam (`study-networking` owns *what happens on the wire*; `study-security` owns *whether it's safe*).

## Ranked findings

### 1. No wall-clock timeout around the outbound Shopify GraphQL calls — highest consequence

**Where:** `app/app/services/shopify/catalog-reader.server.ts:200-241` (`runQuery()`), specifically the `await admin.graphql(query, { variables })` at line 211.

**What's missing:** the retry policy (`RetryPolicy`, `maxRetries` + `sleep`) bounds how many times a call is *retried*, but nothing bounds how long any single attempt is allowed to *take*. If Shopify's API accepts the connection and never responds (as opposed to responding with an error, which the retry logic already handles), the `await` simply never resolves. No retry fires, no error propagates, and the scan sits in `READING_CATALOG` forever.

**Consequence:** because `worker-core.server.ts`'s `claimAndRunNext()` awaits `runScan()` to completion before claiming the next queued scan (there's exactly one worker process, per the project's single-writer design), a single hung call doesn't just fail one merchant's scan — it can block every other shop's queued scan behind it indefinitely.

**Fix, concretely:** wrap the `admin.graphql(...)` call in an `AbortController`-driven timeout (a handful of lines) so a hang becomes a rejection — which the existing retry path (lines 213-224) already knows how to handle as a retryable network failure. This is additive, not a rewrite: the retry kernel described in `07-timeouts-retries-pooling-and-backpressure.md` doesn't need to change shape, it just needs one more input event to react to.

### 2. Single machine, single region — no network-level failover

**Where:** `app/fly.toml:16` (`primary_region = "iad"`), `app/fly.toml:1-8` (comment explaining why no `[processes]` block exists), `app/DEPLOY.md:163-168` (the repo's own honest caveat about SQLite-on-a-volume durability).

**What's missing:** there is exactly one Fly machine, in exactly one region, with one SQLite volume that can't be shared across machines. If that region has an outage, or the volume is lost, there is no automatic network-level failover — no secondary region to route to, no replica to promote.

**Consequence:** total outage for the duration of the incident, with no recovery path faster than restoring from a Fly volume snapshot.

**This is a named, accepted tradeoff, not an oversight** — `DEPLOY.md` states it directly and points at Litestream as the specific hardening step this repo chose to skip (per the project's own "Known deferred / follow-ups"). Recorded here because it's a real network-availability risk, not because it's an unrecognized one.

### 3. Outbound Shopify HTTP connection pooling is unconfigured

**Where:** no file in this repo sets a custom `Agent`, pool size, or idle-connection timeout for the client `admin.graphql()` runs on top of (walked in `03-tcp-udp-connections-and-sockets.md`).

**What's missing:** whatever connection reuse happens across the sequential calls in `readCatalog()`'s pagination loop is entirely `undici`'s default behavior — never explicitly verified or tuned for this app's actual call pattern (many sequential calls to the same host, in a tight loop, for large catalogs).

**Consequence, currently low:** at today's scale (one worker, one scan at a time, catalogs capped at a 5,000-variant guardrail), default pooling is very likely adequate. This becomes a real finding worth acting on only if the app scales to multiple concurrent workers or Shopify's own connection-reuse recommendations for high-volume Admin API callers become relevant — worth a comment in the code near `runQuery()` noting the default is intentional-by-omission rather than verified, so a future reader doesn't have to rediscover this.

### 4. Fixed 2.5-second poll interval, independent of scan size or open-tab count

**Where:** `app/app/routes/app.scans.$id.tsx:514-516`.

**What's missing:** the interval is a constant, not adjusted for how long a scan is expected to take or how many merchants have the results page open simultaneously.

**Consequence, currently low:** each poll is a cheap, per-shop, authorization-gated read against a local SQLite file — no external API call, no expensive query. The cost only becomes real if usage patterns change significantly (walked in full, including the SSE alternative, in `06-websockets-sse-streaming-and-realtime.md`).

### 5. Health check deliberately can't see database or Shopify health — a tradeoff, not a gap

**Where:** `app/app/routes/healthz.tsx:3-15`, `app/fly.toml:45-51`.

**Named here for completeness, not as a finding to fix:** `/healthz` intentionally skips Prisma and Shopify auth so Fly's liveness check answers "is the process serving HTTP" independent of "is the database/Shopify session store fully healthy." The tradeoff: Fly's automated restart-on-failed-health-check will never fire for a genuinely broken SQLite file or expired offline tokens — those failures surface as scans going `FAILED`, not as a machine restart. That's the right shape for a liveness check (you don't want a slow DB write taking the whole machine out of rotation) — it's recorded here so the boundary is explicit, not because it's a defect.

## What's out of scope here — cross-linked, not re-analyzed

- **Shopify access tokens stored unencrypted at rest unless `SESSION_ENCRYPTION_KEY` is set** (`DEPLOY.md:169-177`) is a data-exposure-at-rest concern, not a wire-protocol one — it belongs to `study-security`, not here.
- **The webhook HMAC/session-token verification being entirely delegated to `@shopify/shopify-app-remix`** (walked in `04-tls-and-trust-establishment.md`) is a correct architectural choice, not a red flag — recorded there as a teaching point about where trust boundaries live, not repeated here as a risk.
- **The TOCTOU race in `enqueueScan()`** (`queue.server.ts`'s own comment, "not atomic... acceptable for MVP") is a database-concurrency concern, not a networking one — it belongs to `study-database-systems` or `study-distributed-systems`.

## Primary diagram

```
  Ranked risk map — consequence × likelihood

  HIGH consequence  ┌───────────────────────────────────────┐
                     │ #1 no per-call timeout                 │ ← fix first
                     │    (catalog-reader.server.ts:211)       │
                     ├───────────────────────────────────────┤
                     │ #2 single machine/region, no failover   │ ← accepted,
                     │    (fly.toml:16, DEPLOY.md:163-168)      │   documented
                     └───────────────────────────────────────┘
  MED consequence    ┌───────────────────────────────────────┐
                     │ #3 unconfigured connection pooling       │ ← revisit at
                     │    (undici default, no custom Agent)     │   scale
                     └───────────────────────────────────────┘
  LOW consequence    ┌───────────────────────────────────────┐
                     │ #4 fixed poll interval                    │ ← revisit if
                     │ #5 health check scope (by design)         │   usage grows
                     └───────────────────────────────────────┘
```

## Interview defense

**Q: If you had to fix exactly one thing in this app's networking code, what would it be?**
The missing per-call timeout in `catalog-reader.server.ts`'s `runQuery()`. It's a small, additive fix (wrap the call in an `AbortController` timeout) that closes the one gap where a single hung request can block every other shop's queued scan behind it — the highest consequence-to-effort ratio of anything in this audit.

**Q: What's a risk in this repo you'd explicitly *not* spend time fixing right now, and why?**
The unconfigured HTTP connection pooling. It's real and worth naming, but at current scale (one worker, one scan at a time, a 5,000-variant guardrail) the default behavior is very likely fine — spending effort tuning a pool size with no evidence it's actually a bottleneck would be optimizing without a signal.

## See also

- `01-network-map.md` — the full hop chain each finding above sits on
- `04-tls-and-trust-establishment.md` — why the delegated HMAC/session-token verification is a strength, not listed as a risk here
- `07-timeouts-retries-pooling-and-backpressure.md` — the full mechanism finding #1 and #3 are drawn from
- `study-security` (separate guide) — the token-at-rest-encryption question raised in `DEPLOY.md`
- `study-database-systems` / `study-distributed-systems` (separate guides) — the `enqueueScan()` TOCTOU race
