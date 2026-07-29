# Always-on single machine: one topology, three NFRs

### Single-tenant-deploy always-on topology — Project-specific

## Zoom out, then zoom in

```
  Zoom out — one fly.toml decision, three NFR consequences

  ┌─ fly.toml ─────────────────────────────────────────────────────┐
  │  auto_stop_machines = false                                      │
  │  min_machines_running = 1                                         │
  │  one machine, one SQLite volume mounted at /data                   │
  └───────────────────────┬────────────────────────────────────────┘
                         │ one config decision, three NFR readings
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  ┌─ Availability ┐ ┌─ Cost ────────┐ ┌─ Reliability ──────┐
  │  single point  │ │  continuous     │ │  fail-together        │ ← we are here
  │  of failure     │ │  billing floor   │ │  supervisor design      │
  └──────────────┘ └────────────────┘ └────────────────────┘
```

`.aipe/study-system-design/06-single-machine-shared-volume.md` already
walks *why* this app runs one machine — one SQLite writer, no split-brain
risk. This file's job is different: it's the NFR reading of that same
decision, showing that a single topology choice is simultaneously an
availability ceiling, a cost floor, and the mechanism that makes reliability
simple. Strip the "always-on, single-machine" decision out and the system
doesn't lose one capability — it loses three NFR properties at once.

## Structure pass — layers, axis, seams

**Layers:** `fly.toml`'s machine config → `start-production.js`'s process
supervision → the always-on billing consequence.

**The axis: what does "one machine, never scaled to zero" actually cost,
across three different NFRs at once?**

```
  One decision, three axis readings

  the decision:  ONE always-on Fly machine, ONE SQLite volume

  availability →  no redundancy: a crash in either process takes down both
  cost         →  billed continuously, even at zero HTTP traffic
  reliability  →  the SAME constraint that forces fail-together supervision
                   is what makes atomic, single-writer persistence simple
```

**The seam:** the alternative to this bundle — two machines, one for web
and one for worker — can't share the Fly volume Fly mounts. Crossing that
seam (splitting the topology) doesn't just change availability; it forces
a real datastore migration (SQLite → hosted Postgres) before the worker
and web tier could even run independently, because the thing they'd stop
sharing is the one file both processes write to.

## How it works

### Move 1 — the mental model

You've paid for an always-on `t3.micro` before instead of a serverless
function, because your workload needed to keep a background loop running
even with zero incoming requests. Same tradeoff here, just named
explicitly in the config: the worker's poll loop (`worker.ts:69-92`) has to
keep checking the queue every 5 seconds whether or not a merchant is
actively looking at the app, so the machine can never be allowed to scale
to zero.

```
  Pattern: always-on because of a background loop, not request traffic

  IF this app only served HTTP requests:
    autostop=true would be fine — scale to zero between requests,
    Fly wakes the machine on the next inbound request

  BECAUSE this app also runs a background poll loop:
    the loop must keep running with ZERO inbound HTTP traffic
    → autostop=false is REQUIRED, not a choice
    → billed continuously, whether or not any merchant is scanning
```

### Move 2 — the three NFR readings, one at a time

**Reading 1 — availability: a genuine single point of failure, named in
writing.** `fly.toml:41-43`:
```toml
auto_stop_machines = false
auto_start_machines = true
min_machines_running = 1
```
One machine, one health check (`[[http_service.checks]]`, checking only
`/healthz` — "is Remix serving," per `app/app/routes/healthz.tsx:6-9`'s own
comment, not "is the worker draining the queue"). No second machine, no
failover region. A crash in either process is designed to take the *whole
machine* down —
`.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
ranks this risk #3, explicitly calling it "a deliberate, stated tradeoff —
not a bug." Full mechanism: `.aipe/study-system-design/06-single-machine-shared-volume.md`.

**Reading 2 — cost: a fixed floor, not a request-shaped bill.**
`.aipe/study-performance-engineering/audit.md` lens 1 names this directly:
"a system-visible cost budget nobody wrote down as a target but that's
real." No code in this repo ties a request, a scan, or a shop to a dollar
figure — cost here is entirely a function of keeping one machine running
continuously, independent of how many merchants are actively scanning at
any given moment. Based on Fly's published pricing for the smallest
`shared-cpu-1x` machine class plus the 1GB volume this app's own comment
specifies (`fly volumes create data --size 1`, `fly.toml`), this deploy
costs on the rough order of **$2–3/month** — an inference from Fly's public
pricing table, not a number this repo measures or bills against anywhere.

**Reading 3 — reliability: the same constraint that costs money also
buys simplicity.** `start-production.js:105-122`'s fail-together
supervisor design only works cleanly *because* web and worker already
share one machine and one volume — there's no cross-machine coordination
problem to solve, no need to detect "is the other machine still alive"
over a network. The single-machine topology is what makes the
supervisor's design (kill the sibling, exit non-zero, let Fly restart
everything together) as simple as it is. This is the flip side of Reading
1: the same lack of redundancy that caps availability is what keeps the
reliability mechanism a same-process `child_process` kill rather than a
distributed consensus problem.

```
  Layers-and-hops — one topology, three consequences, traced

  ┌─ fly.toml: ONE machine, autostop=false ────────────────────────┐
  │                                                                    │
  │   ┌─ availability ──┐   ┌─ cost ──────────┐   ┌─ reliability ──┐  │
  │   │ no redundancy    │   │ continuous bill   │   │ same-process    │  │
  │   │ (SPOF, named)     │   │ (~$2-3/mo,         │   │ supervisor is   │  │
  │   │                    │   │  inferred)          │   │ simple BECAUSE  │  │
  │   │                    │   │                      │   │ of the SPOF      │  │
  │   └──────────────────┘   └────────────────────┘   └────────────────┘  │
  └────────────────────────────────────────────────────────────────┘
```

### Move 3 — the principle

A deploy topology decision is rarely a single-NFR tradeoff — it's usually
a bundle, and the same property that costs you on one axis is often the
thing buying you simplicity on another. The discipline worth having: when
you evaluate "should we split this into two machines," price out all three
axes at once (what does it cost in dollars, what does it cost in
availability, what does it cost in reliability-mechanism complexity), not
just the one that prompted the question.

## Primary diagram

```
  One fly.toml decision, three NFR readings, all traced to the same root

  ┌─────────────────────────────────────────────────────────────────┐
  │  auto_stop_machines=false, min_machines_running=1, ONE volume       │
  └───────────────────────────┬─────────────────────────────────────┘
              ┌───────────────┼───────────────┐
              ▼                ▼                ▼
    ┌─ availability ┐ ┌─ cost ────────┐ ┌─ reliability ────────┐
    │ SPOF, no        │ │ ~$2-3/mo,       │ │ fail-together           │
    │ redundancy,      │ │ continuous,      │ │ supervisor, simple      │
    │ named + accepted  │ │ inferred not      │ │ because there's only     │
    │ (DEPLOY.md,        │ │ measured           │ │ one machine to manage      │
    │  dist-sys #3)       │ │                     │ │                            │
    └───────────────┘ └────────────────┘ └────────────────────┘
```

## Elaborate

This bundle is the mirror image of a typical "scale-out for
availability" story: most systems trade cost for availability by adding
redundant machines (pay more, survive one machine's failure). This repo
does the opposite deliberately — it accepts a lower availability ceiling
specifically to avoid paying for redundancy *and* to avoid the
coordination complexity a second SQLite writer would introduce. That's the
right call for a per-merchant, on-demand audit tool where an hour of
downtime costs a delayed scan, not a lost transaction — it would be the
wrong call for a system where availability has real revenue attached to
every minute of uptime.

## Interview defense

**Q: "Why can't this app just add a second machine for redundancy?"**
A: Because both processes share one SQLite file on one Fly volume, and a
Fly volume can only be mounted by one machine at a time — a second machine
can't attach to the same file. Adding real redundancy here means migrating
off SQLite to a hosted database first (Postgres), which is a bigger
architectural change than "just add a machine."
```
  today:    [machine 1: web + worker] ──► [1 volume]
  redundant: [machine 1] ──► [volume]?  [machine 2] ──► [same volume]? ✗ can't share
```
One-line anchor: *the storage choice, not the process count, is what's
actually blocking redundancy here.*

**Q: "Is the ~$2-3/month cost estimate solid?"**
A: No — and that's worth saying plainly. It's inferred from Fly's public
pricing for the smallest shared-cpu machine class plus a 1GB volume; this
repo has no cost-tracking code, no billing dashboard export, and no
invoice on file to confirm it. It's a reasonable order-of-magnitude
estimate, not a measured fact.
One-line anchor: *label an inferred number as inferred — this repo has zero
cost instrumentation to confirm it.*

## See also

- `.aipe/study-system-design/06-single-machine-shared-volume.md` — the full
  mechanism behind why this topology exists at all.
- `.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
  risk #3 — the availability reading, ranked independently.
- `.aipe/study-performance-engineering/audit.md` lens 1 — the cost reading,
  named as "a system-visible cost budget nobody wrote down as a target."
- `audit.md` lens 6 (availability/security/privacy) and lens 7
  (observability/cost) — where this pattern's evidence is cited from the
  NFR-verdict angle.
