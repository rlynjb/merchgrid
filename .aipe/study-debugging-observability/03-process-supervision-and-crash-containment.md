# Process supervision and crash containment

**Supervisor process / one-for-all restart strategy, with per-unit
fault isolation inside** — Language-agnostic pattern (compare
Erlang/OTP supervisors, Kubernetes pod restarts), project-specific
implementation (`start-production.js`, `worker.ts`,
`worker-core.server.ts`).

## Zoom out, then zoom in

Here's the whole machine. One Fly.io container runs two long-lived
processes — the Remix web server and the scan worker — because they
share one SQLite volume and Fly won't let two separate machines mount
the same volume. Something has to decide: when one of these dies, does
the other keep running, or does the whole machine restart? And one
level down, inside the worker's own loop: when *one scan* blows up,
does the whole worker die, or does it just move to the next scan? This
repo answers those two questions differently on purpose, and that
difference is the whole pattern.

```
  Zoom out — where crash containment lives, at two altitudes

  ┌─ Fly machine (one container) ────────────────────────────────────┐
  │  ┌─ start-production.js ★ THIS CONCEPT (outer) ★ ─────────────┐   │
  │  │  spawns web + worker as siblings; ANY exit kills BOTH        │   │
  │  └──────────────┬─────────────────────────┬────────────────────┘   │
  │                 │ web (remix-serve)        │ worker (node)         │
  │  ┌──────────────▼──────────┐  ┌────────────▼────────────────────┐ │
  │  │ Remix web server         │  │ worker.ts poll loop              │ │
  │  │                          │  │ ★ THIS CONCEPT (inner) ★         │ │
  │  │                          │  │ per-iteration try/catch           │ │
  │  └──────────────────────────┘  └───────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────────┘
```

This is the same shape as an app's top-level error boundary versus one
event handler's own `try`/`catch`: the outer boundary fails loud and
lets something bigger recover (Fly restarting the whole machine), the
inner one fails quiet and keeps going (skip this scan, poll for the
next one).

## The structure pass

**Axis: failure — where does it originate, propagate, and get
contained?** Trace it at three altitudes, because that contrast is the
actual lesson:

```
  One axis — "does this failure escalate, or get absorbed?" — three altitudes

  ┌─ altitude 1: process (start-production.js) ────────────────────┐
  │  web OR worker exits, for ANY reason  → ESCALATES              │
  │  kills the sibling, exits non-zero, Fly restarts the machine     │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ altitude 2: poll loop (worker.ts main()) ──────────────────────┐
  │  claimAndRunNext() throws                → ABSORBED             │
  │  logged, loop continues to the next poll                        │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ altitude 3: single scan claim (worker-core.server.ts) ─────────┐
  │  admin client can't be constructed        → ABSORBED, NAMED      │
  │  this ONE scan is marked FAILED and consumed, not retried forever│
  └──────────────────────────────────────────────────────────────────┘
```

**The seam that matters**: the boundary between altitude 1 and
altitude 2. Above it, any exit is fatal to the whole machine; below it,
almost nothing is. That flip is deliberate, and it's the load-bearing
design decision in this whole file.

## How it works

**Move 1 — the mental model.** Match the blast radius of your recovery
to the blast radius of the failure. Crash the *whole* machine only when
you can no longer trust *any* of its state — two long-lived siblings
sharing one SQLite volume qualify. Swallow-and-continue when the
failure is scoped to exactly one unit of work — one scan, one poll
iteration.

```
  Pattern — nested containment, tightening blast radius inward

  ┌─ machine ───────────────────────────────────────┐
  │  any child dies → BOTH die → machine restarts     │
  │  ┌─ poll loop ─────────────────────────────────┐  │
  │  │  one iteration throws → logged → loop keeps   │  │
  │  │  ┌─ single scan claim ─────────────────────┐ │  │
  │  │  │  this scan fails → marked FAILED,         │ │
  │  │  │  worker keeps serving OTHER shops' scans   │ │
  │  │  └────────────────────────────────────────────┘ │
  │  └────────────────────────────────────────────────┘  │
  └───────────────────────────────────────────────────────┘
```

**Move 2 — the walkthrough.**

**Part 1 — the outer boundary kills a healthy sibling on purpose.**
`onChildExit` (`app/start-production.js:105-122`) treats ANY child
exiting, for ANY reason, as fatal to the whole machine: it sets
`shuttingDown`, forces `exitCode = 1`, and calls `stopAll("SIGTERM")` on
the *other*, still-healthy child. The file's own top comment names
exactly what breaks if you don't do this
(`app/start-production.js:21-31`): "Silently restarting just one of the
two child processes in place would risk them drifting (e.g. worker
stuck on a bad Prisma client version) without ever surfacing as a
Fly-visible restart/alert." That's the whole justification in one
sentence — this is a deliberate cost, not a missed optimization.

**Part 2 — the restart is the actual observability payoff.**
`fly.toml` has no `[processes]` block and sets
`auto_stop_machines = false` / `min_machines_running = 1`
(`app/fly.toml:24-32`), so a non-zero exit from `start-production.js`
is a Fly-visible machine restart — something that shows up in
`fly status`/`fly logs` as an event, not a silent in-place respawn. The
crash-only design isn't just simpler; it converts an outage into
something an operator can actually see happened.

**Part 3 — the inner loop absorbs failure by design, and the comment
says why.** `worker.ts`'s `main()` wraps only `claimAndRunNext` in a
`try`/`catch` (`app/worker.ts:69-89`), logging and continuing:
"A bad scan (or a transient claim failure) must never kill the whole
worker process — log and keep polling so other queued scans for other
shops still get processed" (`app/worker.ts:74-76`).

```
  Execution trace — one failing iteration inside the poll loop

  iteration N:   claimAndRunNext() throws
                 → console.error("[worker] error while claiming/running a scan", err)
                 → scanId stays null
                 → shuttingDown? no → scanId truthy? no → await sleep(POLL_MS)
  iteration N+1: loop resumes normally, polls again
```

Note the precise detail: an error on this path still waits the full
5000ms `POLL_MS` before retrying (`app/worker.ts:25, 88`) — it does
NOT take the "poll again immediately" fast path reserved for a
successfully-claimed scan (`app/worker.ts:82-86`). A failed claim is
treated like "nothing to do right now," not like "there's more work
waiting."

**Part 4 — the innermost containment is fine-grained enough to be
named, not just absorbed.** `claimAndRunNext`'s own catch
(`app/app/services/scan/worker-core.server.ts:44-75`) is a third,
even-tighter boundary: it doesn't just log-and-continue, it writes a
terminal `FAILED` state for the *one scan* that couldn't get an admin
client, then returns that scan's ID so the caller treats it as
processed. The comment names the specific incident class this prevents
(`worker-core.server.ts:51-56`): a shop uninstalls (its `Session` row
is deleted), but its still-QUEUED scan survives; without this guard,
the worker would keep re-selecting that same broken scan forever — a
livelock — and no other shop's scan would ever run.

This is the self-similarity worth naming once: the same underlying
shape — catch, log server-side, write one terminal fact, move on —
shows up at three nested altitudes (process / loop / scan), each one
tighter than the last. → see `02-safe-failure-messaging.md` for the
sanitization half of that shape, and
`01-scan-state-machine-audit-trail.md` for what "write one terminal
fact" actually persists.

**Move 3 — the principle.** Containment boundaries aren't a single
choice you make once — they're a series of decisions, one per altitude,
about how much you're willing to lose versus how much you're willing to
risk letting corrupt state survive. Get the innermost one wrong and one
bad scan takes down the whole app; get the outermost one wrong and a
slowly-drifting process runs forever with nobody noticing.

## Primary diagram

```
  Full picture — three altitudes, three different recovery radii

  ┌─ Fly machine ──────────────────────────────────────────────────┐
  │  start-production.js: web ⟷ worker, either exits → BOTH die,     │
  │  process.exit(1) → Fly restarts the whole machine (visible event)│
  │                                                                    │
  │  ┌─ worker.ts main() loop ────────────────────────────────────┐  │
  │  │  try { claimAndRunNext() } catch { log; continue polling }  │  │
  │  │                                                              │  │
  │  │  ┌─ worker-core.server.ts claimAndRunNext ─────────────────┐│  │
  │  │  │  admin factory fails → THIS scan → FAILED (named code)   ││  │
  │  │  │  → returned as "processed" → next poll gets a DIFFERENT   ││  │
  │  │  │    scan, no livelock                                      ││  │
  │  │  └────────────────────────────────────────────────────────────┘│  │
  │  └──────────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is a hand-rolled version of what Erlang/OTP calls a supervisor
tree, or what Kubernetes gives you for free with pod restarts — one
Fly machine, no orchestrator, so the "supervisor" is 140 lines of
Node.js instead of a platform feature. The honest cost, named without
flinching: there's no representable state for "worker crashed but web
is still healthy" — the design deliberately takes both down together,
because the file's own comment already decided that drift risk
outweighs partial availability. If this app ever needed the worker and
web to fail independently, the move would be splitting them onto
separate Fly machines with their own volumes (or moving off SQLite
entirely) — a bigger change than tuning the supervisor, which is
exactly why `fly.toml`'s own comment calls out that a `[processes]`
block would break the single-SQLite-volume assumption
(`app/fly.toml:7-11`).

## Interview defense

**Q: Why does a crashing worker also kill a perfectly healthy web
process?**
A: Because they share one SQLite volume and one deploy unit — if the
worker died from something like a bad Prisma client version, letting
the web process keep serving on the same volume risks exactly the kind
of silent drift the top-of-file comment warns about. Killing both and
letting Fly restart the whole machine turns an ambiguous, silent
failure into one visible, well-understood event: a machine restart.

```
  the tradeoff, drawn

  restart only the worker         restart the whole machine
  ────────────────────────        ──────────────────────────
  web stays "available"           brief full outage
  but state can silently drift    but the failure is now VISIBLE
  between the two processes       (fly logs / fly status show it)
```

**Q: What's the actual signal an on-call engineer would see when this
fires?**
A: A Fly machine restart event — visible in `fly status` and as a gap
in `fly logs`, immediately followed by the `[supervisor]` boot sequence
re-running (`migrate deploy` → spawn web → spawn worker). There's no
alert beyond that; noticing it still depends on someone looking.

## See also

- `audit.md` §7 (incident-analysis-and-prevention) and §8 (red flags —
  the `/healthz` blind spot this pattern doesn't cover)
- `01-scan-state-machine-audit-trail.md` — the terminal-state write
  altitude-3 containment performs
- `02-safe-failure-messaging.md` — the sanitization half of the
  catch-log-continue shape reused at every altitude here
