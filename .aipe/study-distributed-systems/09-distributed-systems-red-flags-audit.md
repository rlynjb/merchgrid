# Distributed Systems Red-Flags Audit

Coordination risk assessment — Project-specific

## Zoom out, then zoom in

```
  Zoom out — where this audit sits

  ┌─ Every layer this guide has covered ────────────────────────┐
  │  system map · retries · idempotency · consistency ·          │
  │  replication · queues · clocks · sagas                        │
  └───────────────────────┬────────────────────────────────────────┘
                          │ collect every documented risk, rank by consequence
  ┌─ This file ───────────▼────────────────────────────────────────┐
  │  ★ RANKED RISKS ★ — what actually breaks, and under what        │ ← we are here
  │  specific condition, with the file:line that proves it           │
  └────────────────────────────────────────────────────────────────────┘
```

Every other file in this guide taught a mechanism and, along the way,
named its honest limits. This file collects those limits into one ranked
list — not a new audit from scratch, but the load-bearing risks pulled
together and ordered by what actually happens if each one fires, so you
can answer "what would break first" without re-reading eight files.

## Structure pass — layers, axis, seams

**Layers:** this is a cross-cutting file, so instead of one set of layers
it walks the same axis — **consequence** — across every mechanism already
taught.

**The axis: consequence — if this risk fires today, what specifically
breaks, for whom, and how visibly?**

```
  Consequence axis, the ranking principle for this file

  rank by:  (a) does it corrupt data, or just delay/duplicate work?
            (b) is it already mitigated, or genuinely open?
            (c) does it require an unlikely trigger, or a common one?
```

**The seam:** every risk below is a seam between "what's true today" (one
worker, one writer, per-session serialization) and "what would have to
change" (a second worker, concurrent requests, a replicated store). Ranking
is really ranking *how close each seam is to being crossed* by ordinary
product growth, not abstract severity.

## How it works

### Move 1 — the mental model

You've triaged a bug backlog before — sorted by "how bad is this if it
fires" crossed with "how likely is it to actually fire," not just severity
in isolation. That's this file's whole method, applied to coordination
risk specifically instead of general bugs.

```
  Pattern: risk = consequence × likelihood-of-trigger, not severity alone

  for each documented risk:
    consequence  = data corruption > user-visible failure > silent inefficiency
    trigger      = "happens under normal single-worker load" >
                    "needs concurrent requests" > "needs a second worker"
  rank = consequence, tie-broken by trigger likelihood
```

### Move 2 — the ranked list, one risk at a time

**#1 — Non-atomic queue claim (`worker-core.server.ts:22-42`).**
*Consequence if triggered:* two workers process the same `Scan` row
simultaneously — duplicate Shopify reads, duplicate `Finding` writes racing
inside `runScan`'s `$transaction`, and undefined behavior about which
worker's write wins. This is the single scariest item on this list because
its blast radius is data corruption, not just delay. *Why it's #1 despite
being currently safe:* it's a plain `findFirst`, not an atomic conditional
update — the docstring says so directly: *"this is intentionally not an
atomic claim-then-lock... If a second worker process is ever introduced,
this needs to become an atomic conditional update."* *Trigger likelihood
today:* zero — there's exactly one worker, spawned once
(`start-production.js:84-87`). *Trigger likelihood at product growth:* high
— the very first time this product needs more throughput than one worker
provides, this is the first thing that breaks, silently, unless it's fixed
proactively rather than reactively. *The fix, already named in the code:*
`UPDATE Scan SET status='READING_CATALOG' WHERE id=? AND status='QUEUED'`,
checking the affected-row count.

**#2 — TOCTOU race in `enqueueScan` (`queue.server.ts:54-68`).**
*Consequence if triggered:* a duplicate `QUEUED` row for the same shop —
not data corruption, since each scan still runs its own independent,
correct pipeline; the cost is a wasted Shopify read and a confusing
"why are there two scans" moment for the merchant. *Why it's #2, not #1:*
lower consequence (no corruption, just duplication) even though the code
comment names the exact same category of gap (check-then-act, not atomic).
*Trigger likelihood today:* low — the comment argues correctly that
per-merchant HTTP sessions serialize these calls in practice, and one
worker downstream means duplicates don't compound. *Trigger likelihood at
growth:* rises with concurrent API clients (e.g. a merchant with multiple
staff accounts triggering scans near-simultaneously), independent of
worker count. *The fix, already named in the code:* a partial unique index
— one row per `shopId` where status is non-terminal — enforced at the
database level.

**#3 — Single point of failure by design (`fly.toml:1-8`,
`start-production.js:20-31,105-136`).** *Consequence if triggered:* a bug
or crash in *either* the web process or the worker process takes down
*both*, because the supervisor kills the sibling and the whole Fly machine
restarts. *Why it's #3:* this is a deliberate, stated tradeoff — not a bug
— accepted in exchange for exactly one SQLite writer and zero split-brain
risk. It's ranked here because it's still a real availability ceiling: a
worker-side crash loop (e.g. a bad Prisma client version, per the
supervisor's own comment) takes the merchant-facing UI down too, which
would surprise anyone assuming web and worker fail independently.
*Trigger likelihood:* moderate — any unhandled worker exception that
escapes `worker.ts`'s own catch-and-continue loop (`worker.ts:71-78`) and
reaches `main().catch(...)` (`worker.ts:94-97`) triggers this. *The
accepted cost, stated plainly:* simplicity and correctness (one writer)
over independent failure domains.

**#4 — Poison-pill handling is real, but has no dead-letter queue
(`worker-core.server.ts:44-75`).** *Consequence if NOT present:* would be
#1-tier — a livelock blocking every shop's queue forever, which is why this
guard exists and is correctly implemented today. *The remaining gap:* the
guard marks the row `FAILED` with the same generic `failureCode:
"ADMIN_UNAVAILABLE"` that any other setup-phase issue would produce; there's
no separate dead-letter status distinguishing "this failed because the shop
is gone" (never retryable) from "this failed transiently" (potentially
retryable), so an operator scanning `FAILED` scans can't tell the two apart
without reading `failureCode` values individually. *Trigger likelihood:*
happens today, in production, every time a merchant uninstalls with a scan
still `QUEUED` — this is not hypothetical. *Consequence of the gap:* low —
it's an observability gap, not a correctness one; the queue still drains
correctly.

**#5 — Consistency snapshot has a narrower guarantee than its docstring
implies (`queue.server.ts:36-39`, `runner.server.ts:90-91,125-129`).**
*Consequence if triggered:* a scan's `minimumMarginPercentUsed` reflects
whatever was live in `ShopSettings` when the worker executed, not
necessarily what was live when the merchant clicked "scan" — a merchant
editing their margin threshold in the few seconds a scan sits `QUEUED`
changes what that specific scan checks against, silently. *Trigger
likelihood:* low — requires a settings edit landing inside a multi-second
queue wait, a narrow window. *Consequence severity:* low — the final
`minimumMarginPercentUsed` column still accurately records whatever
threshold actually ran, so there's no silent lie in the persisted data,
just a narrower "never retroactively changes" guarantee than the docstring
states.

### Move 3 — the principle

None of these five risks are "bugs" in the sense of behaving incorrectly
against the system's actual current constraints (one worker, one writer,
per-session request serialization). Every one of them is a *documented*
simplification, correct today, that becomes a real defect the moment its
underlying constraint changes. The discipline this audit models: know
exactly which constraint each shortcut depends on, so the day that
constraint is violated (a second worker added, concurrent multi-staff
scan triggers, a crash-looping worker), you already know which fix to
reach for instead of discovering it as an incident.

## Primary diagram

```
  Risk ranking — consequence (vertical) × current trigger likelihood (horizontal)

  high  ┤ #1 non-atomic claim
  conseq│ (data corruption if
        │  2nd worker added)
        │
        │              #3 shared failure domain
        │              (availability ceiling,
        │               stated tradeoff)
        │
        │ #2 TOCTOU enqueue          #4 no dead-letter
        │ (duplicate row,            distinction
        │  no corruption)            (observability gap)
        │
  low   │                                        #5 snapshot gap
        │                                        (narrow window,
        │                                         self-correcting)
        └──────────────────────────────────────────────────────►
          low (needs 2nd worker)        high (happens today)
                  current trigger likelihood
```

## Elaborate

The pattern across all five findings — a comment in the code names the gap,
names why it's accepted, and names the fix that would close it — is itself
worth noticing as a practice independent of the specific risks. That's a
higher engineering bar than either silently shipping the shortcut or
over-engineering a fix nobody needs yet: the shortcut is documented
precisely enough that the day it needs fixing, the fix is already
specified. Compare that to a codebase where the same shortcuts exist but
are undocumented — the risk is identical, but the cost of eventually
finding and understanding it is far higher.

## Interview defense

**Q: "If you had to fix exactly one of these before this product scaled
to a second worker, which one, and why?"**
A: The non-atomic queue claim, unconditionally — it's the only risk on this
list whose consequence is actual data corruption (two workers processing
the same scan, racing writes) rather than duplication, availability, or an
observability gap. Everything else degrades gracefully; this one doesn't.
```
  #1 non-atomic claim: fix BEFORE scaling workers (corruption risk)
  #2-#5: fix opportunistically (no corruption risk)
```
One-line anchor: *rank by "does this corrupt data" before ranking by
anything else.*

**Q: "Is the shared failure domain (#3) actually a problem, or a valid
tradeoff?"**
A: A valid, explicitly stated tradeoff — the alternative (separate web and
worker machines) can't share the SQLite volume Fly mounts, so splitting
them would mean giving up the single-writer guarantee that makes every
other mechanism in this guide simpler. It's ranked #3 not because it's
wrong, but because it's the ceiling on availability this product has
accepted, and that ceiling is worth being able to name precisely rather
than discovering during an incident.
One-line anchor: *a stated tradeoff still deserves a rank — "accepted" and
"risk-free" aren't the same thing.*

## See also

- `06-queues-streams-ordering-and-backpressure.md` — the full mechanism
  behind risks #1, #2, and #4.
- `01-distributed-system-map.md` — the full mechanism behind risk #3.
- `04-consistency-models-and-staleness.md` — the full mechanism behind
  risk #5.
- `.aipe/audits/` — general codebase health findings that fall outside this
  guide's coordination-under-partial-failure lens.
