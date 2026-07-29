# Documented tradeoff as NFR governance

### Risk-acceptance-in-comments / "named debt" discipline — Project-specific practice

## Zoom out, then zoom in

```
  Zoom out — where this pattern shows up

  ┌─ Reliability lens ────────────────────────────────────────────┐
  │  worker-core.server.ts:22-42 — "not an atomic claim-then-lock"  │
  └───────────────────────┬────────────────────────────────────────┘
  ┌─ Scalability lens ──────▼──────────────────────────────────────┐
  │  queue.server.ts:54-68 — "acceptable for MVP," names the fix     │
  └───────────────────────┬────────────────────────────────────────┘
  ┌─ Availability lens ─────▼──────────────────────────────────────┐
  │  DEPLOY.md — no Litestream, "not implemented here"                │
  └───────────────────────┬────────────────────────────────────────┘
  ┌─ Maintainability lens ───▼──────────────────────────────────────┐
  │  ★ THIS PATTERN ★ — the SAME shape repeating across every lens:    │ ← we are here
  │  a gap is named, its condition for becoming unsafe is stated,      │
  │  and the fix is written down before anyone needs it under fire     │
  └────────────────────────────────────────────────────────────────┘
```

Every NFR lens in `audit.md` bumped into this same shape independently —
that's not a coincidence, it's the repo's dominant style of managing
technical debt. Instead of collecting scattered "TODO: fix this" comments
or a separate debt-tracking doc that drifts out of sync with the code, this
repo writes the debt down **exactly where it lives**, in a specific format:
what's true today, why it's safe today, and what would make it stop being
safe.

## Structure pass — layers, axis, seams

**Layers:** this pattern isn't a layer in the architecture — it's a
documentation *habit* applied at every layer (queue, worker, deploy,
schema) where an NFR gap exists.

**The axis: is a known gap named in writing at its call site, or does it
exist silently?**

```
  Same kind of gap, two very different maintainability postures

  SILENT GAP                          NAMED GAP (this repo's actual style)
  ┌─────────────────────────┐         ┌─────────────────────────────────┐
  │ code has a race          │         │ code has a race                  │
  │ condition                │         │ condition                        │
  │                          │         │                                  │
  │ next engineer finds it   │         │ next engineer reads the comment: │
  │ by causing an incident   │         │ "not atomic — safe because one   │
  │                          │         │ worker; fix: atomic UPDATE with  │
  │                          │         │ affected-row check"              │
  └─────────────────────────┘         └─────────────────────────────────┘
    cost: paid once, at 3am              cost: paid once, while reading
    under production pressure             the code calmly, months earlier
```

**The seam:** every instance below sits at the exact boundary between "what
this system assumes today" (one worker, one writer, per-session request
serialization) and "what would have to be true for the gap to actually
fire" (a second worker, concurrent requests, a lost volume). The comment
*is* the seam's contract — it tells the next engineer precisely which
constraint to watch.

## How it works

### Move 1 — the mental model

You've left a comment on a hacky workaround before — `// TODO: this breaks
if X, fix properly later`. Most of the time that comment is vague and
rots. This repo's version is a stricter, three-part discipline that never
rots because it names the exact trigger condition, not just "later":

```
  Pattern: name-the-gap comment, three required parts

  1. WHAT is being skipped        ("this is intentionally not an atomic
                                     claim-then-lock")
  2. WHY it's safe right now       ("there is exactly one worker process")
  3. WHAT the fix is, precisely    ("an atomic conditional UPDATE...
                                     checking the affected-row count")

  missing any one part = a TODO, not this pattern
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** Three parts, and the pattern collapses into a
generic TODO comment if any one is missing: the **named condition** (what
constraint keeps this safe), the **named trigger** (what event would break
it), and the **named fix** (the exact change, not "investigate later").

**What breaks when each part is missing:**
- **Drop the named condition** → the comment becomes "this has a race" with
  no way to judge urgency; every reader has to independently re-derive
  whether it's dangerous right now.
- **Drop the named trigger** → nobody knows *when* to revisit it; the fix
  either happens too early (wasted effort) or too late (an incident finds
  it first).
- **Drop the named fix** → the next engineer who does need to fix it has
  to design the solution from scratch, under whatever pressure caused them
  to look at it (usually an incident).

**Four real instances, same shape, four different NFR lenses:**

**Instance 1 — the queue-claim race (reliability + scalability).**
`app/app/services/scan/worker-core.server.ts:22-28`:
```ts
// This is intentionally not an atomic claim-then-lock: with exactly one
// worker process, a plain `findFirst` is sufficient. If a second worker
// process is ever introduced, this needs to become an atomic conditional
// update (`UPDATE Scan SET status=... WHERE id=? AND status='QUEUED'`,
// checking the affected-row count) instead.
```
Condition: one worker. Trigger: a second worker process. Fix: named
precisely, down to the SQL shape. This is ranked the #1 reliability risk
*and* the #1 scalability ceiling in `audit.md` lens 8 — but it's a
low-anxiety #1, because the fix is already specified.

**Instance 2 — the `enqueueScan` TOCTOU race (scalability, this time at
the API layer).** `app/app/services/scan/queue.server.ts:54-62`:
```ts
// The "is there already an active scan" check and the `create` below are
// not atomic — acceptable for MVP given per-session request serialization
// and single-worker consumption downstream. The real fix is a partial
// unique index on Scan(shopId) WHERE status NOT IN ('COMPLETED','FAILED').
```
Condition: per-session serialization + single worker. Trigger: concurrent
multi-staff scan triggers for one shop. Fix: named down to the exact
partial-index DDL.

**Instance 3 — no Litestream (availability + durability).**
`app/DEPLOY.md`'s "Known caveats" section:
```
SQLite-on-a-volume durability is single-node. There's no replication —
if the volume is lost, the data is lost. Fly volumes do have their own
snapshot mechanism, but for real backup/restore guarantees, consider
adding Litestream... Not implemented here.
```
Condition: data is regenerable (a merchant can re-run a scan). Trigger:
volume loss between snapshots. Fix: named, by product name, with the
reason it wasn't worth building yet.

**Instance 4 — test-only parameters on production functions
(maintainability).** `app/app/services/scan/runner.server.ts:14-26`'s
`RunScanDeps` doc comment states directly that `now`, `catalogMaxRetries`,
and `catalogSleep` exist purely for test injection and "production callers
should omit these" — naming the cost (every non-test caller sees three
parameters it never sets) rather than hiding it behind a DI container the
codebase doesn't otherwise need.

```
  Layers-and-hops — the same comment shape at four different layers

  ┌─ Queue layer ────┐  worker-core.server.ts:22-28 (reliability)
  │  claim race        │
  └──────────────────┘
  ┌─ API layer ───────┐  queue.server.ts:54-62 (scalability)
  │  enqueue race       │
  └──────────────────┘
  ┌─ Infra layer ─────┐  DEPLOY.md (availability/durability)
  │  no replication     │
  └──────────────────┘
  ┌─ Test-seam layer ──┐  runner.server.ts:14-26 (maintainability)
  │  exposed knobs       │
  └──────────────────┘
       ▼ same 3-part shape at every layer: condition, trigger, fix
```

### Move 3 — the principle

A codebase's NFR posture isn't just "which gaps exist" — it's "how much
does the next engineer have to rediscover before they can safely change
anything." Naming a gap's exact safety condition and exact fix at its call
site converts an implicit, rediscoverable risk into an explicit, one-read
contract. This is cheaper than fixing every shortcut preemptively (which
wastes effort on constraints that may never be violated) and safer than
leaving shortcuts undocumented (which means the fix gets designed during an
incident instead of calmly, in advance).

## Primary diagram

```
  The pattern, end to end, across this repo's four instances

  ┌─ what's true today ──────────────┐
  │  1 worker · 1 writer · per-session │
  │  request serialization · data is    │
  │  regenerable                          │
  └─────────────────┬────────────────┘
                    │ named explicitly, at the exact call site,
                    │ in a comment with 3 required parts:
                    ▼
     ┌───────────────────────────────────────────┐
     │ 1. WHAT is skipped   (the shortcut itself)   │
     │ 2. WHY it's safe now  (the constraint it leans│
     │                        on)                     │
     │ 3. WHAT the fix is    (the exact change,       │
     │                        specified in advance)    │
     └─────────────────┬─────────────────────────┘
                       │ the day the named constraint is violated
                       ▼
              ┌──────────────────────┐
              │  fix is already        │
              │  designed — apply it,   │
              │  don't discover it       │
              └──────────────────────┘
```

## Elaborate

This is the codebase-level cousin of an Architecture Decision Record
(ADR) — except instead of living in a separate `docs/adr/` folder that
drifts out of sync with the code it describes, the decision lives at the
exact line where it applies, so it can never point at a moved or deleted
call site without the comment itself being touched. The tradeoff: ADRs are
searchable and browsable as a set; this repo's version requires reading the
code to find the decisions. For a ~30-file MVP with five instances of the
pattern, that tradeoff favors inline comments — it would flip the other
way for a codebase with fifty of them.

## Interview defense

**Q: "Is a comment like `worker-core.server.ts:22-28` a red flag or a good
sign?"**
A: A good sign, specifically because it has all three required parts — it
names the exact condition that keeps the shortcut safe, the exact trigger
that would break it, and the exact fix. A red flag would be the same
shortcut with no comment at all, or a comment that just says "TODO: fix
this" with no condition or fix named.
```
  vague TODO           →  next engineer re-derives everything from scratch
  3-part named comment →  next engineer applies a pre-designed fix
```
One-line anchor: *a named tradeoff with a condition and a fix is a decision;
an unnamed one is a landmine.*

**Q: "How would you tell if this discipline is actually being followed,
versus just look good in a few cherry-picked examples?"**
A: Check whether every ranked red flag in every sibling audit
(`study-distributed-systems`, `study-database-systems`, `study-data-modeling`)
independently rediscovers the same handful of gaps and finds each one
already commented this way — which is exactly what happened across this
guide and its four siblings: the queue-claim race and the `enqueueScan`
race show up, with matching comments, in at least three independent
audits.
One-line anchor: *convergent discovery across independent audits is the
real evidence this is a habit, not a coincidence.*

## See also

- `audit.md` lens 2 (reliability), lens 3 (scalability), lens 4
  (maintainability) — each cites one of this pattern's four instances.
- `.aipe/study-distributed-systems/09-distributed-systems-red-flags-audit.md`
  — the same four risks, ranked independently by consequence.
- `.aipe/study-database-systems/09-database-systems-red-flags-audit.md`
  — the same discipline observed from the storage-engine angle.
- `.aipe/study-software-design/audit.md` lens 5 ("pull complexity downward")
  — the `RunScanDeps` instance, from the AOSD-primitives angle.
