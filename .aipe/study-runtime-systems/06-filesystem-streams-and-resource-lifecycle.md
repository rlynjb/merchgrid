# Filesystem, streams, and resource lifecycle

### File descriptors, handles, and cleanup ownership — Industry standard (POSIX resource lifecycle), applied to this repo's process/file boundaries

## Zoom out, then zoom in

```
Zoom out — where resources with a lifecycle exist in this repo

┌─ Process layer ──────────────────────────────────────────────────┐
│  stdout/stderr fds — inherited from supervisor into web + worker   │
└──────────────────────────┬─────────────────────────────────────────┘
┌─ Storage layer ─────────────▼────────────────────────────────────────┐
│  ★ THIS CONCEPT ★                                                     │
│  /data/prod.sqlite — one file, one volume, opened by BOTH processes  │
│  Prisma client — a resource with no explicit close in this codebase  │
│  ScanArtifact table — defined, never written to (not yet exercised)  │
└──────────────────────────────────────────────────────────────────────┘
```

A "resource" here is anything that has an open/acquire step and should have a matching close/release step — a file descriptor, a database connection, a child process handle. This repo has surprisingly few of these to manage explicitly, and the ones it does have mostly rely on process-exit-cleans-everything rather than manual teardown. That's a real design choice worth naming honestly, not a gap to apologize for.

## Structure pass

**Layers:** OS file descriptors (stdout/stderr, the SQLite file) → the Prisma client wrapping that file → the application code calling through Prisma. Three levels; the interesting question is which layer is actually responsible for closing what.

**Axis: lifecycle — when is each resource acquired, and when (if ever) is it explicitly released?**

```
  stdout/stderr fds       → acquired at process spawn (stdio: "inherit"),
                            released automatically when the PROCESS exits
                            — no explicit close anywhere in this codebase

  SQLite file handle       → opened by Prisma's query engine on first use,
  (via Prisma)              released when the PROCESS exits — no
                            `$disconnect()` call exists in this codebase

  ScanArtifact row          → schema exists (cascade-deletes with its
  (planned, unused)          Scan), but nothing ever creates one —
                            not yet exercised
```

**Seam:** every resource in this table shares the same seam — "released on process exit" rather than "released by explicit application code." That's a legitimate strategy (the OS reclaims fds and Prisma's engine process on exit regardless), but it only holds up as long as the process's exit is itself well-behaved — which is exactly what file 07's shutdown-sequencing mechanics have to guarantee.

## How it works

### Move 1 — the mental model

You know this shape from the frontend: a component that opens a `WebSocket` or subscribes to an event in `useEffect` and has to return a cleanup function, or it leaks. Server-side, the same discipline applies to file descriptors and database connections — except here, the "cleanup function" this repo mostly reaches for is "let the process die and let the OS do it," which is a valid choice specifically because these processes are meant to be short-lived-per-deploy, not accumulating open resources over a long uptime.

```
Pattern — resource lifecycle: acquire, use, release (or not)

  ┌───────────┐     ┌───────────┐     ┌────────────────────────┐
  │  acquire   │────►│    use     │────►│  release: explicit OR   │
  │  (open)    │     │  (queries) │     │  implicit (process exit) │
  └───────────┘     └───────────┘     └────────────────────────┘
```

### Move 2 — walking the resources this repo actually has

**Standard fd inheritance — `stdio: "inherit"`, `app/start-production.js:45, 69`.** Both `run()` (used for `prisma migrate deploy`) and `spawnChild()` (used for web and worker) pass `{ stdio: "inherit" }` to `child_process.spawn`. This means the child processes don't get their own separate stdout/stderr pipes that the supervisor would have to read from and forward — they share the *exact same* file descriptors as the supervisor process. That's why `fly logs` shows output from all three (migration, web, worker) without any code in this repo explicitly piping or buffering log lines. **What breaks if this weren't inherited:** you'd need to manually pipe each child's stdout/stderr into the supervisor's own streams (or into a logging library), adding real complexity for zero benefit here, since there's no need to filter or transform the children's output before it reaches Fly's log collector.

**The Prisma client — `app/app/db.server.ts` — a resource with no explicit close anywhere in this codebase.**

```javascript
// app/app/db.server.ts
if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}
const prisma = global.prismaGlobal ?? new PrismaClient();
export default prisma;
```
The dev-mode branch (`global.prismaGlobal`) exists specifically because Remix's Vite dev server hot-reloads modules — without stashing the client on `global`, every HMR reload would construct a *new* `PrismaClient`, and each one opens its own connection to the SQLite file, quickly exhausting file handles during active development. Stashing it on `global` means the same client instance survives across reloads. In production, a fresh `new PrismaClient()` is created once per process (web, worker) and lives for that process's entire lifetime — a grep across this repo turns up **zero calls to `prisma.$disconnect()`** anywhere in application code. **The concrete consequence:** the Prisma client, and whatever connection/engine-process resources it holds, are released only when the Node process itself exits — which is exactly what happens in both processes (`worker.ts`'s `main()` returning after a clean shutdown, or the process dying on `SIGTERM`/an unhandled error). There is no code path in this repo where a `PrismaClient` needs to be constructed and torn down *within* a still-running process's lifetime, so the "acquire once, release on process exit" strategy is complete for this repo's actual usage — it would stop being complete the moment any code needed to spin up a short-lived, throwaway Prisma client mid-process.

**What isn't here yet: streaming file/response I/O.** A grep across `app/` and `packages/` for `fs.createReadStream`, `fs.createWriteStream`, or streaming HTTP responses turns up nothing. The CSV export (`app/app/services/scan/export.server.ts`) is the one place you might expect streaming — a potentially large export written incrementally to the HTTP response as rows are formatted, rather than built as one complete string first. Instead, `buildFindingsCsv` returns a single `string` (file 05 covered why this is fine at current scale), and the calling API route (`api.scans.$id.export`, referenced in `context.md`'s key-flows section) sends that whole string as one `Response` body. **Not yet exercised:** true streaming I/O, backpressure-aware `Writable` streams, or `fs.createReadStream`/`pipe()` anywhere in this codebase.

**What's defined but never created: the `ScanArtifact` table, `app/prisma/schema.prisma:127-135`.**

```prisma
model ScanArtifact {
  id         String   @id @default(cuid())
  scanId     String
  scan       Scan     @relation(fields: [scanId], references: [id], onDelete: Cascade)
  type       String
  storageKey String
  expiresAt  DateTime?
  createdAt  DateTime @default(now())
}
```
This model has a clear resource-lifecycle shape — `storageKey` implies a pointer to something stored elsewhere (a file on disk, an object-storage key), `expiresAt` implies a planned cleanup/expiry mechanism, and `onDelete: Cascade` ties its lifetime to its parent `Scan`'s. `app/app/models/shop.server.ts` mentions it only in a comment about what cascades when a shop is redacted (GDPR compliance) — a grep across the entire application codebase finds no `prisma.scanArtifact.create` or any other code path that ever writes one. **This is a real resource lifecycle designed into the schema, entirely unexercised in the running application** — presumably reserved for a future large-export-to-file or long-lived-artifact feature that hasn't shipped yet.

### Move 3 — the principle

"Release resources on process exit" is a legitimate strategy exactly when a resource's intended lifetime already matches the process's own lifetime — and every resource in this repo does. The discipline isn't "always call `.close()` explicitly"; it's knowing which of those two lifetimes you're actually in, and this repo has consistently landed in "process-scoped," which is why it can get away with never calling `$disconnect()`.

## Primary diagram

```
Resource lifecycle inventory, full picture

┌─ stdout/stderr fds ────────────────────────────────────────────┐
│  acquired: process spawn (stdio:"inherit")                       │
│  released: process exit (OS-level, automatic)                    │
└────────────────────────────────────────────────────────────────────┘

┌─ Prisma client / SQLite handle ─────────────────────────────────────┐
│  acquired: module load (`new PrismaClient()`, or `global.prismaGlobal`) │
│  released: process exit — NO explicit `$disconnect()` in this repo │
└────────────────────────────────────────────────────────────────────────┘

┌─ ScanArtifact (schema only) ────────────────────────────────────────┐
│  acquired: NEVER — no code path creates one                        │
│  released: cascade-delete IF a Scan/Shop is deleted (unreachable    │
│            today since nothing creates the row in the first place) │
└──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The absence of `$disconnect()` calls is worth contrasting with serverless/edge deployments (Lambda, Vercel functions), where a *short-lived* function invocation genuinely does need to open and close a database connection per invocation — a completely different resource lifecycle than this repo's always-on, long-lived process model. If MerchGrid were ever ported to a serverless web tier, this exact pattern (module-scoped, never-disconnected Prisma client) would become the wrong choice, because the process lifetime assumption it relies on would no longer hold. That's the kind of assumption worth writing down explicitly when it's load-bearing, the same way `db.server.ts`'s dev-mode `global.prismaGlobal` branch already documents its own reason for existing.

## Interview defense

**Q: "Why does `db.server.ts` stash the Prisma client on `global` only in non-production?"**
A: Vite's dev-server HMR reloads modules on every file change; without the `global` stash, each reload would construct a brand-new `PrismaClient`, each opening its own connection to the SQLite file, and repeated reloads during a dev session would exhaust file handles. Production doesn't hot-reload modules, so a single `new PrismaClient()` per process is correct there without the `global` workaround.
One-line anchor: the dev-only branch exists to counteract a dev-only problem (HMR), not a production concern.

**Q: "This codebase never calls `prisma.$disconnect()` — is that a leak?"**
A: No — both processes that hold a Prisma client (web, worker) are meant to live exactly as long as the process itself. There's no code path that constructs a short-lived, throwaway client mid-process, so "release on process exit" is a complete strategy here, not a shortcut. It would become a real leak only if some future code path spun up an extra `PrismaClient` instance inside an already-running process without a corresponding disconnect.

**Q: "What's `ScanArtifact` for, and why hasn't it come up anywhere else in this guide?"**
A: It's a schema-defined table (`storageKey`, `expiresAt`, cascade-deleted with its `Scan`) that no application code creates or reads yet — a planned resource for some future artifact-storage feature (likely a large export written to a file/object store rather than returned inline). It's the cleanest `not yet exercised` case in this repo: the shape is already designed, nothing exercises it.

## See also

- `05-memory-stack-heap-gc-and-lifetimes.md` — the CSV string this file's streaming discussion contrasts against, and the same "bounded by an upstream number" reasoning applied to a different resource.
- `01-runtime-map.md` — the shared SQLite file whose lifecycle spans both processes covered here.
- `study-database-systems` — SQLite connection/engine-process internals underneath the Prisma client discussed in this file.
