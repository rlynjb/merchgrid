# Heuristic Before LLM

**Heuristic-first routing (rule-based short-circuit before a model call) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where MerchGrid's real heuristic layer sits

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app.scans.$id.tsx renders CatalogFinding rows                │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/scan/runner.server.ts ───────┐
│  reads catalog → normalizes → calls runChecks(ALL_CHECKS, ctx)   │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks/src/ ───────────────────────────┐
│  ★ THIS IS THE HEURISTIC LAYER — real, complete, standalone ★             │
│  run.ts: runChecks() → flatMap over ALL_CHECKS (10 rules, mg-001..mg-010)  │
│  contract.ts: CatalogCheck / CatalogCheckContext / CatalogFinding           │
│                                                                              │
│  there is NO branch anywhere that falls through to an LLM — the             │
│  heuristic side is the entire engine, by deliberate product decision         │
└─────────────────────────┬───────────────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ───────────────────────────────────────┐
│  Finding rows persisted straight from the heuristic engine's output       │
└─────────────────────────────────────────────────────────────────────┘
```

This is the one file in this sub-section where MerchGrid's own code *is* the primary example, not a hypothetical. The pattern this file teaches — run a cheap, deterministic rule first, and only reach for an expensive, probabilistic model when the rule can't decide — is real and important industry practice. What's unusual about MerchGrid is that it's a case where the heuristic side is fully built, fully standalone, and the "else, call an LLM" branch was never written at all, on purpose. That's worth understanding precisely, because it's a different claim from "this app uses a hybrid heuristic+LLM system" — it doesn't, and being exact about that distinction is itself a signal you understand the pattern rather than reaching for buzzwords.

## Structure pass

**Layers:** the pattern, where it exists in industry systems, sits as a **routing decision** at the entry to whatever handles a unit of work — before it reaches either a rule engine or a model call. MerchGrid's engine layer (`packages/catalog-checks`) is where that routing decision *would* live if it existed.

**Axis: control — who decides the final answer, and how expensive was the decision?** Trace the general pattern across two branches: the heuristic branch, a fixed rule evaluates in microseconds, for free, with a guaranteed-reproducible answer; the LLM branch, a model call takes hundreds of milliseconds to seconds, costs real money per call (`06-token-economics.md`), and returns a probabilistic answer that can vary run to run (`03-sampling-parameters.md`). Now trace MerchGrid's real engine: every one of its 10 checks resolves in the heuristic branch, every time, because the LLM branch doesn't exist in this codebase. There's no "route to a model when the rule doesn't know" step, because a model was never wired in to route to.

**Seam:** in a system that has both branches, the seam is the routing condition itself — "does the heuristic have enough confidence to answer, or does this fall through to the model?" — plus the contract both branches must satisfy so the caller can't tell which one answered. MerchGrid has built exactly that shared contract (`CatalogCheck`/`CatalogFinding` in `contract.ts`) but only one implementation of it — the deterministic side. The product spec is explicit that this is deliberate groundwork for a second implementation later (§27: "Design the check engine as a reusable package for the future MerchGrid: Bulk AI product"), not an accident of scope.

## How it works

### Move 1 — the mental model

You've written an early-return guard clause: check the cheap, obvious case first, and only fall through to the expensive path if the guard doesn't resolve it. Heuristic-before-LLM is that same guard-clause instinct applied to an entire request: try the cheap, deterministic answer first; only pay for a model call when the rule genuinely can't decide.

```
Pattern — heuristic-first routing (the general shape, industry-wide)

  request arrives
        │
        ▼
  ┌───────────────────┐
  │  heuristic check    │  cheap, fast, deterministic, free
  │  (regex, rule,       │
  │  lookup table)        │
  └─────────┬─────────────┘
            │
     matched? ──yes──► return heuristic's answer (done, no model call)
            │
            no
            │
            ▼
  ┌───────────────────┐
  │  LLM fallback        │  expensive, slower, probabilistic, costs money
  └─────────┬─────────────┘
            │
            ▼
     return model's answer
```

### Move 2 variant — the load-bearing skeleton

This pattern has a real kernel, so it's worth isolating it rather than walking a flat list of parts.

**Isolate the kernel.** The smallest version of this pattern that's still recognizably "heuristic-before-LLM" has exactly three parts: (1) a fast-path check that can return a confident answer or explicitly decline, (2) a fallback that only runs when the fast path declined, and (3) a shared output contract so the caller never needs to know which path answered. Drop any one of these and it stops being this pattern.

**Name each part by what breaks when it's missing.**
- Drop the fast-path check entirely and you're just calling an LLM for everything — you lose the cost savings and determinism guarantees the whole pattern exists to buy.
- Drop the "explicitly decline" signal (i.e., the fast path silently returns a guess instead of admitting uncertainty) and the fallback never triggers when it should — you get confident-looking wrong answers from the cheap path instead of a considered answer from the expensive one.
- Drop the shared output contract and the caller has to special-case which path answered, which defeats the entire point of making the routing decision invisible to callers.

**Separate skeleton from optional hardening.** The three-part kernel above is the minimum. Real systems add hardening on top: caching fallback answers so a repeated question doesn't re-pay for a model call, logging which path answered so you can measure "coverage" (what fraction of traffic the heuristic resolves without ever touching the model — a genuinely important cost and latency metric), and tuning the heuristic's confidence threshold over time as you learn where it under- or over-triggers. None of that hardening is required to have the pattern; all of it is common in production.

### Move 2 — this codebase's real heuristic layer

**Use case: a merchant clicks "Start scan."** `runScan` in `app/app/services/scan/runner.server.ts` reads the catalog, normalizes it, and calls `runChecks(ALL_CHECKS, ctx)` (line 130). That single call *is* the entire decision-making layer for every finding MerchGrid produces — there's no second call, no fallback branch, nothing downstream of it that could override or supplement its answer with a model's judgment.

**The contract both branches of a real hybrid system would share — here, the only branch that exists.** `app/packages/catalog-checks/src/contract.ts` (lines 1-32) defines exactly the seam a hybrid system needs:

```typescript
export interface CatalogCheckContext {
  variants: NormalizedVariant[];
  settings: { minimumMarginPercent: number };
  now: string; // ISO 8601 detectedAt, injected so checks are deterministic
}

export interface CatalogFinding {
  id: string;
  checkId: string;
  severity: FindingSeverity;
  // ...evidence, explanation, productTitle, adminUrl, detectedAt
}

export interface CatalogCheck {
  id: string;
  name: string;
  description: string;
  run(ctx: CatalogCheckContext): CatalogFinding[];
}
```

Read this the way you'd read an interface meant for two implementations: `CatalogCheck.run(ctx): CatalogFinding[]` is a synchronous, pure function signature — nothing about it *forbids* a second implementation of `CatalogCheck` that calls an LLM instead of comparing decimals (aside from the signature being synchronous, which an LLM-backed check would need to work around — see the "In this codebase" note below). But there's exactly one family of implementations today: `mg001` through `mg010`.

**The kernel, concretely: `runChecks` has no routing decision in it at all.** `app/packages/catalog-checks/src/run.ts` (lines 26-28):

```typescript
export function runChecks(checks: CatalogCheck[], ctx: CatalogCheckContext): CatalogFinding[] {
  return checks.flatMap((c) => c.run(ctx));
}
```

Annotate this line by line against the pattern's kernel: there is no `if (heuristicDeclined) { callLLM() }` anywhere in this function or anywhere it's called from — it's a one-line `flatMap`, every check always runs, every check always returns a definite answer (an empty array if nothing's wrong, never an "I'm not sure, ask a model" signal). Compare that to the general pattern's kernel (fast path, explicit decline, fallback) and you can see precisely what's absent: **there is no decline case in this codebase.** Every one of the 10 checks (`mg-001.ts` through `mg-010.ts`) is written to always produce a confident, final verdict per variant it examines — `mg003.ts`'s margin check either flags a variant or it doesn't; it never returns "uncertain, escalate this." That's not a limitation of the current 10 checks specifically — it's the product's whole design stance, and it's why "heuristic coverage" (the metric real hybrid systems track — what fraction of cases the fast path resolves) isn't a metric that exists here: coverage is 100% by construction, because there's nothing else to route to.

```
Pattern — MerchGrid's real routing decision (there isn't one)

  a merchant's catalog arrives (CatalogCheckContext)
        │
        ▼
  ┌────────────────────────────────────────┐
  │  runChecks(ALL_CHECKS, ctx)               │   ALWAYS this path.
  │  10 deterministic rules, flatMap,          │   100% heuristic.
  │  every check returns a final verdict        │   0% LLM.
  └─────────────────┬────────────────────────┘   No decline case exists
                    │                              to route away from.
                    ▼
              CatalogFinding[]  (final, no escalation possible)
```

**Why the product spec made this call, in its own words.** Section 2.1 lists "Deterministic: Findings come from explicit validation rules rather than an LLM" as a reason MerchGrid: Catalog Audit was chosen to ship *before* the more ambitious bulk-AI product — a "favorable learning-to-risk ratio," in the spec's phrasing. Section 27's build decision is blunter: "Use deterministic checks rather than AI." And section 23.3 explains the risk this avoids: false positives on financial/pricing correctness checks erode merchant trust fast, and the mitigation is "conservative rules, severity distinctions, clear evidence" — not a model's judgment call that can't be fully explained or guaranteed reproducible. For a product whose entire acceptance criteria (§21.3) is "for a controlled test catalog, the system correctly detects [these 10 specific conditions]," a heuristic that's *complete* — every relevant case has a hand-written rule — beats a heuristic that only needs to cover the easy 80% because a model handles the rest. There was no "long tail" here that a fallback needed to absorb; ten rules cover the entire MVP's scope by design.

**Where the seam this contract was built for actually gets used — not by an LLM feeding checks, but by checks preflighting an LLM.** This is the detail worth being precise about, because it's easy to get backwards: the product spec's future integration (§25.4, §27) does **not** have the check engine calling an LLM, and does **not** have an LLM feeding results into the checks as a first pass with checks as fallback. It's the reverse role from the classic pattern: the heuristic engine (`runChecks`/`ALL_CHECKS`) becomes a **preflight validator sitting downstream of a future LLM's proposed changesets**, not an upstream router deciding whether to call one. Spec §25.4's table names it directly: "Check engine → Preflight every proposed edit." The future flow:

```
Future flow (roadmap, not built) — checks preflight the LLM, not the reverse

  Merchant prompt or CSV
          │
          ▼
  ┌─ new: services/ai/, does not exist ─────┐
  │  LLM proposes a changeset                 │
  └───────────────┬───────────────────────────┘
                  │  proposed changeset (NormalizedVariant shape)
                  ▼
  ┌─ existing, real: packages/catalog-checks ─────────────────────┐
  │  runChecks(ALL_CHECKS, ctx)  →  CRITICAL blocks the write,       │
  │  WARNING requires merchant review — same engine, same contract,   │
  │  same 10 rules, now validating a MODEL'S output instead of a       │
  │  MERCHANT'S live catalog                                            │
  └───────────────┬───────────────────────────────────────────────────┘
                  │
                  ▼
          Merchant approval → Shopify write → post-write verification
```

**In this codebase:** the heuristic side of this pattern is fully implemented and load-bearing — `ALL_CHECKS` (`run.ts` lines 13-24) and `runChecks` (lines 26-28), backed by `mg-001.ts` through `mg-010.ts`, running against every scan today. The LLM side of the pattern — a fallback branch, a decline signal, or any routing logic at all — does not exist anywhere in this repo, and per the product spec it isn't meant to exist yet. This is not a hybrid system with one branch stubbed out; it's a single-branch system operating at what the classic pattern would call 100% heuristic coverage, 0% LLM fallback, because the product decision was to build one complete branch instead of two partial ones.

### Move 3 — the principle

Heuristic-before-LLM exists to avoid paying an expensive, probabilistic model's cost and nondeterminism for cases a cheap, deterministic rule can already answer with full confidence. The pattern assumes there's a residual long tail the rule genuinely can't cover — that's what the fallback is *for*. MerchGrid is the instructive edge case: when your entire problem is closed and enumerable (ten checks fully cover the MVP's acceptance criteria), there is no long tail to build a fallback for, and the honest engineering call is to skip the LLM branch entirely rather than build a routing decision with nothing on the other side of it.

## Primary diagram

```
Primary diagram — the general pattern, and MerchGrid's real single-branch case

  GENERAL PATTERN (industry-wide, two branches)
  ──────────────────────────────────────────────
  request → heuristic (fast, free, deterministic) → matched? → done
                                  │
                                  no match / low confidence
                                  ▼
                          LLM fallback (slow, costly, probabilistic) → done
                    (both branches satisfy the same output contract)

  MERCHGRID'S REAL ENGINE (one branch, by design)
  ──────────────────────────────────────────────
  CatalogCheckContext → runChecks(ALL_CHECKS, ctx)  [run.ts:26-28]
                              │
                    10 checks, mg-001..mg-010, every one returns
                    a FINAL verdict — no decline case, no fallback
                              │
                              ▼
                    CatalogFinding[]  — 100% heuristic, 0% LLM

  contract.ts:1-32's CatalogCheck/CatalogCheckContext/CatalogFinding IS the
  shared-contract seam the general pattern needs for two branches — this
  repo has built it, and wired exactly one implementation into it
```

## Elaborate

Heuristic-before-model routing is older than LLMs — it's the same instinct behind a spam filter that blocklists known-bad domains before running an expensive classifier, or a search autocomplete that serves a cached exact match before falling back to a ranking model. What's specific to the LLM era is the size of the cost and latency gap between the two branches (a regex is nanoseconds and free; a model call is hundreds of milliseconds and priced per token, per `06-token-economics.md`) and the fact that the fallback branch, unlike a smaller classifier, brings genuine nondeterminism with it (`03-sampling-parameters.md`). MerchGrid's product spec treats this as strategy, not just implementation detail: §2.3's "long-term product path" diagram lays out Catalog Audit (pure heuristic) → Monitor (still heuristic, adds scheduling) → Bulk AI (adds the LLM branch, with the heuristic engine now doing preflight instead of decisioning) as a deliberate sequence — ship the complete, trustworthy heuristic first, earn the right to add the probabilistic layer second.

## Project exercises

### Add a genuine "decline" case to prove the current engine has none

- **Exercise ID:** EX-1
- **What to build:** Extend `CatalogCheck` (in a local branch, not necessarily merged) with an optional `confidence: "certain" | "uncertain"` field on `CatalogFinding`, and modify one existing check (e.g. `mg-008`, the price-outlier heuristic — outlier detection is exactly the kind of check a real system might want a model's judgment on for edge cases) to emit `"uncertain"` for borderline outlier ratios instead of a flat true/false. Then write a small router in a scratch script that filters `CatalogFinding[]` for `confidence: "uncertain"` and logs what *would* be sent to an LLM fallback if one existed.
- **Why it earns its place:** Building the missing "decline" signal by hand — even as an unmerged exercise — is the fastest way to feel exactly what's absent from this codebase's real engine, and it's a defensible design you could actually propose if MerchGrid wanted to add graceful escalation before building a full LLM integration.
- **Files to touch:** `app/packages/catalog-checks/src/contract.ts` (add the field, exercise-only), `app/packages/catalog-checks/src/checks/mg-008.ts` (exercise-only modification), a new scratch script (not committed) that filters and logs uncertain findings.
- **Done when:** Running the modified `mg008` against a fixture with a borderline price ratio produces a finding tagged `"uncertain"`, and your scratch router correctly separates certain from uncertain findings.
- **Estimated effort:** 2 hours.

### Trace and diagram the real preflight seam for the future Bulk AI flow

- **Exercise ID:** EX-2
- **What to build:** A written design note (not code) proposing the concrete shape of the `app/app/services/ai/` module described in spec §25.4 — specifically, what function signature would take an LLM's proposed changeset and pass it through the existing `runChecks(ALL_CHECKS, ctx)` unchanged, and what new logic (outside the check engine) would need to interpret CRITICAL-vs-WARNING findings as "block the write" vs "require merchant review," per the spec's flow diagram.
- **Why it earns its place:** This is the single most interview-relevant artifact in this exercise set — it demonstrates you can read a real, existing typed contract (`contract.ts`) and reason precisely about how a future feature would reuse it, without inventing implementation details the spec doesn't support.
- **Files to touch:** No production files — a design note only.
- **Done when:** The note names the exact existing functions/types being reused (`runChecks`, `ALL_CHECKS`, `CatalogCheckContext`, `CatalogFinding.severity`) and the exact new pieces that don't exist yet (the changeset generator, the block/review decision logic).
- **Estimated effort:** 1 hour.

## Interview defense

**Q: Does MerchGrid use a hybrid heuristic-plus-LLM system?**
A: No — and that's a precise, important distinction, not a hedge. It's a single-branch heuristic system: `runChecks(ALL_CHECKS, ctx)` (`app/packages/catalog-checks/src/run.ts` lines 26-28) is a one-line `flatMap` over 10 deterministic rules, every one of which always returns a final verdict. There's no decline signal, no fallback, no routing decision anywhere in the pipeline. That's 100% heuristic, 0% LLM by product decision (spec §2.1, §27), not a hybrid with one branch stubbed out.

```
  hybrid system:     heuristic → (decline?) → LLM fallback → shared output
  MerchGrid's real:  heuristic → shared output          (no decline exists)
```

**Q: When would you add an LLM fallback to a heuristic system, and why hasn't MerchGrid?**
A: You add a fallback when the heuristic has a genuine long tail it can't enumerate — cases too varied or too subjective for a fixed rule to cover confidently. MerchGrid's MVP scope is the opposite: 10 rules fully cover the acceptance criteria in spec §21.3 (zero-price, below-cost, margin threshold, duplicate SKU/barcode, etc.) — there's no long tail left over to escalate. Adding a fallback branch with nothing to route to it would be complexity without a corresponding capability gain, which is exactly the kind of unjustified AI feature the product spec explicitly avoids (§17.6: don't lead with "Powered by AI" for this app).

**Q: If MerchGrid did add an LLM, would the check engine call it, or would the LLM call the check engine?**
A: Neither, precisely — the check engine doesn't call anything, and the LLM doesn't call the check engine either; the LLM's *output* flows into the check engine as input. Per spec §25.4, an LLM proposes a changeset, and the existing `runChecks(ALL_CHECKS, ctx)` preflights that proposal the same way it audits a live catalog today — CRITICAL findings block the write, WARNINGs require merchant review. The heuristic engine's role flips from "the entire decision" to "the safety gate on someone else's decision," but the code doing the gating — `contract.ts`'s `CatalogCheck`/`CatalogFinding`, `run.ts`'s `runChecks` — doesn't have to change at all. That reuse is the one-line anchor for the whole file: the contract built for a single deterministic branch turns out to be exactly the contract a future preflight-the-LLM role needs too.

## See also

- `01-what-an-llm-is.md` — why the LLM branch, if built, would be probabilistic in a way this repo's engine deliberately isn't.
- `04-structured-outputs.md` — the schema a future LLM-proposed changeset would need to satisfy before it could even reach `runChecks`.
- `08-provider-abstraction.md` — a different seam (which provider answers a call) that would sit inside the future `services/ai/` module this file only sketches the boundary of.
- `app/packages/catalog-checks/src/contract.ts` — the real, load-bearing contract this entire file is built around.
- `app/packages/catalog-checks/src/run.ts` — the real, one-line proof that no routing decision exists in this codebase today.
- `merchgrid-catalog-audit-product-spec.md` §2.1, §25.4, §27 — the product's own words for why this is a deliberate, not accidental, design.
