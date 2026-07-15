# Error Recovery

**Agent error recovery (reflect-on-failure, retry-with-a-different-action) vs. deterministic application error handling — Industry standard, split precisely against Project-specific**

## Zoom out, then zoom in

```
Zoom out — where real error handling sits in MerchGrid, and where agent
error recovery is absent

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app.scans.$id.tsx reads Scan.status — sees FAILED + safe message │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  runner.server.ts: runScan()                                       │
│  ★ REAL: one try/catch around the whole pipeline, atomic           │
│    $transaction, generic safe FAILED message ★                     │
│  ★ ABSENT: nothing observes a failure and reasons about a          │
│    DIFFERENT next action — this is deterministic containment,      │
│    not agent-style recovery ★                                       │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Network boundary — Shopify Admin GraphQL ────────────────────────┐
│  catalog-reader.server.ts: runQuery() — REAL exponential-backoff   │
│  retry on THROTTLED errors, same query resent, fixed strategy      │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Scan.status, Scan.failureCode, Scan.failureMessageSafe             │
└───────────────────────────────────────────────────────────────────┘
```

This is the other file, alongside `02-tool-calling.md`, where this repo has real code worth reading closely — but the honest lesson here is a distinction, not a discovery: MerchGrid's error handling is real, careful, and worth studying, and none of it is agent error recovery. This file teaches the general agent-error-recovery pattern, then walks the real code and draws the line precisely.

## Structure pass

**Layers:** Service (`runner.server.ts`'s pipeline) → Network boundary (`catalog-reader.server.ts`'s Shopify Admin GraphQL calls) → Storage (Prisma).

**Axis to trace: failure — where does it originate, how does it propagate, where does it get contained, and does anything ever *change strategy* in response to it?** At the network boundary: a throttled or transient GraphQL error originates, and `runQuery` (`catalog-reader.server.ts` lines 200-241) retries the *same* query with backoff — failure is contained by waiting and repeating, not by reasoning about what to try differently. At the service boundary: any error that survives those retries (or originates elsewhere in the pipeline — a missing settings row, a Prisma failure) propagates up to one `try/catch` wrapping the entire pipeline in `runScan` (lines 85-224), which contains it by marking the scan `FAILED` with a generic message and stopping — never by trying a different approach.

**Seam:** the `try/catch` boundary in `runScan` is the one real, load-bearing seam for failure containment in this codebase — everything upstream of it (reads, normalization, checks) can throw freely, trusting that boundary to catch it, log it in full detail server-side, and translate it into a safe, non-leaking status. Trace the axis across that seam and the answer doesn't flip from "code decides" to "model decides" — it stays code on both sides. That's the fact this file is teaching you to state precisely: a real, careful containment seam is not the same thing as a recovery loop, and this repo has the former without the latter.

## How it works

### Move 1 — the mental model

You've written a `fetch()` wrapped in `try/catch` that logs the error and shows a generic "something went wrong" toast. That's deterministic error *containment* — the mechanism this file's "In this codebase" sections are grounded in. Agent error *recovery* is a different, larger idea: instead of just catching and reporting, something reasons about *why* the action failed and picks a different action to try next, the same way a person debugging at a REPL doesn't just see an error and give up — they read the error message and try something else informed by it.

```
Pattern — two shapes of "handle the failure," side by side

  Deterministic containment (what a try/catch gives you)

    try:
      doThing()
    catch (err):
      log(err)                    // full detail, server-side only
      setStatus(FAILED, safeMsg)   // one fixed outcome, always
    // execution STOPS here — no alternate path is ever chosen

  Agent error recovery (a reasoning loop's response to failure)

    result = tool.run(action)
    if result.isFailure:
      diagnosis = model.reason("why did this fail?", result)
      newAction = model.decide(diagnosis)   // a DIFFERENT action,
                                              // chosen based on the
                                              // failure's content
      retry with newAction                  // loop continues
```

The underlying strategy in one sentence: containment answers "how do I stop this failure from corrupting anything and tell the caller safely" — recovery answers "given that this specific thing failed, what should I try instead" — and a system can have excellent containment with zero recovery, which is exactly MerchGrid's situation.

### Move 2 — the step-by-step walkthrough

**Part 1 — the real retry that exists, and exactly what kind it is.** `readCatalog`'s underlying `runQuery` (`app/app/services/shopify/catalog-reader.server.ts` lines 200-241) does retry — genuinely, with exponential backoff. `resolveRetryPolicy` (lines 168-173) defaults to 4 additional attempts (`DEFAULT_MAX_RETRIES`, line 160) beyond the initial call, and `computeRetryDelayMs` (lines 176-184) computes a jittered exponential delay: `500ms * 2^attempt`, capped at 8000ms, randomized to `[capped/2, capped]` to avoid synchronized retry storms. It fires on two conditions only: a rejected `admin.graphql(...)` promise (a network blip), or a well-formed GraphQL error body where `extensions.code === "THROTTLED"` (`isThrottledErrorBody`, lines 192-198). Any other GraphQL error — an unknown field, a bad argument — throws immediately, no retry. Here's the load-bearing fact: **every retry resends the exact same query with the exact same arguments; only the delay before resending changes.** Nothing about *what* is being asked changes based on *why* the previous attempt failed — the "diagnosis" is a one-bit check (`is this THROTTLED or not?`), not reasoning about the failure's content.

**Part 2 — the containment boundary, read line by line.** `runScan` (`app/app/services/scan/runner.server.ts` lines 85-224) wraps its entire pipeline — from loading the shop's settings through the final persist — in one `try`:

```typescript
// runner.server.ts lines 208-224 — the ENTIRE recovery strategy, for any failure
} catch (err) {
  // Log the real error server-side only — never expose internals
  // (query text, stack traces, upstream error text) to the scan record
  // or, transitively, to end users
  console.error(`[scan:${scanId}] scan run failed`, err);

  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      failureCode: "SCAN_FAILED",
      failureMessageSafe: GENERIC_FAILURE_MESSAGE,
    },
  });
}
```

There is exactly one outcome from this `catch`, regardless of whether the underlying error was a missing `ShopSettings` row (line 91-93's own explicit throw), a Prisma connection error, or a `readCatalog` call that exhausted its 4 retries against persistent throttling. Nothing here inspects *which* of those it was and picks a different next step — every failure, no matter its cause, becomes the same `FAILED` status with the same `GENERIC_FAILURE_MESSAGE` (line 11-12). That uniformity is a deliberate simplicity, not an oversight: it's also exactly why this is containment and not recovery — a recovery system would need to distinguish these cases to choose different next actions, and this one never does.

**Part 3 — the atomicity guarantee, a third and distinct kind of robustness.** The success path's `$transaction` (`runner.server.ts` lines 187-207) bundles deleting stale findings, inserting fresh ones, and marking the scan `COMPLETED` into one atomic unit — so a crash *partway through persisting* can never leave a scan `COMPLETED` with stale or missing findings. This is worth naming as a *third* category, separate from both the retry in Part 1 and the containment in Part 2: atomicity is about consistency under a crash mid-write, not about responding to a failure by trying something else. All three — retry-with-backoff, catch-and-contain, atomic-transaction — are real, correct engineering, and none of them is a model observing a failure and reasoning about an alternative action.

**In this codebase — the precise line, stated plainly:** the real error handling here (`runQuery`'s backoff retry, `runScan`'s catch-all containment, the atomic `$transaction`) is deterministic application error handling — every branch is a fixed rule (`if THROTTLED, wait and resend the same call`; `if anything else throws, log and mark FAILED`), decided by code, with no model anywhere observing a failure and choosing a *different* action in response. Agent error recovery — a loop that reflects on *why* a tool call failed and picks a genuinely different next step — does not exist anywhere in this codebase, because there's no agent loop for it to live inside (see `01-agents-vs-chains.md`, `03-react-pattern.md`). Calling `runScan`'s `try/catch` "error recovery" in the agent sense would blur a real and useful distinction: this code recovers the *system* (a clean, safe, terminal state) without ever recovering the *task* (finding an alternate way to complete the scan that failed).

### Move 3 — the principle

Deterministic error handling and agent error recovery solve different problems and shouldn't be graded on the same scale. Containment's job is to guarantee a bounded, safe, honest outcome no matter what went wrong — and a system that does this well (fixed retry policy for a known-transient condition, one containment boundary, atomic writes) doesn't need a model in the loop to do it correctly; adding one would only introduce nondeterminism into a job that's better served by a rule. Recovery's job — trying a genuinely different action based on reasoning about a specific failure — is only valuable when the space of "different things to try" is itself something you couldn't enumerate in advance, which is precisely the same escalation test `01-agents-vs-chains.md` applies to chains vs. agents in general. MerchGrid's failures are all enumerable in advance (network blip, throttling, missing config, a downstream write error), so a fixed rule per failure type is not a lesser version of recovery — it's the correct tool for a fully specifiable failure space.

## Primary diagram

```
Primary diagram — three real robustness mechanisms, and the recovery loop
that doesn't exist

┌─ REAL: retry-with-backoff (network boundary) ─────────────────────┐
│  runQuery() — catalog-reader.server.ts lines 200-241               │
│  THROTTLED or network error → same query, exponential backoff,     │
│  up to 4 extra attempts (DEFAULT_MAX_RETRIES, line 160)             │
└─────────────────────────────┬────────────────────────────────────────┘
                              │  exhausted retries, or any other error
                              ▼
┌─ REAL: catch-all containment (service boundary) ──────────────────┐
│  runScan()'s try/catch — runner.server.ts lines 85-224              │
│  ANY failure → log full detail server-side → ONE fixed outcome:    │
│  status=FAILED, failureMessageSafe=GENERIC_FAILURE_MESSAGE          │
└─────────────────────────────┬────────────────────────────────────────┘
                              │  (success path only)
                              ▼
┌─ REAL: atomic transaction (storage boundary) ─────────────────────┐
│  $transaction — runner.server.ts lines 187-207                      │
│  delete stale findings + insert fresh + mark COMPLETED, all-or-none │
└─────────────────────────────────────────────────────────────────────┘

             ✗ NOT PRESENT anywhere above: a loop that OBSERVES a
               failure's specific content and CHOOSES A DIFFERENT
               ACTION based on reasoning about it. That's agent
               error recovery — it needs an agent loop to live in
               (see 01-agents-vs-chains.md), and none exists here.
```

## Elaborate

The "retry the same action with backoff" pattern predates agents entirely — it's decades-old distributed-systems practice for handling transient failures against an unreliable network, and `runQuery`'s implementation here (exponential backoff, capped, jittered) is textbook correct regardless of whether any AI is involved anywhere in the system. Agent error recovery is a genuinely newer idea, born from the observation that when an *agent* — not a human — is the one issuing tool calls, a failed call shouldn't just be retried blindly; the agent can read the error message (the same way a human debugging at a REPL would) and choose a materially different next action — a different tool, different arguments, or a decision to ask a human for help instead of looping forever. Frameworks that implement this (self-healing agent loops, "Reflexion"-style self-critique) add a reasoning step between "observed a failure" and "chose the next action" that a plain retry loop skips entirely. The interesting design question those frameworks have to answer that a fixed retry policy doesn't: how do you stop an agent that keeps "trying something different" from spinning forever on an unrecoverable failure, burning tokens the whole time? The honest answer, in every serious implementation, is the same hard budget this guide's `03-react-pattern.md` names for any agent loop — recovery loops need a termination guarantee independent of whether the model *believes* it's making progress.

## Project exercises

### Simulate an agent's error-recovery loop around a blocked Bulk AI proposal

- **Exercise ID:** EX-1
- **What to build:** A standalone script simulating the one place in MerchGrid's own roadmap where agent error recovery would matter: a proposed changeset that `runChecks(ALL_CHECKS, ctx)` blocks with a `CRITICAL` finding. Write a stub "model" that reads the returned `CatalogFinding[]`, and — instead of just failing — picks a *different* proposed changeset (e.g., a smaller price change that wouldn't trip the same check) and re-submits it to `runChecks`, up to a hard step budget.
- **Why it earns its place:** This is the only exercise in this file that actually builds the thing this file spends most of its words distinguishing from what's real — you'll feel exactly how much more machinery "try something different based on why it failed" needs compared to the retry-with-backoff and catch-all patterns already in this codebase.
- **Files to touch:** New scratch file, e.g. `app/scripts/toy-error-recovery-loop.ts`; imports `ALL_CHECKS`/`runChecks` from `@merchgrid/catalog-checks`.
- **Done when:** The script demonstrates at least one iteration where a `CRITICAL` finding causes the stub to choose a genuinely different next changeset (not just retry the same one), and a hard step budget that stops the loop if no changeset ever clears.
- **Estimated effort:** 1-2 hours.

### Trace every failure path in `runScan` and classify it

- **Exercise ID:** EX-2
- **What to build:** A written trace (a scratch note, or inline comments in a local, uncommitted branch) listing every place `runScan` (`app/app/services/scan/runner.server.ts` lines 59-225) can throw or fail — the missing-`ShopSettings` check (lines 91-93), a `readCatalog` call exhausting its retries, a Prisma error during any `update` or the `$transaction` — and classify each as "contained by the catch-all" vs. "would need a different outcome to be useful" (i.e., where would per-failure-type handling actually add value, if any).
- **Why it earns its place:** This is the fastest way to confirm, from the real code rather than from memory, that MerchGrid's uniform `FAILED` outcome really is a deliberate simplicity and not a place where richer handling is silently needed — or to find a specific spot where it is.
- **Files to touch:** No production files — a scratch note or local comments.
- **Done when:** You can list every distinct failure origin in `runScan` and state, for each, why the current uniform `FAILED` outcome is (or isn't) the right level of granularity.
- **Estimated effort:** 30-45 minutes.

## Interview defense

**Q: Is the `try/catch` in `runScan`, or the `$transaction`, an example of agent error recovery?**
A: No. Both are real, correct deterministic error handling — the `try/catch` (`runner.server.ts` lines 85-224) catches any failure and produces exactly one fixed outcome (`FAILED` + a generic safe message), and the `$transaction` (lines 187-207) guarantees atomicity on the success path. Agent error recovery means something reasons about *why* a specific action failed and chooses a genuinely different next action — nothing here does that; every failure, regardless of cause, gets the same treatment.
*Sketch while you say it:* the primary diagram's three real boxes stacked above the "✗ NOT PRESENT" callout.

**Q: Doesn't the retry logic in `catalog-reader.server.ts` count as recovery, since it retries after a failure?**
A: It's retry, not recovery — a meaningful distinction. `runQuery` (lines 200-241) resends the *exact same* query on a `THROTTLED` error, with only the backoff delay changing; it never reasons about the failure's content beyond a one-bit "is this throttling or not" check, and it never tries a *different* query or strategy. Real agent error recovery would need to inspect the failure and choose something materially different to try next — this is a fixed rule for a known, enumerable transient condition.
*Sketch while you say it:* the Move 1 pattern diagram's two code blocks side by side — same-action retry vs. different-action recovery.

**Q: If MerchGrid ever needed agent error recovery, where would it show up?**
A: In the roadmapped Bulk AI product's approval loop (spec §25.4), not in the audit pipeline that exists today — if a proposed changeset trips a `CRITICAL` finding from `runChecks`, a genuinely agentic system would reason about *why* (which check fired, on which field) and propose a *different* changeset instead of just failing, bounded by a hard retry budget so it can't loop forever on an unfixable case. That's a real design requirement for an unbuilt feature, not a description of anything in this repo today.
*Sketch while you say it:* the Elaborate section's "reflect on failure, pick a different action" loop, with `runChecks` as the failing tool call.

## See also

- `02-tool-calling.md` — the same real-vs-not-real discipline applied to the tool contract instead of failure handling; read together, these two files are the pair with the richest grounding in this guide.
- `01-agents-vs-chains.md` — why a fixed, enumerable failure space favors deterministic handling over a reasoning loop.
- `03-react-pattern.md` — the hard iteration budget an agent recovery loop needs, named there for the general reasoning loop and here for the recovery-specific version of the same problem.
- `app/app/services/shopify/catalog-reader.server.ts` lines 160-241 — the real retry-with-backoff implementation this file grounds Part 1 in.
- `app/app/services/scan/runner.server.ts` lines 59-225 — the real containment boundary this file grounds Part 2 in.
