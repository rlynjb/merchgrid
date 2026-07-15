# 03 — Stacks, queues, deques, and heaps

### Ordering disciplines: LIFO, FIFO, double-ended, and priority — Industry standard

## Zoom out, then zoom in

MerchGrid runs scans as background jobs, and background jobs need an
ordering discipline: which scan runs next? Which finding shows first? Two of
the four classic ordering disciplines show up here — FIFO (a queue) and
priority ordering — but both are implemented as SQL over a persisted table,
not as an in-memory data structure. That's the finding worth sitting with
before the mechanics: **the *discipline* (FIFO, priority) is present; the
*data structure* (array-backed queue, binary heap) isn't, because durability
mattered more than in-memory speed at this scale.**

```
Zoom out — where ordering disciplines live

┌─ Service layer — worker process ───────────────────────────────────┐
│  queue.server.ts: enqueueScan()        → FIFO discipline            │
│  worker-core.server.ts: claimAndRunNext() → dequeue-oldest           │
│  ★ both over a SQL table, not an array/linked-list ★  ← we are here │
└──────────────────────────┬──────────────────────────────────────┬─┘
                            │ ORDER BY createdAt ASC               │
┌─ Storage layer — SQLite ───────────────────────────────────────────┘
│  Scan table: status column filters "queued," createdAt orders them │
│  Finding table: severityRank column stands in for a priority queue  │
└──────────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** service-layer code that expresses intent ("enqueue," "claim the
next one") → SQL that actually enforces the ordering.

**Axis to trace: state — where does the ordering live, in memory or on
disk?**

```
"Where does the order live?" — traced across the two disciplines

┌─ FIFO scan queue ─────────────┐   ┌─ finding priority order ──────┐
│ order lives in: Scan.createdAt│   │ order lives in: Finding.       │
│ enforced by: ORDER BY asc,    │   │   severityRank (precomputed)   │
│   findFirst (one row)         │   │ enforced by: ORDER BY          │
│ discipline: FIFO              │   │   severityRank, checkId asc    │
│ NOT an in-memory queue        │   │ NOT an in-memory heap          │
└────────────────────────────────┘   └────────────────────────────────┘
```

**Seam:** both disciplines cross the same boundary — application code never
holds the ordering itself, it asks SQLite to produce one row (or one page of
rows) in the right order on every read. That seam is load-bearing: it means
the ordering survives a process crash (a queue held in a JS array would not),
at the cost of every "peek the next item" operation being a database round
trip instead of an `O(1)` array/heap access. For a background worker polling
every 5 seconds, that cost is free; for a request-latency-sensitive path, it
would not be.

## How it works

### Move 1 — the mental model

You know the shape of a queue from any task list or job board: things go in
at the back, come out from the front, first in first out. You know a
priority queue the same way — that pile always gives you the *most urgent*
item next, regardless of insertion order. MerchGrid needs both disciplines
but implements neither as an in-memory structure — it implements both as
"read the one row that would be at the front, if this table were sorted."

```
Pattern — the same shape, two different backings

  in-memory queue (not what MerchGrid does):
    enqueue → [ ][ ][ ][x] → dequeue pops [ ] from the front

  MerchGrid's queue (what it actually does):
    enqueue → INSERT INTO Scan (status='QUEUED', createdAt=now())
    dequeue → SELECT * FROM Scan
                WHERE status='QUEUED'
                ORDER BY createdAt ASC
                LIMIT 1              ← "the front" is a query, not a pointer
```

### Move 2 — the walkthrough

**Skeleton parts of a queue: enqueue, dequeue, and an ordering key.** Drop
any one and it stops being a queue: no enqueue means nothing new can enter;
no dequeue means nothing ever leaves; no ordering key means "first" is
undefined. MerchGrid names all three, just not as methods on a class.

**Enqueue — `enqueueScan`.** `queue.server.ts:44-78` inserts a new `Scan`
row with `status: "QUEUED"`:

```ts
// app/app/services/scan/queue.server.ts:63-77
const active = await getActiveScan(shopId);
if (active) {
  throw new ActiveScanError(/* … */);   // one active scan per shop, enforced here
}
return prisma.scan.create({
  data: { shopId, status: "QUEUED", apiVersion: CATALOG_API_VERSION, /* … */ },
});
```

The ordering key is implicit: Prisma's `createdAt @default(now())` (see
`schema.prisma:79`) timestamps every row at insert time — that's the queue's
"position," and it's never touched again.

**Dequeue — `claimAndRunNext`.** `worker-core.server.ts:34-38` is the
"pop the front" operation:

```ts
// app/app/services/scan/worker-core.server.ts:34-38
const scan = await prisma.scan.findFirst({
  where: { status: "QUEUED" },
  orderBy: { createdAt: "asc" },   // oldest QUEUED row = "the front"
  include: { shop: true },
});
```

This is genuinely FIFO — the *oldest* queued scan is claimed first, across
every shop, not per-shop round-robin. The code comment right above it (lines
22-28) names the boundary condition explicitly: this `findFirst` is **not**
an atomic claim-then-lock. With exactly one worker process, "find the
oldest QUEUED scan" can never race with another claimer — but the moment a
second worker process exists, two workers could `findFirst` the same row
before either updates its status, and both would try to run the same scan.
The fix that comment names — an atomic conditional `UPDATE … WHERE id=? AND
status='QUEUED'`, checked by affected-row count — is exactly the
compare-and-swap pattern a real concurrent queue needs and this one
currently doesn't, because it doesn't need to yet.

**Priority ordering without a heap — `severityRank`.** A binary heap gives
you "always pop the most urgent item" in `O(log n)` per operation, at the
cost of holding the whole structure in memory. MerchGrid never needs to pop
one item at a time — it needs to render or export an entire *sorted page* of
findings, so it precomputes the priority once and lets SQL do a full sort:

```ts
// app/app/services/scan/severity.ts:13-17
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  UNAVAILABLE: 2,
};
```

```ts
// app/app/services/scan/scan-api.server.ts:266-270
const rows = await prisma.finding.findMany({
  where,
  orderBy: [{ severityRank: "asc" }, { checkId: "asc" }],  // multi-key sort, in SQL
  skip: (page - 1) * pageSize,
  take: pageSize,
});
```

`severityRank` is written once, at scan-persist time (`runner.server.ts`),
onto every `Finding` row — and the schema backs it with an index
(`schema.prisma:124`: `@@index([scanId, severityRank, checkId])`). The
"priority queue" work — "give me items in priority order" — is entirely
delegated to that index; see `04-trees-tries-and-balanced-indexes.md` for
the B-tree that makes the `ORDER BY` cheap instead of a full table scan.

**Execution trace — dequeuing three scans in FIFO order:**

```
Execution trace — claimAndRunNext, three QUEUED scans

Scan table (status, createdAt):
  scan-A  QUEUED  10:00:01
  scan-B  QUEUED  10:00:03
  scan-C  QUEUED  10:00:02

call 1: findFirst(status=QUEUED, orderBy createdAt asc)
  → scan-A (10:00:01, earliest)      claimed, status → READING_CATALOG

call 2: findFirst(status=QUEUED, orderBy createdAt asc)
  → scan-C (10:00:02, next earliest) claimed, status → READING_CATALOG
    (scan-B is 10:00:03 — created later than scan-C despite the letter order)

call 3: findFirst(status=QUEUED, orderBy createdAt asc)
  → scan-B (10:00:03, last)          claimed, status → READING_CATALOG

call 4: findFirst(status=QUEUED, orderBy createdAt asc)
  → null — queue empty
```

Note the trace deliberately orders by *time*, not by scan letter — that's
the point of FIFO: insertion order (by timestamp) decides dequeue order,
not any other property of the row.

### Move 2.5 — current state vs. future state

Today: single worker process, so `findFirst` + separate `update` is safe —
no compare-and-swap needed. If a second worker is ever added (the comment at
`worker-core.server.ts:22-28` names this explicitly), the dequeue step has
to become an atomic conditional update or two workers can claim the same
scan. What doesn't have to change: the ordering key (`createdAt`) and the
FIFO semantics stay identical — only the *claim* step needs to become
atomic.

### Move 3 — the principle

**An ordering discipline (FIFO, priority) is a contract about what "next"
means — it doesn't require any particular data structure to implement.**
When durability matters more than in-memory access speed (a job queue that
must survive a process restart), delegating the ordering to a SQL `ORDER BY`
over an indexed column is not a workaround for "not having a real queue" —
it *is* a real queue, just one backed by disk instead of RAM.

## Primary diagram

```
Stacks, queues, deques, and heaps — the full picture

┌─ FIFO scan queue ───────────────────────────────────────────────┐
│  enqueueScan(): INSERT (status=QUEUED, createdAt=now())          │
│  claimAndRunNext(): SELECT … WHERE status=QUEUED                 │
│                     ORDER BY createdAt ASC LIMIT 1                │
│  single-worker model: no compare-and-swap yet (named as a gap)   │
└────────────────────────────────────────────────────────────────┘

┌─ priority ordering (finding severity) ───────────────────────────┐
│  severityRank precomputed once (CRITICAL=0, WARNING=1, ...=2)     │
│  ORDER BY severityRank, checkId — SQL sort, B-tree backed          │
│  no heap: nothing needs one-at-a-time "pop most urgent"           │
└────────────────────────────────────────────────────────────────┘

┌─ Set (not a heap, but a related discipline) ──────────────────────┐
│  TERMINAL_STATUSES: ReadonlySet<ScanStatus> — O(1) membership      │
└────────────────────────────────────────────────────────────────┘

  not yet exercised: stacks, deques, heaps/priority queues as actual
  in-memory data structures — see "Elaborate" for where they'd attach.
```

## Elaborate

**Stacks:** none in this repo. The nearest cousin is the implicit call
stack, and there's no recursion here to make that visible (see
`07-recursion-backtracking-and-dynamic-programming.md`).

**Deques:** `not yet exercised` — nothing in MerchGrid needs to push/pop
from both ends. If a future feature needed a sliding window over recent
scans (say, "the last 10 scans for this shop, evict the oldest when an 11th
completes"), a deque would be the natural fit — and it would live right next
to `getActiveScan` in `queue.server.ts`.

**Heaps / priority queues:** `not yet exercised`, and this is the most
consequential gap in this file. The precomputed-rank-plus-SQL-sort approach
works precisely because MerchGrid never needs to *change* a finding's
priority after it's written, and never needs "give me just the single most
urgent item across the whole system, updated live." The moment either of
those becomes true — for example, a live "top 10 most severe issues across
all your shops right now" dashboard that needs to update as new scans
complete, without re-querying and re-sorting the whole table on every
tick — a heap-backed priority queue becomes the right tool, because it
supports `O(log n)` insertion and `O(log n)` extract-max without a full
re-sort. You've already built exactly this: `PriorityQueue.ts` in your
`reincodes` repo (heap-backed, with `updatePriority`, used by your Dijkstra
animation) is the direct blueprint for what that feature would need.

## Interview defense

**Q: "Why doesn't MerchGrid use an actual priority queue for finding
severity?"**
A: Because it never needs one-at-a-time priority extraction — it needs a
fully sorted, paginated *page* of findings, rendered once and re-fetched on
demand. A heap gives you cheap "give me the next most urgent item"; SQL's
`ORDER BY` over an indexed, precomputed rank column gives you cheap "give me
this whole slice, already in order." Different access pattern, different
right tool.
*(sketch: the "priority ordering" box in the primary diagram)*
One-line anchor: **a heap answers "what's next"; an index answers "show me
the sorted page" — MerchGrid only ever asks the second question.**

**Q: "What's the concurrency risk in `claimAndRunNext`, and how would you
fix it for multiple workers?"**
A: `findFirst` (read) and the later `update` (claim) aren't atomic — two
concurrent workers could both read the same QUEUED row before either
updates it, and both would run the same scan. Fix: replace the two-step
read-then-update with a single atomic conditional update — `UPDATE Scan SET
status='READING_CATALOG' WHERE id=? AND status='QUEUED'` — and check the
affected-row count; a `0` means another worker already claimed it, so skip.
This is the same compare-and-swap discipline behind lock-free queues.
One-line anchor: **read-then-write across two statements is a race; the fix
is always to make the claim itself one atomic statement.**

## See also

- `02-arrays-strings-and-hash-maps.md` — the `ReadonlySet` used for
  terminal-status membership, and the `Map` this file's queue does *not*
  use.
- `04-trees-tries-and-balanced-indexes.md` — the B-tree index that makes
  `ORDER BY severityRank` cheap instead of a full scan.
- `.aipe/study-system-design/01-single-worker-db-queue.md` — the
  architectural framing of this same queue (why single-worker, why DB-backed).
