# Runtime Systems — MerchGrid: Catalog Audit

## What this guide covers

This is the execution model *inside* the repo — not where components live (`study-system-design`), not how you'd verify runtime behavior deterministically (`study-testing`), but literally: what OS processes exist, what runs on which thread, how the event loop schedules work, who owns which piece of shared state, where memory gets allocated and released, what file/DB handles exist and how they get cleaned up, and what happens when work needs to be bounded or cancelled.

MerchGrid is a small, deliberately un-fancy runtime: one Node 22 process serving Remix requests, one Node 22 process draining a scan queue, both single-threaded, both sharing one SQLite file on one Fly volume. That simplicity is not an accident — it's a chosen tradeoff (see `app/fly.toml`'s comment on why there's no `[processes]` block), and most of what's interesting here is how much correctness this repo squeezes out of "exactly one of everything" rather than reaching for threads, locks, or a distributed queue.

## The repo-grounded map

```
Runtime map — MerchGrid on one Fly.io machine

┌─ Fly machine (single, always-on, primary_region "iad") ─────────────┐
│                                                                       │
│  ┌─ supervisor process ────────────────────────────────────────────┐ │
│  │  start-production.js                                            │ │
│  │  1. `prisma migrate deploy` (blocking, must succeed)             │ │
│  │  2. spawn web + worker as sibling child processes                │ │
│  │  3. either child exits ⇒ kill the other ⇒ exit non-zero          │ │
│  │                                                                   │ │
│  │   ┌─ web process ───────────┐   ┌─ worker process ─────────────┐│ │
│  │   │ remix-serve              │   │ node build/worker.js          ││ │
│  │   │ Remix loaders/actions    │   │ while(!shuttingDown) poll     ││ │
│  │   │ single-threaded event    │   │ single-threaded event loop    ││ │
│  │   │ loop, HTTP on :3000      │   │ claimAndRunNext every 5s       ││ │
│  │   └────────────┬─────────────┘   └───────────────┬───────────────┘│ │
│  │                │                                  │                │ │
│  └────────────────┼──────────────────────────────────┼────────────────┘ │
│                    │         both processes           │                 │
│                    ▼         share ONE file            ▼                 │
│           ┌──────────────────────────────────────────────┐              │
│           │  SQLite file: /data/prod.sqlite (Fly volume)  │              │
│           └──────────────────────────────────────────────┘              │
└───────────────────────────────────────────────────────────────────────┘
```

Two OS processes, zero OS threads spun up by application code, zero worker_threads, zero cluster module. Concurrency inside each process is entirely `async`/`await` on Node's single event loop. The only place this repo reaches for a second unit of parallel execution is a second *process* (via `child_process.spawn`), not a second *thread*.

## Reading order

1. **`01-runtime-map.md`** — the process/thread/task inventory as-built, before any mechanism.
2. **`02-processes-threads-and-tasks.md`** — the supervisor pattern (`start-production.js`), the worker's poll loop, why there's no `worker_threads`/`cluster` here.
3. **`03-event-loop-and-async-io.md`** — how `worker.ts`'s sleep, the retry backoff in `catalog-reader.server.ts`, and Prisma's async calls all sit on the same single-threaded event loop.
4. **`04-shared-state-races-and-synchronization.md`** — the TOCTOU race the code openly documents (`queue.server.ts`), the "single worker means no atomic claim needed" argument (`worker-core.server.ts`), and SQLite's single-writer file lock as the real cross-process synchronization primitive.
5. **`05-memory-stack-heap-gc-and-lifetimes.md`** — the `variantLimit` guardrail, decimal.js heap allocations for money, and the one place findings are pulled fully into memory with no pagination (CSV export).
6. **`06-filesystem-streams-and-resource-lifecycle.md`** — the shared SQLite file, `stdio: "inherit"` fd inheritance, the Prisma client's un-managed lifetime, and the `ScanArtifact` table that exists in the schema but nothing writes to yet.
7. **`07-backpressure-bounded-work-and-cancellation.md`** — every explicit bound in this codebase (variant limit, page size cap, retry cap) plus the two-layer graceful shutdown (`SIGTERM` → supervisor → child → `worker.ts`'s own handler).
8. **`08-runtime-systems-red-flags-audit.md`** — the ranked list: what's genuinely risky, what's accepted debt with a documented reason, and what's fine because of the single-worker/single-machine constraint.

## Ranked findings (headline version — full detail in file 08)

1. **Most consequential:** the worker is a single global serialization point. Every shop's scan, across every merchant using MerchGrid, runs through one `while` loop, one at a time. A large or slow-retrying scan for Shop A delays Shop B's queued scan by exactly its own runtime — there's no per-shop lane.
2. **Documented, accepted risk:** `enqueueScan`'s "is there already an active scan" check and its `create` are not atomic (`app/app/services/scan/queue.server.ts:54-68`) — a TOCTOU race the code itself names and accepts for MVP scale.
3. **Correct *because* of the constraint, not despite it:** `claimAndRunNext`'s `findFirst` claim (`app/app/services/scan/worker-core.server.ts:22-28`) is not an atomic conditional update. That would be a bug with two workers; with exactly one, it's fine, and the comment says so.
4. **Worth watching if it grows:** `getAllFindingsForExport` (`app/app/services/scan/scan-api.server.ts:286-304`) loads every finding for a scan into memory in one query with no cap, unlike `getScanFindings`'s paged reads (`MAX_PAGE_SIZE = 200`).

## Not yet exercised

- **OS threads / `worker_threads`** — every concurrency need here is I/O-bound (network calls to Shopify, SQLite reads/writes), so there's no CPU-bound work pulling the codebase toward a thread pool.
- **`cluster` module / multi-core scaling** — one Fly machine, one web process, by design (shared SQLite volume can't be multi-writer).
- **Explicit locks, mutexes, `Atomics`, `SharedArrayBuffer`** — no shared memory across threads exists to protect.
- **`AbortController`-based cancellation of in-flight I/O** — the worker's shutdown is cooperative (checked between loop iterations), not a hard abort of an in-flight `fetch`/GraphQL call.
- **Streaming file I/O (`fs.createReadStream`/`WriteStream`)** — CSV export builds one string in memory; nothing in this repo streams bytes to/from disk.
- **The `ScanArtifact` table** — defined in `app/prisma/schema.prisma:127-135`, cascade-deleted on shop redaction, but no code path creates or reads one yet.
- **Distributed/queue infrastructure (BullMQ, SQS, Redis Streams)** — the "queue" is a `status` column on the `Scan` table, polled by one process.

## Cross-links

- **`study-system-design`** — where the web/worker split sits in the deployed architecture, and the Shopify OAuth/webhook boundaries this runtime serves.
- **`study-testing`** — how `worker-core.server.ts` is kept env-free and unit-testable specifically so the process-loop concerns in this guide don't block test coverage.
- **`study-database-systems`** — SQLite's own concurrency model (WAL mode, single-writer semantics) that underlies file 04's synchronization story.
