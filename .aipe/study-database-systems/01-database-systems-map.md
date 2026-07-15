# Database systems map

### Embedded database engine (industry standard: SQLite) — Project-specific: `app/prisma/schema.prisma`

## Zoom out — the bigger picture

Before anything else: where does "the database" even live in this app? Not on a server you'd SSH into separately — it's a file, sitting on the same machine that runs your code.

```
  Zoom out — where the database engine lives

  ┌─ UI layer ───────────────────────────────────────────────┐
  │  Remix routes (app._index.tsx, app.scans.$id.tsx)         │
  └───────────────────────────┬────────────────────────────────┘
                              │ function call, same process
  ┌─ Service layer ───────────▼──────────────────────────────┐
  │  scan-api.server.ts, runner.server.ts, queue.server.ts     │
  └───────────────────────────┬────────────────────────────────┘
                              │ prisma.* calls
  ┌─ ORM / query engine ──────▼──────────────────────────────┐
  │  ★ THIS FILE: PrismaClient + Prisma's Rust query engine ★  │ ← we are here
  └───────────────────────────┬────────────────────────────────┘
                              │ in-process library call, NOT a network hop
  ┌─ Storage layer ───────────▼──────────────────────────────┐
  │  SQLite: /data/prod.sqlite on one Fly volume               │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

The industry term is an **embedded database engine** — a database that runs as a library *inside* your application process, reading and writing a single file, with no server to connect to over a socket. SQLite is the canonical example, and it's what this repo runs (`provider = "sqlite"`, `app/prisma/schema.prisma:11-14`). Contrast that with a **client-server RDBMS** (Postgres, MySQL) where the database is a separate long-running process your app talks to over TCP, potentially on a different machine entirely.

That distinction — embedded vs. client-server — is the single most consequential fact about this codebase's data layer. Almost everything in this guide (locking model, no connection pool, no replication, migrate-on-boot) traces back to "the database is a file next to your code," not "the database is a server you dial into."

## The structure pass

**Axis: where does a query physically travel before it returns data?** Trace it across the layers, then find where the answer changes.

```
  One axis — "how far does a query travel?" — traced down the stack

  ┌─────────────────────────────────┐
  │ Remix route handler             │  in-process function call
  └─────────────────────────────────┘
        │
  ┌─────▼───────────────────────────┐
  │ service function (prisma.scan.*)│  in-process function call
  └─────────────────────────────────┘
        │
  ┌─────▼───────────────────────────┐
  │ Prisma query engine              │  in-process — generates SQL,
  │                                   │  talks to SQLite via its C API,
  │                                   │  NOT a socket write
  └─────────────────────────────────┘
        │
  ┌─────▼───────────────────────────┐
  │ SQLite B-tree pages on disk      │  a filesystem read/write on
  │                                   │  the SAME machine
  └───────────────────────────────────┘

  the answer never flips to "network hop" — that's the whole point
  of an embedded engine, and the seam that matters is one level up:
  web process vs. worker process, both embedding their OWN copy of
  this same stack against the SAME file.
```

**The seam that's actually load-bearing here isn't inside this stack — it's beside it.** `fly.toml:1-8` and `start-production.js` run web and worker as two separate OS processes on one machine, each opening its own `PrismaClient` (each gets its own embedded SQLite connection), both pointed at `/data/prod.sqlite`. That's the seam to watch: two independent embedders of the same engine, sharing one file, with no network protocol between them to arbitrate access — the operating system's file-locking primitives do that job instead. Every later concept (locking in `06`, durability in `07`) is downstream of this one design decision.

## How it works

### Move 1 — the mental model

You've called a `fetch()` before and known there's a server on the other end that could be down, slow, or on a different continent. An embedded engine breaks that assumption entirely: there's no "other end." The "server" is a library linked into your process, and the "network" is a `read()`/`write()` syscall against a local file.

```
  Pattern — client-server RDBMS vs. embedded engine

  CLIENT-SERVER (Postgres/MySQL)          EMBEDDED (this repo: SQLite)

  ┌──────────┐   TCP    ┌──────────┐      ┌──────────────────────────┐
  │ your app │ ───────► │ db server│      │ your app process         │
  │ process  │ ◄─────── │ process  │      │  ┌──────────────────┐    │
  └──────────┘          └────┬─────┘      │  │ SQLite (library) │    │
                              │            │  └────────┬─────────┘    │
                        ┌─────▼─────┐      └───────────┼──────────────┘
                        │  disk     │                  │
                        └───────────┘            ┌─────▼─────┐
                                                    │  disk     │
   connection pool matters                          └───────────┘
   (many app processes,                       no connection pool —
   few DB connections)                        no connection to pool at all
```

### Move 2 — the parts, walked one at a time

**The datasource declaration.** Prisma's schema is where the engine choice is made — a one-line decision with system-wide consequences.

```prisma
// app/prisma/schema.prisma:11-14
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

This single `provider` string is why there's no connection-pool config anywhere in this repo (there's nothing to pool — see `db.server.ts` below), why migrations run with `prisma migrate deploy` on the same machine that owns the file (`start-production.js:61-65`), and why `app/fly.toml` mounts a *volume* rather than pointing at a managed database endpoint.

**The client singleton — one embedder per process, not per request.** Node dev servers hot-reload modules, and creating a fresh `PrismaClient` on every reload would leak connections/handles to the SQLite file. The singleton pattern avoids that:

```ts
// app/app/db.server.ts:1-15
import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();   // one embedder, cached on `global`
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
```

Notice what's *absent* here compared to a Postgres setup: no `connection_limit`, no pool size, no idle-timeout config. Against a client-server database you'd tune a pool because opening a TCP connection is expensive and the server has a finite connection budget. Against SQLite, `new PrismaClient()` just opens the local file — there's no server-side connection budget to protect.

**Two embedders, one file.** The web process and the worker process each run this exact module and each get their own `PrismaClient`/engine instance, but both ultimately open the *same* `/data/prod.sqlite` path (`app/fly.toml:26`, comment at `app/fly.toml:1-8` explaining why web+worker must share one machine to share the volume). This is the seam named in the structure pass above, and it's the reason `06` (locking) and `07` (durability) matter as much as they do for a "small" SQLite app — you don't get to assume single-writer just because the data model is simple.

```
  Layers-and-hops — two processes, one embedded file, no network hop between them

  ┌─ Fly machine (one, always-on) ─────────────────────────────────┐
  │                                                                    │
  │  ┌─ web process ──────────┐      ┌─ worker process ──────────┐  │
  │  │ remix-serve             │      │ node build/worker.js       │  │
  │  │  PrismaClient (own)     │      │  PrismaClient (own)        │  │
  │  └───────────┬─────────────┘      └───────────┬─────────────────┘  │
  │              │ file read/write            file read/write │       │
  │              └───────────────┬────────────────┘                    │
  │                              ▼                                     │
  │                    /data/prod.sqlite (one file)                    │
  │                    on the mounted Fly volume "data"                │
  └──────────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

An embedded database engine trades "a server to manage, tune, and pool connections against" for "a file whose consistency is now entirely the OS's file-locking problem." That trade is a genuinely good one at this app's scale (per-shop scan data, low write volume, one machine) — and it silently stops being a good trade the moment you need two writer machines, which is exactly the moment `08` (replication) and the "not yet exercised" callouts throughout this guide become non-optional reading.

## Primary diagram

```
  The full map — request to disk, both processes, one file

  ┌─ UI ──────────────────────────────────────────────────────────┐
  │ Remix route (loader/action)                                     │
  └───────────────────────────┬────────────────────────────────────┘
                              │ same-process call
  ┌─ Service ───────────────── ▼────────────────────────────────────┐
  │ scan-api.server.ts / runner.server.ts / queue.server.ts          │
  └───────────────────────────┬────────────────────────────────────┘
                              │ prisma.model.method()
  ┌─ ORM ─────────────────────▼────────────────────────────────────┐
  │ PrismaClient (db.server.ts singleton) → Prisma query engine      │
  └───────────────────────────┬────────────────────────────────────┘
                              │ SQLite C API — in-process, no socket
  ┌─ Storage (Fly volume) ─────▼────────────────────────────────────┐
  │ /data/prod.sqlite — read by web AND worker processes             │
  │ journal_mode=delete (verified), page_size=4096, 45 pages total   │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

SQLite is the most-deployed database engine in the world by unit count (every phone, every browser, most desktop apps embed it) precisely because "no server to run" is a massive operational simplification — no connection string to a remote host, no separate process to keep alive, no network partition between app and data. Fly.io's own docs lean into this pattern for exactly this kind of app: single machine, volume-backed SQLite, migrate-on-boot. The tradeoff Fly and this repo both accept: you get exactly one writer machine, ever, unless you introduce a replication layer (Litestream, LiteFS, rqlite) on top — which this repo's `DEPLOY.md` names explicitly as a deliberately-skipped hardening step (see `07` and `08`).

The next three files zoom into what "the file" actually looks like on disk (`02`), how lookups against it are made fast (`03`), and how the query engine decides to use those indexes or not (`04`).

## Interview defense

**Q: "Why would you choose SQLite for a multi-tenant SaaS backend instead of Postgres?"**
A: Because the access pattern here is low-volume, mostly-owned-by-one-process reads/writes per shop, and the operational win of "no database server to run, patch, or pool connections against" outweighs the ceiling SQLite imposes. The ceiling is real — one writer machine — and this repo hits it deliberately (`fly.toml`'s comment block names it: no `[processes]` block because two machines can't share one volume).

```
  the tradeoff, stated plainly

  SQLite:    zero ops overhead   →  ceiling: one writer, one machine
  Postgres:  a server to run     →  ceiling: raised, but now you own the server
```

**Q: "What's the actual mechanical difference between an embedded engine and a client-server one?"**
A: Whether a query crosses a network boundary. Postgres/MySQL: your app is a client, the database is a server, TCP in between — which is why connection pools exist. SQLite: the engine is a library statically/dynamically linked into your process; a "query" is a function call into that library that reads/writes a local file. `app/app/db.server.ts:1-15`'s complete absence of pool configuration is the tell.

## See also

- `02-records-pages-and-storage-layout.md` — what's actually inside that file.
- `06-locks-mvcc-and-concurrency-control.md` — the consequence of two processes embedding one file.
- `study-system-design` — the decision of *which* datastore to run at all, and what growing past SQLite looks like.
