# Study — Agents & Tool Use: MerchGrid Catalog Audit

## The through-line

Every file in this section teaches an industry-standard agent concept and then
tells you, precisely, whether MerchGrid: Catalog Audit exercises it. The
honest answer for all six is the same: **not yet exercised.** MerchGrid is a
deterministic, rule-based Shopify app — 10 hand-written checks (`MG-001`
through `MG-010`) over normalized catalog data, zero LLM or agent anywhere in
the running code. That's not an oversight; it's a stated product decision
(product spec §2.1: *"Deterministic: Findings come from explicit validation
rules rather than an LLM"*; §17.6 bans AI-powered marketing language for this
app). A second, future product — **MerchGrid: Bulk AI** — is named in the
same spec (§25.4) as an LLM-driven bulk-editing app that would reuse this
app's engine as a guardrail. That flow is agent-shaped (a model proposes
actions; something else gates and executes them), but it is not built. Every
file below says so plainly rather than describing a loop that doesn't exist.

## Where this guide's grounding actually lives

Two files carry real, load-bearing anchors in this codebase; the other four
are taught as pure general knowledge with a brief, honest note on where they'd
attach if Bulk AI is ever built.

```
  Grounding strength across this section

  02-tool-calling.md     ██████████  the CatalogCheck contract (contract.ts
  06-error-recovery.md   ██████████  lines 1-32) and the real retry/containment
                                     code (catalog-reader.server.ts, runner.
                                     server.ts) are both real, read-the-file
                                     grounded — the richest pair in this guide

  01-agents-vs-chains.md █████░░░░░  the real runScan pipeline IS a concrete
                                     chain — grounded, but the "agent" HALF
                                     of the comparison is pure counterfactual

  03-react-pattern.md    ██░░░░░░░░  no loop anywhere in this repo — taught
  04-tool-routing.md     ██░░░░░░░░  as general knowledge, with a brief
  05-agent-memory.md     ██░░░░░░░░  "where this would attach" note each
```

`02-tool-calling.md` and `06-error-recovery.md` are the two files worth
reading most closely if you only have time for two: they're where a real,
already-well-designed piece of this codebase (the `CatalogCheck` contract; the
retry/containment/atomicity trio in the scan pipeline) turns out to be
precisely *half* of an industry pattern — the half that doesn't require an
LLM to be valuable on its own.

## Reading order

1. **`01-agents-vs-chains.md`** — the first fork in the road: does code or a
   model decide what happens next? MerchGrid's real `runScan` pipeline is the
   worked chain example; the agent side is the counterfactual.
2. **`02-tool-calling.md`** — the richest file in this section. `contract.ts`'s
   `CatalogCheck` interface is, structurally, a real tool contract (name,
   description, typed input, typed output) — nothing here calls it via an
   LLM's decision, but the contract itself needs no changes to become one.
3. **`03-react-pattern.md`** — the Reason/Act/Observe loop, taught as general
   knowledge with no codebase anchor; the honest attachment point is Bulk
   AI's changeset-proposal loop (spec §25.4), unbuilt.
4. **`04-tool-routing.md`** — the precise line between "run everything"
   (`ALL_CHECKS`/`runChecks`, real) and "select a subset" (routing, not built
   anywhere in this repo, and not the same thing as a fixed array).
5. **`05-agent-memory.md`** — why MerchGrid's real, persisted `Scan`/`Finding`
   rows are application state, not agent memory — the distinction hinges on
   whether anything reasoning over that data treats it as memory of a past
   interaction, and nothing here does.
6. **`06-error-recovery.md`** — the second richest file. Real retry-with-backoff
   (`catalog-reader.server.ts`), real catch-all containment and atomic writes
   (`runner.server.ts`) are all deterministic application error handling, not
   agent error recovery — the file draws that line precisely, with exact file
   and line citations for both what's real and what's absent.

## The one repo fact every file in this section keeps coming back to

`app/packages/catalog-checks/src/contract.ts` (lines 1-32) defines
`CatalogCheck { id, name, description, run(ctx): CatalogFinding[] }` — a
named, described, typed, callable unit. `app/packages/catalog-checks/src/run.ts`
(lines 26-28) is the only thing that calls it: a hardcoded array run through
`flatMap`, in fixed order, every time, chosen by nobody. That single pair of
facts is the spine of `02-tool-calling.md` and shows up again, from different
angles, in `01-agents-vs-chains.md` and `04-tool-routing.md`: a clean contract
built for one reason (composability, testability) turns out to be directly
reusable for an entirely different reason (a future model-driven caller) —
*if*, and only if, nobody blurs the line between the contract that exists and
the dispatch loop that doesn't.

## See also

- Product spec `merchgrid-catalog-audit-product-spec.md` §2.1, §17.6, §25.4,
  §27 — the sections that state MerchGrid's determinism requirement and name
  the future Bulk AI integration this section's counterfactuals are grounded in.
- `.aipe/study-agent-architecture/` — a separate, deeper guide covering
  reasoning patterns and multi-agent orchestration against this same repo;
  read alongside this section if you want the fuller agent-architecture
  treatment of the same "chain, not agent" finding.
