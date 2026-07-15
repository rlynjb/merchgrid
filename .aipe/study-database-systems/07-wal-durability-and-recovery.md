# WAL, durability, and recovery

### Write-ahead logging / crash recovery (industry standard) — Project-specific: `app/start-production.js`, `app/fly.toml`, `app/DEPLOY.md`

## Zoom out — the bigger picture

`06` established that this repo runs SQLite's default rollback-journal mode, not WAL. This file is about what that journal (whichever kind) is actually *for* — surviving a crash without corrupting the file — and how this repo recovers when the machine itself, not just a transaction, goes down.

```
  Zoom out — where durability and recovery sit

  ┌─ Fly machine boot sequence ──────────────────────────────┐
  │  prisma migrate deploy  →  start web + worker                │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Durability boundary ──────▼──────────────────────────────┐
  │  ★ THIS FILE: journal/WAL, fsync, what "committed" means ★    │ ← we are here
  │  ★ + what happens if the machine or volume is lost ★           │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Recovery ──────────────────▼──────────────────────────────┐
  │  Fly volume snapshots (repo's answer) — no Litestream         │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**Durability** is the promise that once a write is reported as committed, it survives a crash — even a full power loss the instant after commit. Every serious database engine achieves this the same way: write a record of the change to a sequential log *before* touching the main data file, so that after a crash, replaying (or discarding) that log restores a consistent state. SQLite calls its version a **rollback journal** (the mode this repo verifiably runs) or, in its newer mode, a **write-ahead log (WAL)** — this repo uses the former. **Recovery** is the separate, larger question: what happens when the *entire machine* (not just a transaction) is lost — and this repo's answer is Fly volume snapshots, with a name-brand alternative (Litestream) explicitly declined.

## The structure pass

**Axis: at what physical moment does a write actually become crash-proof?** Trace it from "the app called `.update()`" down to "the byte is unrecoverably on disk" — that's the whole durability boundary, and it's a different number of steps in rollback-journal mode vs. WAL mode.

```
  One axis — "when is a write actually safe from a crash?"

  app calls prisma.scan.update(...)
        │
        ▼
  SQLite writes ORIGINAL page content to the ROLLBACK JOURNAL file first
  (this repo's verified mode: journal_mode=delete)
        │
        ▼
  SQLite overwrites the page IN PLACE in the main .sqlite file
        │
        ▼
  fsync — OS confirms bytes are physically on disk, not just in a buffer
        │
        ▼
  journal file DELETED (hence "journal_mode=delete" — the journal's
  own lifecycle IS the mode's name)
        │
        ▼
  ★ write is now durable — survives a crash from this point on ★

  seam: if a crash happens BEFORE the journal is deleted, SQLite's
  recovery step on next open replays the journal to UNDO the
  in-place write, restoring the pre-transaction state — that's what
  "rollback journal" means literally: it's used to roll back, not replay forward.
```

## How it works

### Move 1 — the mental model

You've used `git`'s reflog to recover from a bad `reset --hard` — the reflog kept a record of where `HEAD` used to point, so an "undo" was possible after the fact. A rollback journal is the same idea at the byte level: before SQLite changes a page in the main file, it writes that page's *original* content into the journal, so if anything goes wrong mid-write, the original bytes are recoverable and get put back — hence "rollback."

```
  Pattern — rollback journal vs. write-ahead log, the actual difference

  ROLLBACK JOURNAL (this repo's verified mode)     WAL (available, NOT used here)
  ┌────────────────────────────┐                   ┌────────────────────────────┐
  │ 1. copy OLD page → journal   │                   │ 1. write NEW page → WAL log   │
  │ 2. overwrite page IN PLACE    │                   │ 2. main file untouched         │
  │    in the main .sqlite file   │                   │    until a later "checkpoint"  │
  │ 3. delete journal on commit    │                   │ 3. readers can read the OLD    │
  │                                  │                   │    main file OR the new WAL     │
  │ writer needs an EXCLUSIVE lock │                   │    entries — no exclusive lock  │
  │ on the WHOLE FILE for step 2    │                   │    needed against readers        │
  └────────────────────────────┘                   └────────────────────────────┘
     (this is WHY 06's whole-file                      (this is WHY WAL avoids
      exclusive lock exists — the                       06's reader/writer blocking —
      in-place overwrite needs it)                       readers never touch the log)
```

### Move 2 — walking the durability boundary in this repo

**Verified: this app's durability mechanism is the rollback journal, not WAL.** Restating the fact from `06` because it's exactly as load-bearing here: `PRAGMA journal_mode` on `app/prisma/dev.sqlite` returns `delete` — the default. Nothing in `app/prisma/schema.prisma`, `app/app/db.server.ts`, or the `DATABASE_URL` connection strings in `.env`/`app/fly.toml` sets `journal_mode=WAL`. That means every write in this app pays the in-place-overwrite-plus-journal-file cost described above, and every writer transaction takes the whole-file exclusive lock covered in `06` — durability and the locking model are the same mechanism, viewed from two angles.

**Migrate-on-boot IS this app's crash-recovery gate for schema changes.** `start-production.js` refuses to serve traffic on an unmigrated or partially-migrated database:

```js
// app/start-production.js:61-65, 76-82
async function migrate() {
  console.log("[supervisor] running `prisma migrate deploy`");
  await run(bin("prisma"), ["migrate", "deploy"]);
  console.log("[supervisor] migrations applied");
}

async function main() {
  try {
    await migrate();
  } catch (err) {
    console.error("[supervisor] `prisma migrate deploy` failed; not starting web/worker", err);
    process.exit(1);           // machine never serves traffic against a bad schema
  }
  // ... only now spawn web + worker
```

The comment at the top of the file states the reasoning directly: *"this deploy is one always-on machine with one SQLite database on a Fly volume mounted at /data. ... migrations only make sense to run on this machine (it is the only one with the volume attached)"* (`start-production.js:5-9`). This is the durability boundary made operational: a machine restart (Fly's own recovery from a crash) doesn't just restart the app — it re-runs `migrate deploy` against the *same* file every time, so a half-applied migration (itself protected by SQLite's own journal — migrations run inside SQL transactions with the `PRAGMA defer_foreign_keys`/rebuild dance seen in `02`) either fully lands or the machine refuses to come up at all.

**The supervisor's fail-together design is a recovery decision, not just process management.** If the web process or the worker process exits for any reason, `start-production.js` deliberately kills the other and exits non-zero:

```js
// app/start-production.js:105-116
function onChildExit(name, code, signal) {
  if (!shuttingDown) {
    shuttingDown = true;
    exitCode = 1;
    console.error(
      `[supervisor] ${name} exited unexpectedly ... ` +
        "stopping the other process and exiting non-zero so Fly restarts the machine",
    );
    stopAll("SIGTERM");
  }
  // ...
}
```

That non-zero exit is what triggers Fly to restart the *whole machine* — which re-runs the migrate step above. The comment explains why this matters for correctness, not just uptime: *"Silently restarting just one of the two child processes in place would risk them drifting (e.g. worker stuck on a bad Prisma client version) without ever surfacing as a Fly-visible restart/alert"* (`start-production.js:28-31`). In durability terms: this app defines "recovered" as "both processes and the schema are back in a known-consistent state together," not "something is still running."

**What survives a lost volume: nothing, by design, and the tradeoff is named in writing.** `app/DEPLOY.md`'s own caveats section is explicit:

```
// app/DEPLOY.md — "Known caveats to carry forward"
SQLite-on-a-volume durability is single-node. There's no
replication — if the volume is lost, the data is lost. Fly volumes do
have their own snapshot mechanism, but for real backup/restore
guarantees, consider adding Litestream (continuous SQLite replication
to object storage) as a later hardening step. Not implemented here.
```

And the project's own decision record confirms this was a deliberate call, not an oversight: *"Litestream backups intentionally skipped (data is regenerable; volume has daily snapshots)"* (project context, "Known deferred / follow-ups"). Read literally: recovery from a lost volume today means restoring from whatever Fly's own volume-snapshot retention window still has — a point-in-time snapshot, not continuous replication, so any writes between the last snapshot and the loss are gone. The team's stated justification is that scan/finding data is **regenerable** — a merchant can just re-run a scan — which is the actual reason a data-loss window is an acceptable risk here and wouldn't be for, say, billing records.

```
  Layers-and-hops — recovery from a lost machine vs. a lost volume

  ┌─ Lost machine, volume intact ─────────────────────────────┐
  │  Fly reschedules the machine → re-mounts the SAME volume →   │
  │  start-production.js runs migrate deploy → journal/WAL         │
  │  (whichever mode) replays any in-flight transaction → serves   │
  │  traffic again. FULL recovery, no data loss.                    │
  └────────────────────────────────────────────────────────────┘
  ┌─ Lost volume itself ──────────────────────────────────────┐
  │  restore from Fly's snapshot mechanism (daily, per project     │
  │  context) → any write AFTER that snapshot is GONE →              │
  │  accepted because scan data is regenerable, per DEPLOY.md        │
  │  and the project's own decision record                            │
  └────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

Durability at the transaction level (survive a crash mid-write) and durability at the infrastructure level (survive losing the disk entirely) are two different guarantees, solved by two different mechanisms — a journal/WAL solves the first; replication or continuous backup solves the second. This repo gets the first for free from SQLite's engine and deliberately does not pay for the second, because the specific data at risk (regenerable scan results, not source-of-truth business records) makes that an honest, stated tradeoff rather than a gap nobody noticed.

## Primary diagram

```
  Durability and recovery, this repo, end to end

  ┌─ Transaction-level durability (SQLite's job) ─────────────┐
  │  journal_mode=delete (VERIFIED) → in-place overwrite +        │
  │  rollback journal → fsync → journal deleted → durable          │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Machine-crash recovery (start-production.js's job) ────────┐
  │  any child process dies → BOTH killed → machine exits           │
  │  non-zero → Fly restarts machine → migrate deploy re-runs →       │
  │  web + worker restart together                                     │
  └───────────────────────────┬──────────────────────────────┘
                              │
  ┌─ Volume-loss recovery (Fly + accepted risk) ─────────────────┐
  │  Fly's own daily volume snapshots (per project context) →         │
  │  Litestream (continuous, object-storage) DELIBERATELY SKIPPED     │
  │  → data since last snapshot is lost if the volume itself dies       │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

The rollback-journal-vs-WAL distinction generalizes past SQLite: Postgres's WAL, MySQL's InnoDB redo log, and SQLite's WAL mode are all the "write the change to a sequential log first" strategy — it's specifically SQLite's *rollback* journal (this repo's mode) that inverts the direction (log the *old* value, overwrite in place, delete the log on success) rather than logging the new value and replaying it forward. Both strategies deliver the same durability guarantee through different mechanics, and the mechanic in play is exactly why WAL mode also happens to fix the reader/writer blocking problem from `06` — logging forward means readers never need the writer's in-place-overwrite lock at all.

## Interview defense

**Q: "What actually makes a SQLite write crash-safe, mechanically?"**
A: The rollback journal — before SQLite overwrites a page in the main file, it copies that page's original bytes into a separate journal file and fsyncs it. If the process crashes mid-write, SQLite's next open detects the leftover journal and replays it to restore the pre-transaction state, rather than leaving the file in a half-written, corrupt state.

**Q: "If the Fly machine crashes right now, what's the actual recovery path?"**
A: Fly reschedules the machine, remounts the same volume, and `start-production.js` runs `prisma migrate deploy` before starting anything else (`start-production.js:61-82`) — so even a crash mid-migration is safe, because the migration itself is journal-protected the same way any other write is. If the *volume* is lost (not just the machine), recovery falls back to Fly's own snapshot mechanism, and any write after the last snapshot is gone — an accepted risk because the data is regenerable (a merchant re-runs the scan), documented in `DEPLOY.md` and the project's own decision record.

```
  crashed MACHINE, volume intact  →  full recovery, journal protects in-flight writes
  lost VOLUME itself              →  restore from last snapshot; writes since then: gone
                                       (accepted — data is regenerable)
```

## See also

- `06-locks-mvcc-and-concurrency-control.md` — why the rollback journal's in-place overwrite is what requires the whole-file exclusive lock.
- `08-replication-and-read-consistency.md` — the next question the "single volume, no replication" fact raises.
