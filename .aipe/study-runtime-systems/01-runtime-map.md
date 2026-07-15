# The runtime map

### Process, task, and resource inventory — Project-specific (applied on top of Node.js's standard runtime model)

## Zoom out, then zoom in

Before any mechanism, you need the inventory: what's actually running, where, and what it touches. Here's the whole deployed system as one picture.

```
Zoom out — where MerchGrid's runtime lives

┌─ Fly.io machine (one, always-on, region "iad") ─────────────────────┐
│                                                                       │
│  ┌─ Container (node:22-alpine) ──────────────────────────────────┐  │
│  │                                                                  │  │
│  │   ★ THIS FILE: the process/task/resource inventory ★            │  │
│  │                                                                  │  │
│  │   supervisor (start-production.js)                              │  │
│  │     ├── web process   (remix-serve)      ← HTTP :3000           │  │
│  │     └── worker process (build/worker.js) ← polls scan queue     │  │
│  │                                                                  │  │
│  └──────────────────────────┬───────────────────────────────────────┘  │
│                              │ reads/writes                            │
│  ┌─ Fly volume "data" ───────▼─────────────────────────────────────┐  │
│  │  /data/prod.sqlite  (one file, one writer story)                 │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Zoom in: this file is the inventory pass — what OS processes exist, what each owns, and what "a unit of work" (a task) means in each one. Everything downstream in this guide (event loop mechanics, synchronization, memory, bounded work) refers back to this map instead of re-deriving it.

## Structure pass

**Layers, this repo's version:** supervisor process → child processes (web, worker) → shared storage (SQLite file). Three levels, and the interesting question is who's in control at each one.

**Axis: control — who decides what runs next?**

```
One axis traced across three levels

  supervisor       → Fly's machine supervisor decides IF the container
  (start-          runs at all; start-production.js decides WHICH two
  production.js)    children exist and reacts to their exit codes
        │
        ▼
  web / worker     → each process's OWN event loop decides task order;
  (two Node         the supervisor has no visibility into what's
  processes)         queued inside either one
        │
        ▼
  SQLite file      → the SQLite engine (not either Node process) decides
                     lock ordering when both processes touch the file
```

The axis flips twice: outside the container, Fly decides whether the machine exists; inside it, the supervisor decides which children exist and treats "child died" as fatal for the whole machine (`app/start-production.js:105-122`); inside each child, that process's own single-threaded event loop is in sole control of task ordering — the other process, and the supervisor, have zero say in it.

**Seam:** the boundary between "supervisor manages processes" and "SQLite manages the file" is where an axis flips from *process-level control* to *storage-engine-level control* — that's why file 04 (shared state) and file 06 (resource lifecycle) both have to reason about SQLite's own locking rather than anything either Node process does.

## How it works

### Move 1 — the mental model

You already know the shape from any time you've run a frontend dev server alongside a backend API in two terminal tabs — two independent processes, no shared memory, coordinating only through something external (a port, a file, a socket). MerchGrid is that, formalized into one supervisor script instead of two terminal tabs, because in production nobody's there to notice if one tab silently died.

```
Pattern — supervisor + sibling children, single shared resource

           ┌───────────────┐
           │  supervisor    │  spawns both, watches exit codes
           └───────┬────────┘
              ┌─────┴─────┐
              ▼           ▼
        ┌──────────┐ ┌──────────┐
        │   web    │ │  worker  │   ← siblings, NOT parent/child
        └────┬─────┘ └────┬─────┘      of each other
             │             │
             └──────┬──────┘
                     ▼
            ┌─────────────────┐
            │  SQLite file     │   ← the only thing they share
            └─────────────────┘
```

### Move 2 — the inventory, part by part

**The supervisor process — `app/start-production.js`.** This is the container's entrypoint (`Dockerfile`'s `CMD ["npm", "run", "start:production"]`). Its whole job: run migrations once, then keep two children alive together or not at all.

```javascript
// app/start-production.js:84-87
const children = {
  web: spawnChild("web", bin("remix-serve"), ["./build/server/index.js"]),
  worker: spawnChild("worker", process.execPath, ["build/worker.js"]),
};
```
`spawnChild` (`start-production.js:67-74`) wraps `child_process.spawn` with `stdio: "inherit"` — the children's stdout/stderr become the supervisor's, which is why `fly logs` shows both processes without extra plumbing. Two independent OS processes, each getting its own V8 instance, its own heap, its own event loop — nothing here is shared memory.

**The web process — `remix-serve`.** Serves the Remix app: Shopify-embedded admin UI, resource routes (`api.scans*.tsx`), webhooks, and `/healthz`. One event loop handling every concurrent HTTP request — no per-request thread, no per-request process.

**The worker process — `app/worker.ts`, compiled to `build/worker.js`.** A standalone script with no HTTP server at all — just a `while` loop (`worker.ts:69-89`) that polls the `Scan` table for QUEUED work. Its only inbound "protocol" is the database row it reads, not a request.

**The task, in each process, is "one iteration of async work."** In the web process a task is one loader/action invocation. In the worker process a task is one call to `claimAndRunNext` (`app/app/services/scan/worker-core.server.ts:30-80`), which claims exactly one scan and runs it to completion or failure. There is no task queue with multiple pending items *inside* the worker process — it's serial by construction: claim one, run it, then either loop immediately (more work) or sleep 5 seconds (`worker.ts:82-88`).

**The shared resource — one SQLite file.** `app/fly.toml`'s `[mounts]` block attaches a single Fly volume at `/data`; `DATABASE_URL = "file:/data/prod.sqlite"` in the same file points both processes at the identical file path. This is the one piece of state that crosses the process boundary, and it's why `fly.toml`'s comment (lines 1-9) explicitly bans adding a `[processes]` block — that would let Fly schedule web and worker onto *separate* machines, and two machines can't mount the same volume.

### Move 3 — the principle

The map here is deliberately flat: two processes, one shared file, no threads, no message broker. That's not an MVP shortcut waiting to be "fixed" — for a single-writer SQLite database, adding more processes or threads doesn't buy you more throughput, because the bottleneck is the one file, not CPU. The runtime topology should match where your actual bottleneck lives; scaling out compute you don't need just adds coordination cost for free.

## Primary diagram

```
The full runtime map, one frame

┌─ Fly machine ────────────────────────────────────────────────────────┐
│                                                                          │
│  start-production.js (supervisor)                                      │
│    1. `prisma migrate deploy` — blocking, must succeed first           │
│    2. spawn(web), spawn(worker) — siblings, stdio inherited             │
│    3. on ANY child exit → stop the other → process.exit(nonzero)       │
│                                                                          │
│  ┌─ web (remix-serve) ────────┐    ┌─ worker (build/worker.js) ──────┐ │
│  │ event loop: 1 per HTTP req  │    │ event loop: while(!shuttingDown)│ │
│  │ routes/, api.scans*.tsx     │    │  claimAndRunNext() → sleep(5s)  │ │
│  │ webhooks, /healthz          │    │  → runScan() pipeline            │ │
│  └──────────────┬──────────────┘    └──────────────┬────────────────┘ │
│                 │        Prisma reads/writes         │                  │
│                 └────────────────┬────────────────────┘                  │
│                                  ▼                                       │
│                    /data/prod.sqlite (Fly volume)                       │
└──────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This "supervisor + siblings sharing one resource" shape is the same idea Unix init systems and `supervisord` formalize at OS scale, and the same idea Docker Compose formalizes at container scale — MerchGrid just needed something small enough to hand-roll in ~140 lines rather than pull in a process manager dependency. The tradeoff being made explicitly: no automatic per-child restart (a died child is fatal for the *whole* machine, by design — see file 07's cancellation walkthrough for why), in exchange for a guarantee that web and worker can never silently drift apart running on incompatible code versions.

Next: file 02 walks how work actually gets scheduled *inside* each of these two processes — the threads-vs-tasks distinction this map only gestures at.

## Interview defense

**Q: "Why two processes instead of one process handling both HTTP and the scan queue?"**
A: Blocking the event loop is the risk — a long GraphQL page fetch (with retries) inside a request handler would stall every other concurrent HTTP request on that same event loop. Two processes give the worker its own event loop that a slow Shopify API can only ever block *itself*, never `/healthz` or the merchant's UI.
```
web event loop:  [req][req][req]...   ← never blocked by scan work
worker event loop: [claim→run scan (slow)]... ← isolated
```
One-line anchor: isolating slow I/O behind its own event loop is cheaper than isolating it behind its own thread.

**Q: "Why not a `[processes]` Fly block, which is the 'normal' way to split web/worker?"**
A: That schedules them onto separate *machines*, and separate machines can't share one Fly volume. Since MerchGrid's whole design is "one SQLite writer," splitting machines would force a bigger rewrite (a real database server) to get shared storage back.
One-line anchor: the storage constraint (single SQLite file) dictated the process topology, not the other way around.

**Q: "What's the actual unit of concurrency here?"**
A: Not a thread, not a process-per-request — it's an `async` task on one event loop per process. Two processes total means two independent event loops, and that's the entire parallelism story.

## See also

- `02-processes-threads-and-tasks.md` — the scheduling mechanics inside each process from this map.
- `04-shared-state-races-and-synchronization.md` — what it costs to have exactly one shared resource (the SQLite file) crossing the process boundary this map draws.
- `study-system-design` — the deployed-architecture view this map's Fly/Docker layer feeds into.
