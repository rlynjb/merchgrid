# Runtime systems red-flags audit

### Ranked execution-model risk assessment — Project-specific (synthesizes files 01-07 into a prioritized list)

## Zoom out, then zoom in

```
Zoom out — this file's place in the guide

┌─ Files 01-07 ────────────────────────────────────────────────────┐
│  runtime map · processes/threads/tasks · event loop · shared state  │
│  memory · resources · bounded work/cancellation                     │
└──────────────────────────┬─────────────────────────────────────────────┘
┌─ This file ─────────────────▼───────────────────────────────────────────┐
│  ★ THE SAME EVIDENCE, RE-SORTED BY CONSEQUENCE ★                        │
│  what's genuinely risky · what's accepted, documented debt ·           │
│  what LOOKS risky but is actually correct given this repo's constraints │
└────────────────────────────────────────────────────────────────────────────┘
```

Every prior file in this guide walked one mechanism at a time. This one steps back and ranks: if you were reviewing this codebase for a scale-up (more merchants, bigger catalogs, more concurrent scans), what would actually bite first — and what's already correctly reasoned-about and doesn't need touching.

## Structure pass

**Layers:** the ranking below cuts across every layer this guide covered (process topology, shared state, memory, bounded work) — the organizing structure here isn't "layer," it's **consequence**: what breaks, how badly, and under what condition.

**Axis: cost — what's the cost of *not* fixing each finding, and who pays it?**

```
  #1 (single global worker)  → cost: EVERY shop's scan latency scales
                               with EVERY OTHER shop's scan latency.
                               Paid by: every merchant, continuously,
                               growing worse as the merchant count grows.

  #2 (enqueue TOCTOU)          → cost: a rare duplicate QUEUED row, wasted
                               (not corrupted) work. Paid by: nobody
                               noticeably, at current traffic.

  #3 (claim non-atomicity)     → cost: ZERO today (impossible with one
                               worker); would become a correctness bug
                               the day a second worker exists.

  #4 (export has no own cap)   → cost: memory growth IF catalogVariantLimit
                               or per-variant finding counts grow a lot.
                               Paid by: nobody today; a future scale bet.
```

**Seam:** the sharpest one in this whole guide is between "risk that's already active today, just small" (findings #2, #4) and "risk that's currently zero but would activate the instant one specific assumption changes" (finding #3). Both deserve tracking, but they're not the same category of problem, and conflating them is how audits become either alarmist or complacent.

## How it works

### Move 1 — the mental model

You've done this triage on your own PRs: "is this a bug, an accepted tradeoff, or a landmine that's currently inert." Same three buckets here, applied to the whole runtime.

```
Pattern — the three buckets every finding sorts into

  ┌───────────────┐  ┌────────────────────┐  ┌───────────────────────┐
  │  ACTIVE RISK   │  │  ACCEPTED, DOCUMENTED│  │  INERT LANDMINE       │
  │  costs paid NOW│  │  small cost, known,   │  │  costs ZERO today,    │
  │  every day      │  │  named tradeoff       │  │  activates on ONE     │
  │                 │  │                        │  │  specific future change│
  └───────────────┘  └────────────────────┘  └───────────────────────┘
```

### Move 2 — the ranked findings, in consequence order

**#1 — ACTIVE RISK, highest consequence: the single worker process is a global serialization point across every shop.**

Evidence: `app/worker.ts:66-92` — one `while` loop, one `await claimAndRunNext(...)` per iteration, no fan-out. `app/app/services/scan/worker-core.server.ts:34-38` — `findFirst` picks the single oldest `QUEUED` scan *across all shops*, not per-shop.

```
Concrete consequence, traced:

  Shop A enqueues a scan on a 4,000-variant catalog that needs 3 retries
  against Shopify's throttling (worst case: several seconds of backoff
  PLUS the actual GraphQL round-trips for ~40 paginated requests).

  Shop B enqueues a scan 1 second later.

  Shop B's scan does not start until Shop A's scan reaches a terminal
  state (COMPLETED or FAILED) — regardless of how fast Shop B's own
  catalog could otherwise be processed.
```

Why it's ranked #1: this is the only finding in this guide whose cost compounds with adoption. Every other finding here is a fixed, small, occasional cost; this one gets *worse* — more merchants means more contention for the same one worker, and there is currently no visibility (metric, alert) into how long the queue's backlog actually is at any given moment. The constructive fix: this doesn't require rearchitecting to a distributed queue — a second worker process on the same machine, each claiming a *disjoint* set of scans (e.g. by `shopId` hash), would already parallelize this, but it requires closing finding #3 first (the claim needs to become atomic before two workers can safely coexist).

**#2 — ACCEPTED, DOCUMENTED: the `enqueueScan` TOCTOU race.**

Evidence: `app/app/services/scan/queue.server.ts:54-68` (walked in full in `04-shared-state-races-and-synchronization.md`). Two concurrent requests for the same shop can both pass the "any active scan?" check and both insert a `QUEUED` row.

Why it's ranked below #1 despite being a genuine race: the code already names the exact mitigating factors (merchant-driven request rate is naturally low-concurrency; the single worker processes duplicates harmlessly, just wastefully) *and* names the exact fix (a partial unique index enforced at the DB level). This is debt that's been consciously prioritized below other work, with the payoff of fixing it clearly understood — the healthiest form a known risk can take.

**#3 — CURRENTLY INERT, activates on one specific change: the non-atomic scan claim.**

Evidence: `app/app/services/scan/worker-core.server.ts:22-38` — `findFirst` with no conditional `UPDATE ... WHERE status = 'QUEUED'` guard.

Why this ranks separately from #2 even though both are "known, documented, unaddressed": #2 has nonzero probability *today*. #3 has *zero* probability today, by construction — there is exactly one caller of `claimAndRunNext` in the whole system (file 01/02's runtime map). It becomes a live, correctness-breaking bug the instant a second worker process is introduced (finding #1's own fix depends on fixing this one first) — worth flagging loudly specifically because "it's fine today" is true and also exactly the kind of fact that's easy to forget when someone later spins up a second worker to address finding #1 without re-reading this comment.

**#4 — CURRENTLY FINE, scale-dependent: `getAllFindingsForExport` has no cap of its own.**

Evidence: `app/app/services/scan/scan-api.server.ts:286-304` (walked in `05-memory-stack-heap-gc-and-lifetimes.md`) — no `take`/`skip`, unlike the paginated `getScanFindings` right next to it.

Why it ranks last: it's bounded transitively by `catalogVariantLimit` today, and the failure mode (memory growth on one export request) is gradual and observable (you'd see it in memory metrics before it caused an outage), not a silent correctness bug like #3. Worth a note-to-self, not urgent action.

**What this audit deliberately does NOT flag as a red flag, and why:**
- **No `worker_threads`/`cluster` usage** — correctly absent; nothing in this codebase is CPU-bound (file 02). Adding either would add complexity for zero throughput gain.
- **No explicit `$disconnect()` on the Prisma client** — correctly absent given both processes are long-lived for their entire process lifetime (file 06). Flagging this as a "leak" would be a false positive.
- **Cooperative (not hard-abort) cancellation in the worker's shutdown** — correctly designed this way; a hard mid-operation abort would risk leaving a `Scan` row stuck at a non-terminal status with no code path to mark it `FAILED` (file 07).

### Move 3 — the principle

A good runtime audit doesn't just list every place a lock or a cap *could* exist — it separates "this compounds with growth and nobody's watching it" from "this is a documented tradeoff with a known fix" from "this is inert until one specific assumption breaks." The single-worker bottleneck (#1) is the one item on this list where doing nothing has a cost that grows every week this app gains merchants; everything else here is either already accounted for or currently free.

## Primary diagram

```
The four findings, ranked by consequence, one frame

  RANK 1 ─ ACTIVE, COMPOUNDING          worker.ts + worker-core.server.ts
  ┌─────────────────────────────────┐   one global queue, one consumer,
  │ single worker serializes ALL     │   cost grows with merchant count
  │ shops' scans                      │
  └─────────────────────────────────┘

  RANK 2 ─ ACCEPTED, DOCUMENTED         queue.server.ts:54-68
  ┌─────────────────────────────────┐   TOCTOU on enqueue; known fix:
  │ duplicate QUEUED rows (rare)     │   partial unique index
  └─────────────────────────────────┘

  RANK 3 ─ INERT, CONDITIONAL           worker-core.server.ts:22-38
  ┌─────────────────────────────────┐   zero risk with 1 worker; MUST fix
  │ non-atomic claim                 │   before adding a 2nd worker
  └─────────────────────────────────┘

  RANK 4 ─ FINE TODAY, WATCH            scan-api.server.ts:286-304
  ┌─────────────────────────────────┐   uncapped export query, bounded
  │ export has no cap of its own     │   transitively today
  └─────────────────────────────────┘
```

## Elaborate

Ranking risk by consequence rather than by "does a comment mention it" is the same discipline a staff-level design review applies to any codebase: not every documented tradeoff is equally urgent, and not every silent gap is equally dangerous. What makes this particular audit tractable is that MerchGrid's own code comments already did most of the analytical work — `queue.server.ts` and `worker-core.server.ts` both explain their own risk and their own fix inline. The value this audit adds is ordering those self-documented risks against each other and against the ones with no comment at all (finding #4), rather than treating every `NOTE:` comment as equally important.

## Interview defense

**Q: "If you had one runtime change to make in this codebase, what would it be?"**
A: Turn `claimAndRunNext`'s claim into an atomic conditional `UPDATE ... WHERE status = 'QUEUED'` (closing finding #3), *then* introduce a second worker process partitioned by shop (closing finding #1). In that order — the second change is unsafe without the first, and #1 is the only finding whose cost grows with adoption rather than staying flat.
One-line anchor: fix the inert landmine before you deliberately step near it.

**Q: "How do you tell the difference between a red flag and an accepted tradeoff?"**
A: Whether the cost is bounded and understood, and whether the code names its own fix. `queue.server.ts`'s TOCTOU comment does both — that's a tradeoff, not a flag. The single-worker bottleneck has an understood cost but it's *unbounded* — it gets worse with scale and nothing currently measures how much worse — that's what makes it the top-ranked finding rather than an accepted cost.

**Q: "What in this audit did you deliberately decide NOT to flag, and why?"**
A: The lack of `worker_threads` and the lack of `prisma.$disconnect()`. Both look like gaps if you're pattern-matching against "what does a mature Node service usually have," but neither applies here — there's no CPU-bound work needing thread offload, and no code path constructs a short-lived Prisma client that would need explicit teardown. Flagging them would be a false positive; naming why they're correctly absent is the actual signal.

## See also

- `01-runtime-map.md` through `07-backpressure-bounded-work-and-cancellation.md` — the full evidence trail behind every finding ranked here.
- `study-system-design` — where a second-worker or distributed-queue redesign (addressing finding #1) would live architecturally.
- `study-testing` — how `worker-core.server.ts`'s env-free, unit-testable design (deliberately separated from `worker.ts`'s thin process loop) is what makes findings #2/#3 easy to verify with a test once a fix lands.
