# Database systems red flags — ranked audit

### Storage-engine and consistency risk audit — Project-specific, ranked by consequence

## Zoom out — the bigger picture

Every prior file taught one mechanism in isolation. This file steps back and ranks the actual risks those mechanisms create in this specific repo — by consequence, not by which file they happened to live in.

```
  Zoom out — this file's place in the guide

  01-08:  one mechanism each, taught in depth
  09:     ★ THIS FILE — every real risk found along the way, ★  ← we are here
          ★ ranked by what breaks and how bad it is ★
```

## Zoom in — the concept

This is a **risk register**, not a new mechanism — the discipline of taking every "here's a gap" moment from the preceding eight files and forcing a single ranked answer to "if something breaks because of the database layer, which of these is most likely to be the reason, and how bad is it." Ranking matters more than listing: a missing index that degrades silently over a year is a different kind of risk than a documented, accepted TOCTOU race that's already been reasoned about.

## The structure pass

**Axis: consequence × likelihood, not "is this technically imperfect."** Every finding below is graded on what actually breaks (data loss? wrong answer returned? just slower?) and how likely it is to occur given this app's real traffic shape — not against an abstract "best practice" checklist.

```
  One axis — ranking findings by (consequence × how soon it bites)

  HIGH consequence, WILL happen eventually  → #1
  MEDIUM consequence, low current frequency → #2, #3
  LOW consequence, already mitigated by     → #4, #5
  design or explicitly accepted in writing
```

## The ranked findings

### 1. `claimAndRunNext`'s queue-claim query is an unbounded, global full table scan

**File:line:** `app/app/services/scan/worker-core.server.ts:34-38`. **Verified via:** `EXPLAIN QUERY PLAN SELECT * FROM Scan WHERE status='QUEUED' ORDER BY createdAt ASC LIMIT 1;` → `SCAN Scan` + `USE TEMP B-TREE FOR ORDER BY` (no usable index; `Scan_shopId_status_idx`'s leading column is `shopId`, which this query never filters on).

**Consequence:** every worker poll cycle, for the lifetime of the app, reads every row ever written to `Scan` across every shop that has ever used the app — not just currently-queued rows. `Scan` rows are never deleted except by GDPR redact. Cost grows monotonically with total historical scan volume, with no corresponding growth in actual queued work.

**Why it's ranked #1:** it's invisible today (14 rows measured — microseconds) and guaranteed to degrade as adoption grows, with nothing that would alert anyone until worker poll latency is visibly bad. Every other finding in this audit is either already bounded, already mitigated, or already accepted on paper — this one is neither bounded nor accepted, just unnoticed.

**The fix, precisely:** a partial index — `CREATE INDEX ... ON Scan(createdAt) WHERE status = 'QUEUED'` — turns this into a search over just the currently-queued rows (typically 0-1, given the one-active-scan-per-shop invariant), independent of total historical row count. → full walkthrough in `04-query-planning-and-execution.md`.

### 2. No WAL mode, no `busy_timeout`, one file shared by two live processes

**Verified:** `PRAGMA journal_mode` on `app/prisma/dev.sqlite` returns `delete` (the default rollback journal), not `wal`. Grepped across `schema.prisma`, `db.server.ts`, `.env`, `fly.toml` — no `journal_mode` or `busy_timeout` pragma set anywhere, and no connection-string query params on `DATABASE_URL`.

**Consequence:** SQLite's rollback-journal mode takes a whole-file exclusive lock for the duration of any write, and with no `busy_timeout` configured, a lock contention hits `SQLITE_BUSY` fast rather than waiting — both the web process and the worker process independently embed the same file (`app/fly.toml:1-8`'s comment names this topology directly). A merchant polling scan progress at the exact moment the worker's `$transaction` (05) is mid-commit could, in principle, hit a busy-database error.

**Why it's ranked #2, not #1:** writes are short (one batch transaction per completed scan) and infrequent relative to reads, so collision probability is low in practice — this is a latent risk, not an active one, and it degrades gracefully (an occasional retry-worthy error) rather than silently, unlike #1.

**The fix, precisely:** `PRAGMA journal_mode=WAL` (a one-line change, no schema migration) would let readers and the writer proceed concurrently — see `06` and `07` for exactly what that trades away (still only one writer, ever) and what it buys (readers never block on it).

### 3. `enqueueScan`'s active-scan check is a documented, accepted TOCTOU race

**File:line:** `app/app/services/scan/queue.server.ts:54-68`, comment included in the code itself.

**Consequence:** two concurrent requests for the same shop could both observe "no active scan" and both create a `QUEUED` row, producing a duplicate scan for one shop.

**Why it's ranked #3, not higher:** this is the one finding in this audit the codebase has already reasoned about explicitly and in writing — the comment names the race, why it's accepted (single worker process, requests serialize in practice), and the exact database-level fix (a partial unique index on non-terminal `Scan` rows per shop) that would close it if it ever became a real problem. A named, understood risk with a clear fix on file is a fundamentally lower-priority item than #1 and #2, which nobody had flagged before this audit.

**The fix, precisely, already in the code's own comment:** a partial unique index — `CREATE UNIQUE INDEX ... ON Scan(shopId) WHERE status NOT IN ('COMPLETED','FAILED')` — moves the guarantee from application logic into a constraint SQLite itself enforces. → full walkthrough in `05-transactions-isolation-and-anomalies.md`.

### 4. `Session` has no index on `shop`, the column every authenticated request looks it up by

**Verified:** `PRAGMA index_list(Session)` on `app/prisma/dev.sqlite` returns only `sqlite_autoindex_Session_1` (the primary key on `id`) — no index on `shop`.

**Consequence:** every session lookup by shop domain (via `@shopify/shopify-app-session-storage-prisma`) is a full scan of the `Session` table.

**Why it's ranked #4, near the bottom:** `Session` has one row per installed shop — at any realistic scale for this app (a Shopify app installed by individual merchants, not millions of concurrent sessions), a full scan of that table costs nothing measurable. This is a real gap, but unlike #1 it doesn't grow with an unbounded, ever-accumulating history — it grows with active install count, which is a much smaller number and the app's actual growth metric to watch, not a silent multiplier.

**The fix, precisely:** add `@@index([shop])` to the `Session` model in `schema.prisma`; low cost, low urgency, worth doing the next time that model is touched for any other reason.

### 5. Single-node durability with no continuous replication — accepted, in writing, twice over

**Evidence:** `app/DEPLOY.md`'s "Known caveats" section states plainly that a lost volume means lost data, names Litestream as the alternative, and says it's "not implemented here." The project's own decision record independently confirms: "Litestream backups intentionally skipped (data is regenerable; volume has daily snapshots)."

**Consequence:** any write between the last Fly volume snapshot and a volume loss is unrecoverable.

**Why it's ranked #5, last:** this is the most severe *category* of risk in the whole audit (total data loss, not "slower" or "occasionally busy") — but it's ranked last because it's the most thoroughly reasoned-about and explicitly accepted finding in this entire guide, stated in two independent places, with the actual justification (data is regenerable — a merchant re-runs the scan) named rather than assumed. A well-understood, deliberately-accepted risk with a clear scope (scan/finding data only, not session tokens or shop identity) belongs at the bottom of a ranked list even though its worst case is the most severe — the ranking here is about what needs *attention*, and this finding already got it.

## Primary diagram

```
  Every finding, ranked by "needs attention" — not by worst-case severity alone

  #1  claimAndRunNext full table scan         UNBOUNDED, growing, UNNOTICED       ← act on this
  #2  no WAL / no busy_timeout                latent, low-frequency today
  #3  enqueueScan TOCTOU race                 documented + accepted + fix named
  #4  Session.shop has no index               bounded by install count, cheap
  #5  no replication / single-volume loss     most severe outcome, but reasoned
                                                 about twice over, in writing

  the axis that sorts this list: not "how bad IF it happens" alone,
  but "how bad, times how likely, times how much attention has it
  already gotten" — #1 wins because it's bad AND growing AND invisible
```

## Elaborate

A red-flags audit that just lists every imperfection flat, unranked, teaches nothing — the entire value is in the ranking discipline: distinguishing "this will hurt eventually and nobody's watching for it" (#1) from "this could hurt today under an edge case, but rarely" (#2) from "this is already understood, already scoped, already has a named fix waiting for the day it matters" (#3, #5). Every one of these five findings was verified against real evidence in this repo — `EXPLAIN QUERY PLAN` output, `PRAGMA` results, and the codebase's own comments — not inferred from best-practice checklists divorced from what this app actually does.

## Interview defense

**Q: "If you had one hour to spend hardening this app's database layer, what would you do?"**
A: Add the partial index on `Scan(createdAt) WHERE status='QUEUED'` — it's the one finding here that's both invisible today and guaranteed to get worse, with zero downside to fixing it immediately (a single `CREATE INDEX` migration, no application code change).

**Q: "Which of these findings would you NOT prioritize fixing, and why?"**
A: The single-node durability gap (#5) — not because it's low-severity (it's the highest-severity outcome in the whole list, total data loss), but because the team already reasoned through it explicitly, twice, and the justification (scan data is regenerable) is sound for this specific data. Spending effort there means paying Litestream's operational complexity for a risk the team has already correctly decided to accept.

```
  severity alone would rank #5 first — but "already reasoned about,
  in writing, with a sound justification" moves it to last
```

## See also

- `00-overview.md` — the reading order and `not yet exercised` list this audit assumes.
- `study-system-design` — for the broader "should this app even still be on SQLite" question, one level up from any single finding here.
