# The Coordination Map

Distributed system topology / failure domains — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the coordination map sits

  ┌─ UI layer ────────────────────────────────────────────────┐
  │  Polaris + App Bridge, routes/app.scans.$id.tsx (polling)  │
  └───────────────────────┬─────────────────────────────────────┘
                          │ HTTP (same-origin, embedded admin app)
  ┌─ Service layer ───────▼─────────────────────────────────────┐
  │  ★ THE COORDINATION MAP ★  — web process, worker process,   │ ← we are here
  │  the boundary between them, and the boundary to Shopify     │
  └───────────────────────┬─────────────────────────────────────┘
                          │
  ┌─ Storage layer ───────▼─────────────────────────────────────┐
  │  SQLite (Shop, ShopSettings, Scan, Finding, Session)         │
  └───────────────────────────────────────────────────────────────┘
```

Every distributed-systems question in this guide is really one question
asked repeatedly: *when two things that don't share memory need to agree on
what's true, what mechanism makes them agree, and what happens when that
mechanism is slow or wrong?* Before you can answer that for any one
mechanism, you need the map — who the participants are, what crosses the
boundary between them, and which of them die together. That's this file.

## Structure pass — layers, axis, seams

**Layers.** Three participants, not counting Shopify's own infrastructure:
the Remix web process, the worker process (`app/worker.ts`), and the SQLite
file both of them open. A fourth participant sits outside the trust
boundary entirely: the Shopify Admin GraphQL API.

**The axis to trace: control — who decides what happens next?**

```
  One axis, three participants — who decides?

  web process        →  decides WHEN to enqueue (merchant clicks "scan")
  worker process     →  decides WHEN to claim + WHAT to run (poll loop)
  Shopify Admin API  →  decides IF the request succeeds at all (rate limit)
```

The web process's control ends the moment it writes a `QUEUED` row — from
there it can only poll and read, never push. The worker's control ends the
moment it calls `admin.graphql(...)` — from there Shopify decides success,
throttle, or failure, on its own schedule. Control never round-trips
synchronously between any two of these; it's handed off through state
written to a store, which is the whole reason a "queue" needs to exist at
all instead of a direct function call.

**The seam that matters most: the DB row as the only channel.** Web and
worker never call each other directly — no RPC, no shared memory, no
message broker. The `Scan.status` column *is* the entire protocol between
them. That's a load-bearing seam: anyone reasoning about "does the worker
know about this scan yet" has to reason about it purely in terms of what's
committed to that row, not in terms of any synchronous call.

## How it works

### Move 1 — the mental model

You've built a `fetch()` with loading/success/error states before — a
consumer that doesn't control when the data arrives, only how it reacts
once it does. Multiply that by two processes: the web process is the
component holding `loading`, the worker is the async operation, and the
`Scan` row is the promise's eventual settled state, except there's no
`await` connecting them — the web process finds out only by polling.

```
  Pattern: two processes, no shared memory, one shared row

  ┌──────────────┐        write QUEUED        ┌──────────────┐
  │ web process  │ ─────────────────────────► │  Scan row    │
  └──────────────┘                            │ (SQLite)     │
        ▲                                     └──────┬───────┘
        │ poll (read status)                         │ poll (read QUEUED)
        │                                             ▼
        │                                     ┌──────────────┐
        └──── read COMPLETED/FAILED ────────  │ worker proc  │
                                               └──────┬───────┘
                                                      │ GraphQL over HTTPS
                                                      ▼
                                               ┌──────────────┐
                                               │ Shopify API  │
                                               └──────────────┘
```

### Move 2 — the participants, one at a time

**The web process.** Owns the merchant-facing HTTP surface —
`app/app/routes/app._index.tsx` (trigger a scan), `app/app/routes/app.scans.$id.tsx`
(poll for progress/results). It calls `enqueueScan` (`app/app/services/scan/queue.server.ts:44-78`)
and then has no further say in the scan's fate; it can only re-read the row.
And here's where it breaks if you forget this: the web process's job ends
at "row exists with status QUEUED" — it must never assume the scan started,
finished, or even that a worker is alive. `app/app/routes/app.scans.$id.tsx`
handles this correctly by polling `getScanSummary`/`getScanFindings`
(`app/app/services/scan/scan-api.server.ts`) rather than trusting any
in-memory state.

**The worker process.** A `while` loop with no inbound request
(`app/worker.ts:69-91`). It has to manufacture its own authenticated Shopify
client for a shop it never received an HTTP request for —
`unauthenticated.admin(shopDomain)` (`app/worker.ts:19,27-30`), which looks
up the shop's stored offline OAuth token. This is the worker's version of a
service-to-service credential: instead of a bearer token passed on an
inbound call, it's a token it fetches itself from the shared store, keyed
by shop domain.

**The external system.** Shopify's Admin API is the one boundary in this
map that behaves like a genuinely distributed dependency — it's owned by
someone else, it enforces its own rate limits, and it can be slow,
throttled, or briefly unavailable for reasons this repo has zero visibility
into. `app/app/services/shopify/catalog-reader.server.ts` is written
entirely around that assumption (full walkthrough in
`02-partial-failure-timeouts-and-retries.md`).

**The failure domain — what dies together.** This is the map's most
important non-obvious fact:

```
  Layers-and-hops — the failure domain is the WHOLE machine

  ┌─ Fly machine (ONE) ─────────────────────────────────────┐
  │  ┌─ web process ─────┐        ┌─ worker process ──────┐ │
  │  │ remix-serve        │        │ node build/worker.js  │ │
  │  └─────────┬──────────┘        └───────────┬───────────┘ │
  │            │        both mount the SAME     │             │
  │            └────────────► /data volume ◄────┘             │
  │                         (one SQLite file)                 │
  └─────────────────────────────────────────────────────────────┘
       hop: process exit → start-production.js kills the sibling
       and exits non-zero → Fly restarts the WHOLE machine
```

`app/start-production.js:20-31,105-136` is explicit about this: if either
child process exits for any reason, the supervisor kills the other one and
exits non-zero so Fly restarts the entire machine. That's not an accident —
it's the direct consequence of `app/fly.toml:1-8`'s comment that there is
"intentionally no `[processes]` block" because web and worker must share
one volume, and a volume can only be mounted by machines Fly schedules
together. The tradeoff, stated plainly: you get one writer and zero
split-brain risk, at the cost of web and worker going down together even
though only one of them actually broke.

### Move 3 — the principle

A coordination map isn't "list the servers" — it's "trace where control and
state cross a boundary, and name what fails together." In this repo the
crossing is a database row instead of a network call, but the discipline is
identical to a message queue between two Kubernetes deployments: know who
can only read, who can only write, and which failures are correlated versus
independent, before you touch any single mechanism.

## Primary diagram

```
  MerchGrid — full coordination map

  ┌─ Fly machine (single, region=iad) ─────────────────────────────────┐
  │                                                                     │
  │  ┌─ web process ──────────┐         ┌─ worker process ──────────┐ │
  │  │ app/routes/app._index   │         │ app/worker.ts (poll 5s)   │ │
  │  │  → enqueueScan()        │         │  → claimAndRunNext()      │ │
  │  │ app/routes/app.scans.$id│         │  → runScan()              │ │
  │  │  → getScanSummary/      │         │                            │ │
  │  │    getScanFindings      │         │                            │ │
  │  └───────────┬─────────────┘         └────────────┬───────────────┘ │
  │              │  write/read                write/read│               │
  │              └──────────────┬──────────────────────┘                │
  │                             ▼                                       │
  │              ┌─ SQLite (/data, one volume) ─────┐                  │
  │              │  Shop · ShopSettings · Scan       │                  │
  │              │  Finding · Session                │                  │
  │              └────────────────────────────────────┘                  │
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │ GraphQL over HTTPS (real network hop)
                                 ▼
                   ┌─ Shopify Admin API (external) ─┐
                   │  read_products, read_inventory  │
                   └──────────────────────────────────┘
```

## Elaborate

This shape — two co-located processes coordinating through a shared
database rather than a message bus — is common at small-to-medium scale
precisely because it avoids standing up separate queue infrastructure
(Kafka, SQS, Redis Streams) before you need its throughput. The tradeoff you
accept is the one named above: one writer, one failure domain, no
horizontal scale-out without a rewrite of the claim step (see
`06-queues-streams-ordering-and-backpressure.md`). The pattern generalizes
directly to "cron job reads a Postgres table" or "Lambda polls an SQS
queue" — same map, different transport for the hop between producer and
consumer. Read `05-replication-partitioning-and-quorums.md` next for what
changes the moment you outgrow one writer, and
`02-partial-failure-timeouts-and-retries.md` for how the one real network
hop (Shopify) is hardened.

## Interview defense

**Q: "Walk me through how the web and worker processes communicate."**
A: They don't, directly — there's no RPC and no message broker. The `Scan`
row's `status` column is the entire protocol; the web process writes
`QUEUED`, the worker polls for it, and every subsequent state change is
another read/write against that same row.
```
  web ──write──► Scan.status ◄──poll/write── worker
```
One-line anchor: *the database row is the message.*

**Q: "What's the actual failure domain here — what goes down together?"**
A: The whole Fly machine. Web and worker are siblings under one supervisor
(`start-production.js`) sharing one SQLite volume; if either process exits
unexpectedly, the supervisor kills the other and exits non-zero so Fly
restarts everything together. There's no partial-degradation mode where the
worker keeps running while web is down, or vice versa.
```
  child exits ──► supervisor kills sibling ──► machine restarts (both)
```
One-line anchor: *one volume forces one blast radius.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the one real network hop.
- `06-queues-streams-ordering-and-backpressure.md` — the mechanics of the
  shared row acting as a queue.
- `.aipe/study-system-design/` — architectural shape and scale tradeoffs
  (this file owns coordination correctness, not the broader design story).
