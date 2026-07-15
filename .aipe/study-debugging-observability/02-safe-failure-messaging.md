# Safe error boundary (log real, return generic)

**Sanitized error boundary / information-disclosure containment** —
Language-agnostic pattern, applied at three independent call sites in
this repo (`runner.server.ts`, `worker-core.server.ts`,
`catalog-reader.server.ts`) plus one deliberate non-logging case
(`webhooks.compliance.tsx`).

## Zoom out, then zoom in

Okay, picture the error's actual journey. Shopify's GraphQL API returns
a 500 with an internal trace ID and a shard number in the message body.
That string is real, useful, and dangerous — useful to you debugging
it, dangerous if a merchant ever sees it in their admin. This repo
draws the same line in three unrelated files, consistently, without a
shared helper forcing it: full detail stays server-side, one fixed
sentence crosses every trust boundary past that point.

```
  Zoom out — where the sanitization boundary sits

  ┌─ External (Shopify Admin GraphQL) ───────────────────────────────┐
  │  raw error body: query text, THROTTLED codes, 500s with internals │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  runQuery() catches, retries, or throws
  ┌─ Service layer ★ THIS CONCEPT ★ ──▼──────────────────────────────┐
  │  catalog-reader.server.ts / runner.server.ts / worker-core.server │
  │  console.error(real err)   →   operator channel (fly logs)        │
  │  fixed constant string     →   persisted / returned channel       │
  └───────────────────────────┬───────────────────────────────────────┘
                              │  failureMessageSafe
  ┌─ Storage + UI ────────────▼───────────────────────────────────────┐
  │  Scan.failureMessageSafe → rendered verbatim in a Banner           │
  └─────────────────────────────────────────────────────────────────────┘
```

This is the same instinct as wrapping a `fetch()` in `try`/`catch` and
showing the user "Something went wrong" while `console.error`-ing the
real stack trace for yourself — except here it's a house rule enforced
independently at three layers, not a one-off.

## The structure pass

**Axis: trust — what can each side see or tamper with?** Two seams
carry this axis, plus a third case that flips it in the opposite
direction:

```
  Trust axis, traced across two seams and one inversion

  seam A: Shopify ⇄ catalog-reader.server.ts
    Shopify's raw error text: NOT trusted past this point
    → collapsed to one of three fixed strings (lines 221-223, 234-236, 251-253)

  seam B: runner.server.ts's try ⇄ catch
    the real Error object: trusted only inside console.error (server-only)
    → collapsed to GENERIC_FAILURE_MESSAGE before touching the DB

  inversion: webhooks.compliance.tsx
    the payload itself (customer PII): NOT even trusted to console.log
    → the axis flips from "sanitize what you show" to "don't observe it at all"
```

**Why this seam is load-bearing**: strip it out, and the concrete
consequence is proven in this repo's own test suite —
`app/test/scan-runner.test.ts:118-120` deliberately throws
`"Shopify GraphQL 500: internal trace id abc-123, table shard 7 unreachable"`
as a realistic upstream error, specifically so the test can assert that
string never reaches `failureMessageSafe`
(`app/test/scan-runner.test.ts:263-264`). That's not a hypothetical
leak; it's a leak this codebase wrote a test to make sure never
happens.

## How it works

**Move 1 — the mental model.** Sanitize at the boundary where the
untrusted string first arrives, not at the point where it's displayed.
Concretely: the fixed message lives right next to the `catch`, not
inside the Polaris `Banner` component that renders it. If the
constant lived in the UI, every new failure path in the service layer
would have to remember to route through it; putting it at the
service-layer catch means a new failure path gets sanitization for
free just by throwing.

```
  Pattern — one raw error, two channels, sanitize once at the seam

       raw error / real Error object
                  │
                  ▼
         ┌─────────────────┐
         │  the catch block │  ← sanitization happens exactly here
         └────────┬─────────┘
        server-only │         │ persisted / returned
                    ▼         ▼
          console.error(err)   fixed constant string
          (operator channel)  (user/UI channel)
```

**Move 2 — the walkthrough.**

**Part 1 — `catalog-reader.server.ts` never lets a raw GraphQL error
escape.** Three separate throw sites collapse every upstream failure
into one of three fixed, generic strings — a rejected `admin.graphql()`
call (`app/app/services/shopify/catalog-reader.server.ts:221-223`), a
well-formed error response
(`app/app/services/shopify/catalog-reader.server.ts:234-236`), and a
malformed-but-error-free response
(`app/app/services/shopify/catalog-reader.server.ts:251-253`). What
breaks if removed: a merchant's failure banner could show query text,
schema internals, or an upstream trace ID instead of "the scan could
not be completed."

**Part 2 — `runner.server.ts`'s catch is where the same discipline
repeats one layer up.** `console.error(`[scan:${scanId}] scan run
failed`, err)` (`app/app/services/scan/runner.server.ts:213`) gets the
real `Error` object, unmodified. The very next statement persists
`failureMessageSafe: GENERIC_FAILURE_MESSAGE`
(`app/app/services/scan/runner.server.ts:11-12, 215-223`) — a constant
defined once, at module scope, never string-interpolated with anything
from `err`.

```
  Execution trace — what each channel actually receives

  channel                    receives
  ──────────────────────────  ──────────────────────────────────────
  console.error (stdout)      the real Error object: message + stack
  Scan.failureMessageSafe     "The scan could not be completed.
                               Please try again." — always this string,
                               regardless of what actually broke
  Scan.failureCode            "SCAN_FAILED" — a coarse, safe TAXONOMY
                               value, distinct from the message
```

**Part 3 — the same shape reused at the queue-claim layer.**
`worker-core.server.ts`'s poison-pill catch
(`app/app/services/scan/worker-core.server.ts:47-75`) is structurally
identical: `console.error` gets the real error including which shop
domain failed; the persisted `failureMessageSafe` is the same fixed
sentence, and `failureCode` is a *different* taxonomy value,
`"ADMIN_UNAVAILABLE"` (`worker-core.server.ts:69-71`), distinguishing
"the pipeline threw" from "we couldn't even get an admin client" —
without leaking why in either case.

**Part 4 — the inversion: sometimes safety means not observing at
all.** `webhooks.compliance.tsx` handles Shopify's mandatory GDPR
topics. Its log line is deliberately impoverished:
`` console.log(`Received compliance webhook ${topic} for ${shop}`) ``
(`app/app/routes/webhooks.compliance.tsx:10`) — topic and shop only,
never the request body. The comment right above it names why:
`CUSTOMERS_DATA_REQUEST` and `CUSTOMERS_REDACT` payloads carry customer
PII (id, email, phone) that this service has no legitimate reason to
persist even in a log file, because MerchGrid stores no customer data
in the first place (`webhooks.compliance.tsx:8-9`, confirmed by the
handler bodies at lines 13-19 doing nothing with the payload). This is
the same trust axis as Parts 1-3, but flipped: instead of "sanitize
what you observe," it's "don't observe what you don't need." Both are
the same underlying discipline — don't let a debugging convenience
become a data-exposure liability.

**Move 3 — the principle.** Every layer that can see a raw
upstream or internal error is a potential leak surface. Put the
sanitizing constant next to the `catch`, not the display component, and
ask — for every new observable field — "does this need to exist, or
just need to be sanitized?" Sometimes the answer is neither: don't
capture it.

## Primary diagram

```
  Full picture — three sanitizing seams + one non-observation case

  Shopify raw error ──► catalog-reader.server.ts ──► 1 of 3 fixed strings
                                                        │
  runner.server.ts catch ◄───────────────────────────┘
       │                              │
       ▼ console.error (real err)     ▼ failureMessageSafe (constant)
   fly logs (operator only)      Scan row → UI Banner (merchant-visible)

  worker-core.server.ts catch: same shape, different failureCode value

  webhooks.compliance.tsx: logs topic+shop ONLY — payload never touched
  (the "don't observe it" inversion of the same trust axis)
```

## Elaborate

This is the general discipline of sanitizing error output at a trust
boundary — the same reason you'd never let a raw SQL exception reach a
browser response. The tradeoff is owned, not apologized for: merchants
lose message specificity (they only ever see "the scan could not be
completed"), and that cost is deliberate given the product spec's
explicit no-internal-leakage requirement — the person who pays it is
whoever debugs the failure later, and they pay it with `fly logs`
access, not with a better error string. A `failureCode` taxonomy
(`SCAN_FAILED`, `ADMIN_UNAVAILABLE`) exists precisely so that cost is
partially recoverable: you can count and categorize incidents without
ever needing the raw message.

## Interview defense

**Q: Where exactly does the raw Shopify error text get thrown away?**
A: Three throw sites in `catalog-reader.server.ts`
(`runQuery`/`requireData`, lines 221-223, 234-236, 251-253) — every one
of them replaces the real error with one of three fixed strings before
it ever leaves that module.

```
  the discard point

  admin.graphql() rejects / returns errors / returns malformed data
                    │
                    ▼
      one of 3 fixed strings — the ORIGINAL error never leaves
      catalog-reader.server.ts as anything but a log side-effect
```

**Q: Why have two different `failureCode` values (`SCAN_FAILED` vs
`ADMIN_UNAVAILABLE`) if the message shown to the merchant is identical
either way?**
A: The message is generic on purpose, but the code doesn't have to be —
a coarse, safe taxonomy survives the message being generic, and it's
enough to let you count incident classes ("how many scans failed
because a shop uninstalled mid-flight, vs. a genuine pipeline bug")
without leaking any detail at all.

## See also

- `audit.md` §3 (structured-logs-and-correlation) and §6
  (state-snapshots-and-debugging-boundaries)
- `01-scan-state-machine-audit-trail.md` — where `failureMessageSafe`
  and `failureCode` are written, as part of the terminal state
- `03-process-supervision-and-crash-containment.md` — the same
  catch-log-continue shape, at the process and loop altitudes
