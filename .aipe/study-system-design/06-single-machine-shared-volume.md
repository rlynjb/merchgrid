# 06 — Single-machine shared-volume deploy

**Sidecar-process co-location / shared-nothing-avoided-on-purpose deploy topology.** Project-specific (Fly.io single-machine + single SQLite volume).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Deploy layer ────────────────────────────────────────────────┐
│  ONE Fly machine     ★ THIS CONCEPT ★  ← we are here            │
│  ┌─ start-production.js (supervisor) ─────────────────────────┐│
│  │  child: web (remix-serve)     child: worker (node worker.js)││
│  └───────────────┬─────────────────────────┬────────────────────┘│
│                   │                          │                     │
│                   └──────── same /data volume, one SQLite file ────┘
└────────────────────────────────────────────────────────────────┘
```

Everything in `01`, `02`, and `05` assumed a shared SQLite file both processes can read and write. This is the deploy decision that makes that assumption true: web and worker aren't two services calling each other over the network — they're two sibling processes on the same machine, sharing the same filesystem.

## Structure pass

**Axis: dependency — what does each process need to exist that the other doesn't provide?** Neither the web process nor the worker process depends on the other being *reachable* over a network — there's no HTTP call, no RPC, between them. Both depend on the same volume being *mounted*, which only one machine can do at a time for a Fly volume. That's the constraint the whole topology is built around.

**Seam:** the `[mounts]` block in `fly.toml` and the deliberate *absence* of a `[processes]` block are the same seam, stated twice. Fly's `[processes]` block is the normal way to run "one machine per named process" (e.g. `web` and `worker` as separate scalable machines) — and this repo explicitly does not use it, because separate machines can't share one volume.

```
The seam — why there's no [processes] block

axis traced = "which processes can touch /data?"

┌─ if [processes] used ──┐  seam: Fly volume mount   ┌─ reality: one machine ─┐
│ web machine, worker        │ ═══════════╪═══════════► │ both processes share    │
│ machine — SEPARATE          │ (would need 2 volumes,  │ ONE mount, ONE SQLite   │
│ → can't share 1 volume       │  i.e. 2 databases)      │ file, guaranteed         │
└──────────────────────────────┘                          └──────────────────────────┘
```

## How it works

Think of it like running a build script and a watcher in the same terminal tab instead of two separate machines — they share the same filesystem by construction, so there's no sync problem to solve. This repo does that at the deploy layer: instead of standing up a database service and pointing two independently-deployed processes at it over the network, it puts one SQLite file on one disk and runs both processes next to it.

### The kernel — isolate it

```
Deploy topology kernel

  fly.toml: [mounts] one volume "data" → /data, no [processes] block
       │
  start-production.js: migrate() THEN spawn(web) + spawn(worker)
       │
  supervision contract: either child dies → kill the other → exit non-zero
       │
  Fly restarts the WHOLE machine on non-zero exit → migrate reruns, both
  processes come back together
```

**What breaks if you added a `[processes]` block here** (the most tempting "obvious" improvement): Fly would schedule `web` and `worker` as independently-placed machines. Neither could reliably mount the one `data` volume Fly provisions (a Fly volume attaches to exactly one machine at a time) — you'd need two volumes, i.e. two separate SQLite files, and the worker writing findings to its own file that the web process's file never sees. The single-SQLite-writer design this whole system depends on (see `01`, `02`) would break silently, not loudly.

### Migrations run in the entrypoint, not a Fly `release_command`

```js
// start-production.js:61-65
async function migrate() {
  console.log("[supervisor] running `prisma migrate deploy`");
  await run(bin("prisma"), ["migrate", "deploy"]);
  console.log("[supervisor] migrations applied");
}
```

Fly's normal pattern is a `release_command` that runs once, in a separate ephemeral machine, before the real deploy rolls out. This repo can't use that: a `release_command` machine has no volume attached (Fly doesn't mount volumes for release machines), so any migration it ran wouldn't persist anywhere real. Running `migrate` as the first step inside `start-production.js`, on the one machine that actually has `/data` mounted, is the only place a migration can durably land.

**What breaks if migrations ran as a Fly `release_command` instead:** the migration would apply to nothing — no volume attached — and the actual running machine would start against an unmigrated schema, likely crashing on the first Prisma query that touches a column that migration was supposed to add.

### The supervisor's all-or-nothing child contract

```js
// start-production.js:105-122
function onChildExit(name, code, signal) {
  if (!shuttingDown) {
    shuttingDown = true;
    exitCode = 1;
    console.error(`[supervisor] ${name} exited unexpectedly ...`);
    stopAll("SIGTERM");
  }
  pendingExits -= 1;
  if (pendingExits === 0) process.exit(exitCode);
}
```

If `web` crashes, `worker` gets killed too, and vice versa — the whole process exits non-zero, and Fly restarts the *machine* (not just the crashed child). The doc comment names why this beats trying to restart just the failed child in place:

```js
// start-production.js:26-31
// Silently restarting just one of the two child processes in place would
// risk them drifting (e.g. worker stuck on a bad Prisma client version)
// without ever surfacing as a Fly-visible restart/alert.
```

**What breaks with a "just restart the crashed one" supervisor instead:** the web process could keep running against, say, a Prisma client that's been silently regenerated by a half-applied migration retry from the worker's restart, while the worker runs a different in-memory version — a drift bug that wouldn't show up as any Fly-visible alert, because from Fly's perspective the machine never restarted.

### Always-on, never auto-stopped

```
// fly.toml:35-43
[http_service]
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
```

Fly's default cost-saving behavior — auto-stopping a machine with no inbound traffic — is explicitly disabled here. The comment states why: "the worker must keep running to drain the scan queue even with no inbound HTTP traffic, so the machine can never be auto-stopped." A machine that scales to zero on idle would also stop draining the scan queue on idle, which is exactly the opposite of what a background worker needs.

## Move 2.5 — current state vs. future state

```
Phase A (today)                        Phase B (if this needed real scale)
──────────────────────────────           ──────────────────────────────────
one machine, one SQLite volume            Postgres (network-attached, not
web + worker as sibling processes          volume-attached) + separate web/
migrations run in the entrypoint           worker machines via [processes]
                                            migrations become a real release_command

  what would have to change FIRST: the datastore itself (SQLite → Postgres).
  Splitting [processes] before that migration would just break the shared-
  volume assumption this whole deploy leans on — see 01's scale-bottleneck
  discussion for the same conclusion from the queue side.
```

## Move 3 — the principle

Co-locating two processes on one machine is a legitimate architecture choice, not just "the simple thing before you know better" — it's correct exactly as long as the thing they need to share (here, a SQLite file) can only exist in one place at a time. The moment that stops being true (a datastore that supports concurrent writers from multiple machines), co-location stops being required, but this repo hasn't made that datastore change, so splitting the processes today would be premature and would actively break correctness, not just be unnecessary.

## Primary diagram

```
Full recap — one Fly machine, two children, one volume

┌─ Fly machine (always-on, min_machines_running=1) ──────────────────┐
│                                                                        │
│  start-production.js                                                  │
│    1. migrate() — prisma migrate deploy against /data                │
│    2. spawn web (remix-serve)      spawn worker (node worker.js)      │
│         │                                │                             │
│         │        BOTH read/write         │                             │
│         └──────────► /data/prod.sqlite ◄─┘                             │
│                                                                        │
│  either child exits ──► kill the other ──► process.exit(1)            │
│                              │                                        │
│                    Fly restarts the WHOLE machine                     │
│                    (migrate reruns, both processes come back together)│
└────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same tradeoff a "monolith vs. microservices" discussion always comes down to, just visible at the infrastructure layer instead of the code layer: one deployable unit is operationally simpler (one machine to monitor, one log stream, one health check, no network hop between web and worker) at the cost of not being able to scale the two halves independently. For a single-tenant-audit-tool workload with modest, bursty scan volume, that's the right trade — the alternative (Postgres + independently-scaled web/worker machines) buys elastic worker scaling this app doesn't need yet, at the cost of a real infrastructure migration and a new network boundary between web and worker that doesn't exist today.

`not yet exercised`: horizontal scaling of either process independently; any multi-region topology (one `primary_region`, no read replicas, no geo-distributed Fly machines); Litestream or any continuous backup/replication of the SQLite file (deliberately skipped, per context.md, because scan data is regenerable).

## Interview defense

**Q: Why not run web and worker as separate Fly machines for independent scaling?**
A: Because they'd need independent volumes — Fly volumes attach to one machine at a time — and this app has exactly one SQLite file both processes must read and write. Splitting the machines would mean splitting the data, which breaks the whole "worker writes, web reads, same file" contract every other pattern in this guide depends on.

**Q: Why run migrations in the entrypoint instead of Fly's `release_command`?**
A: A `release_command` runs on an ephemeral machine with no volume attached — a migration run there wouldn't persist. Migrations only make sense on the one machine that actually has `/data` mounted, so they run as the first step of `start-production.js`, before either child process starts.

**Q: What's the failure-handling choice most people would get wrong here?**
A: Restarting only the crashed child instead of the whole machine. The supervisor deliberately kills the *healthy* sibling too and exits non-zero, so Fly treats it as a full machine restart (visible, alertable) rather than risking the two children silently drifting out of sync with each other.

## See also

- `01-single-worker-db-queue.md` — the reason there's only one worker process, tied to the same single-SQLite-writer constraint this deploy topology enforces.
- `audit.md` → lens 5 (storage choice/durability), lens 7 (scale bottlenecks and evolution).
