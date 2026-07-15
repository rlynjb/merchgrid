# Study — Testing & Correctness: MerchGrid Catalog Audit

## The through-line

The question this guide keeps asking of every file it opens is the same one
you should ask of any suite: **how do you know the code works, and will keep
working after the next change?** A green checkmark is not the answer — a
suite that asserts nothing meaningful is decoration wearing a passing badge.
The answer this repo gives, lens by lens, is in `audit.md`.

## The deterministic-vs-eval seam, stated up front

MerchGrid Catalog Audit is a **deterministic** system end to end — 10 rule
checks (`MG-001`…`MG-010`) over normalized Shopify catalog data, no model in
the loop (`.aipe/project/context.md`: *"Deterministic, not AI... do not add
LLM/AI to the first app"*). That single fact reshapes this whole guide:

```
  The seam this repo sits on

  study-testing          "given known input, assert known output"   ← YOU ARE HERE
  (this guide)           unit / integration / property — everything
                         in this repo lives here

  study-ai-engineering   "is the output good enough / did it regress"
                         evals, LLM-as-judge — NOT APPLICABLE, no model
                         output exists anywhere in this codebase
```

Lens 6 of `audit.md` (`testing-ai-features`) is marked `not yet exercised`
for exactly this reason — there is no non-deterministic core to wrap a
harness around. That's not a gap; it's the correct verdict for a repo whose
entire value proposition is "explainable, deterministic, no black box."

The one place this guide borrows *eval vocabulary* without crossing the
seam is `01-golden-set-regression-eval.md` — a golden-set fixture table with
independently-specified expected outputs, mutation-verified. It reads like
an eval (fixture-driven, table-based) but every assertion is "equals this
exact value" against fully deterministic code — it is testing, not
evaluation. See that file for why the distinction matters here.

## Reading order

1. **`00-overview.md`** — the coverage map at a glance, the three
   highest-leverage gaps, one-line verdict per lens.
2. **`audit.md`** — Pass 1, the full 7-lens walk. Read this straight through
   once; it's the spine everything else hangs off.
3. **`01`–`06`** — Pass 2, the testing techniques this repo actually
   exercises deliberately, each worth learning as a transferable pattern:

   - `01-golden-set-regression-eval.md` — the standout: an
     independently-specified fixture table run through the real
     `normalize → runChecks` seam, designed to fail loudly if a check's
     behavior silently drifts.
   - `02-sqlite-integration-test-harness.md` — real Prisma against a
     dedicated, wiped-per-test SQLite file instead of a mocked ORM.
   - `03-fake-admin-graphql-seam.md` — a hand-rolled fake standing in for
     the Shopify Admin GraphQL client, built to drive retry/pagination/
     truncation logic no real API call would let you trigger on demand.
   - `04-tenant-isolation-authz-tests.md` — tests that assert what a
     wrong-tenant caller does *not* learn, not just what a right-tenant
     caller gets.
   - `05-exhaustive-state-transition-matrix.md` — the scan pipeline's state
     machine tested as a closed combinatorial matrix, not a handful of
     happy-path transitions.
   - `06-decimal-money-precision-tests.md` — tests that exist specifically
     to catch the one bug class this domain cannot tolerate: float drift in
     a margin calculation.

Each pattern file cross-links back to the `audit.md` lens it deepens. Start
with `00-overview.md` if you want the fast version; start with `audit.md` if
you want the full walk.
