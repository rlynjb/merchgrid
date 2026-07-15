# 05 — Evals and Observability

MerchGrid: Catalog Audit is a deterministic, rule-based app — ten hand-written checks (MG-001 through MG-010), zero LLM anywhere in the request path, by deliberate product decision (product spec §2.1, §17.6, §27: "Use deterministic checks rather than AI"). That makes this sub-section unusual among the five in this guide: there is no LLM output to eval, no judge to audit, no model call to trace.

There is, however, one genuinely AI-adjacent artifact in this codebase worth teaching evals against for real: a working, mutation-verified golden-set eval harness at `app/test/eval-fixtures.test.ts` (376 lines, run via `npm run eval` — `app/package.json` line 24). It feeds a hand-built fixture catalog (15 products, 17 variants) through the exact production seam the worker uses (`normalizeCatalog -> runChecks`) and asserts the resulting findings against an expected-findings table that was derived by *reading each check's spec*, not by running the engine once and snapshotting its output. That's the golden-set + regression discipline any trustworthy LLM eval needs — this repo just happens to apply it to a deterministic engine instead of a model.

## Reading order

| File | Status | What it covers |
|---|---|---|
| `01-eval-set-types.md` | **real, grounded** | Golden set / adversarial set / regression set. The golden set is `eval-fixtures.test.ts` itself — walked in full, with the fixture table and the "independently specified" discipline its header comment names. Adversarial and regression coverage are named honestly as absent/informal, not overclaimed. |
| `02-eval-methods.md` | **real, grounded** | The eval-methods ladder (exact match → fuzzy match → rubric → LLM-as-judge → pairwise → human eval). Exact match is grounded in the actual `missing`/`unexpected` diff assertion at lines 354–367 of `eval-fixtures.test.ts`. Every rung above exact match is taught as general knowledge, honestly labeled `not yet exercised`. |
| `03-llm-as-judge-bias.md` | `not yet exercised` | Position bias, verbosity bias, self-preference bias — taught in full as general knowledge. No LLM output exists in this repo for a judge to grade, so there's nothing to ground here today; the file names the natural next step (MerchGrid: Bulk AI generating merchant-facing text) as speculative, not built. |
| `04-llm-observability.md` | `not yet exercised` | Traces, spans, replay — taught in full as general knowledge. No LLM calls exist to trace. The file is honest about the non-LLM analog this repo does have (the `Scan` status-machine and the atomic `$transaction` block in `app/services/scan/runner.server.ts`, plus `npm test`/`npm run eval` as pre-deployment correctness — not runtime tracing) without conflating the two. |

Read `01` and `02` first — they're where the real code lives and where the interview-defensible argument ("is a deterministic golden-set eval still AI engineering?") gets made in full. `03` and `04` are shorter, concept-only reads: the biases and pillars are correct and complete as general knowledge, but this repo gives you nothing to point at yet.

## The one sentence that matters

The model behind the seam is incidental; the eval discipline — independently-specified ground truth, checked against the real production seam, resistant to snapshot-and-rubber-stamp drift — is the transferable skill. `app/test/eval-fixtures.test.ts` proves that discipline out completely, with zero AI in sight.
