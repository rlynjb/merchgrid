# Overview — non-functional requirements

MerchGrid: Catalog Audit is a read-only embedded Shopify admin app: one
Remix web process, one background scan worker, one SQLite volume, zero
LLM/AI. This guide audits it against DDIA 2e Ch 2's non-functional
requirements — reliability, scalability, maintainability, plus the
operational NFRs a modern spec has to cover: latency, availability,
security/privacy, observability, and cost.

```
  The whole audit, one page

  ┌─ Merchant's browser ──────────────────────────────────────────┐
  │  embedded admin UI, polls its own loader every 2.5s              │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ session-token JWT (Shopify authn)
  ┌─ Remix web process ──────────▼─────────────────────────────────┐
  │  routes, authz per-shop, API + webhooks + /healthz                │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ shared Scan/Finding rows
  ┌─ Worker process (1, global) ──▼─────────────────────────────────┐
  │  poll loop (5s) → claim → read Shopify → normalize → check →      │
  │  atomic persist                                                     │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ retries + backoff + jitter
  ┌─ Shopify Admin GraphQL API ───▼─────────────────────────────────┐
  │  the one real distributed dependency in this system                │
  └──────────────────────────────────────────────────────────────────┘
                    all of it: one always-on Fly machine,
                    one SQLite volume, no redundancy — a
                    deliberate, named availability/cost tradeoff
```

## NFR verdict table

| Lens | Verdict | One-line why |
|---|---|---|
| 1. Functional requirements | **pass** | Every feature (scan, 10 checks, export, GDPR) is grounded in real code; no drift from the product spec. |
| 2. Reliability | **meets** | Classified retries+backoff (`catalog-reader.server.ts:160-241`), atomic persist (`runner.server.ts:187-207`), poison-pill guard (`worker-core.server.ts:44-75`) — the one open gap (non-atomic queue claim) is named in the code's own comment. |
| 3. Scalability | **meets-partially** | Guardrails (`catalogVariantLimit`, `MAX_PAGE_SIZE`) bound per-scan cost correctly; the single-global-worker ceiling is real, named, and unmeasured against actual load. |
| 4. Maintainability | **meets** | Low change amplification, disciplined migrations with real backfills; two named information leaks (variant→Finding field list, `CATALOG_API_VERSION` triple) — neither urgent. |
| 5. Latency and performance budgets | **not yet exercised** | Three targets written in prose (spec §11.2); zero code checks any of them; no profiler or load test has ever run. |
| 6. Availability, security, privacy | **meets-partially** | Security and privacy both pass cleanly; availability has a deliberate single point of failure (one machine, one volume, no redundancy). |
| 7. Observability and cost | **gap-with-evidence** | No metrics/SLOs/traces anywhere; cost is uninstrumented (~$2–3/mo inferred from Fly pricing, not measured). |
| 8. Red-flags audit | **ranked, 5 findings** | See below — none invented, all traced to real evidence. |

## The three highest-cost NFR gaps

1. **No metrics, SLOs, or traces anywhere.** This is the gap that matters
   most because it blocks *verifying* every other "meets" verdict in this
   table — reliability, scalability, and latency are all currently reasoned
   about by reading code, not by watching a number. The product spec
   already promises this instrumentation (§11.5: scan duration, catalog
   size, failure counts) — it just isn't built yet. → `audit.md` lens 7,
   `.aipe/study-debugging-observability/audit.md`.
2. **The non-atomic single-worker queue claim** (`worker-core.server.ts:22-42`)
   is simultaneously the #1 reliability risk and the #1 scalability ceiling
   — correct today, the first thing to silently break the moment a second
   worker is added without an atomic conditional update. Independently
   ranked #1 by two sibling guides
   (`.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`,
   `.aipe/study-database-systems/09-database-systems-red-flags-audit.md`).
3. **Availability has a deliberate, single point of failure** — one Fly
   machine, one SQLite volume, fail-together process supervision, no
   redundancy. Accepted and named (`fly.toml`, `DEPLOY.md`), not a
   surprise, but it's the real ceiling on this app's uptime story.

## The single next action worth taking

**Instrument the three numbers the product spec already promises and
nothing else builds yet: scan duration, queue depth, and catalog size
processed** (§11.5). This is the highest-leverage single change because it
turns three "not yet exercised" verdicts (latency, scalability, cost) from
code-reading exercises into measured facts, and it's the same
instrumentation `queue.server.ts`'s own TOCTOU comment names as the trigger
worth watching for ("if this ever becomes a real problem"). Nothing else in
this audit is blocked on anything else — this is the one prerequisite move.

## Read next

- **`audit.md`** — the full 8-lens walk, every verdict grounded in
  `file:line` or config, cross-linked into every sibling guide's mechanics.
- **`01-documented-tradeoff-as-nfr-governance.md`** — the single strongest,
  most repeated NFR pattern in this repo: every accepted gap is named in a
  comment at its exact call site.
- **`02-structural-budgets-without-slos.md`** — how `catalogVariantLimit`,
  `MAX_PAGE_SIZE`, and `POLL_MS` function as informal latency/scalability/cost
  budgets in place of measured SLOs.
- **`03-always-on-single-machine-availability-cost-bundle.md`** — one
  topology decision (`fly.toml`) serving three NFRs (availability ceiling,
  cost floor, reliability mechanism) at once.
- **`04-gdpr-bounded-retention-and-regenerable-durability.md`** — why lax
  backups and strict GDPR deletion are two sides of the same call.
- **`README.md`** — reading order and every sibling deep-walk this guide
  cross-links into.
