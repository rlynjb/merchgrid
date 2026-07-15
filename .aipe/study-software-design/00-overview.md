# Overview — software design audit, MerchGrid: Catalog Audit

This is the punch list. Read this file alone and you have the shape of the
whole audit; read `audit.md` for the full 8-lens walk, and the numbered
files for the five design moves worth studying in depth.

## The complexity profile

MerchGrid is a small, deliberately simple MVP (~30 source files across a
two-package engine and a Remix host app), and it reads that way: no god
classes, no tangled dependency graph, comments that consistently carry
*why* rather than restating *what*. The complexity that does exist
clusters in three places, not scattered evenly:

```
  Where complexity clusters — three hotspots, ranked

  1. runScan()                 cognitive load    — one 166-line function,
     runner.server.ts:59-225                       five concerns, no
                                                     internal delegation

  2. catalog-reader.server.ts  unknown-unknowns  — three functions must
     :309-452                                       agree on `truncated`/
                                                     `partial`, or a scan
                                                     silently under-reports

  3. variant→Finding field list information leak — the same knowledge
     runner.server.ts:144-180                       (which fields get
     scan-api.server.ts:170-218                      denormalized) is known
                                                       in two files
```

## Verdict per primitive

| Primitive | Verdict |
|---|---|
| Deep vs. shallow modules | Mostly deep. `money.ts` is the deepest module in the repo (see `01-`). The one shallow spot is `CsvRowInput` in `csv.ts` — its interface is wider than what `rowFields` actually reads, forcing callers to fabricate placeholder fields. |
| Information hiding | Strong in the security-critical spot (`EncryptedSessionStorage`, see `03-`), leaky in one bookkeeping spot (the variant→Finding field list known in two files) and one self-documented spot (`CATALOG_API_VERSION`, kept in sync manually across three files). |
| Layers and abstractions | Clean. The one pass-through layer (`shopify.server.ts`'s re-exports) is the framework's own shape, not a defect — no adjacent layer duplicates another's abstraction. |
| Pull complexity downward | One knowingly-accepted exception: `RunScanDeps`/`ReadCatalogOptions` expose test-only injection parameters (`now`, `catalogMaxRetries`, `catalogSleep`, `sleep`) on production function signatures. Reasonable at this scale; would need a DI pattern to close cleanly at a larger one. |
| Errors and special cases | A genuine strength. `runScan`'s single outer try/catch (see lens 6 of `audit.md`) and the tenant-safe error collapsing (see `05-`) both eliminate special-case sprawl instead of accumulating it. |
| Readability | Strong across all four facets — names, comments, consistency, obviousness — with one trivial "huh?" spot (`severityToRank`'s silent fallback to a state the type system already prevents). |

## The single highest-leverage fix

Narrow `CsvRowInput` in `app/packages/catalog-checks/src/csv.ts:5-8` to the
~12 fields `rowFields` (`csv.ts:50-85`) actually reads, and have
`buildFindingsCsv` (`app/app/services/scan/export.server.ts:20-56`) map
`FindingRow` onto that narrower type directly. This removes four
fabricated placeholder lines (`shopId: ""` twice, `tracksInventory:
false`, a synthesized `displayName`) that exist purely to satisfy a type
the CSV writer doesn't need in full — the fix reduces the most complexity
for the least work of anything in this audit, because it's a type
definition change plus a smaller mapping function, with no behavior
change and full test coverage already in place
(`packages/catalog-checks/tests/csv.test.ts`, `test/export.test.ts`).

## What's `not yet exercised`

- **Classitis / god-object shallow modules** — not found. This codebase
  has almost no classes at all (`EncryptedSessionStorage` is close to the
  only one), so the specific "interface as complex as ten methods doing
  one thing each" smell has nothing to fire on yet. Worth re-checking once
  the app grows a second product surface (the planned "MerchGrid: Bulk AI"
  changeset-preflight tool mentioned in `.aipe/project/context.md`).
- **Temporal decomposition** — not found. No module here is organized
  around "step 1 does X, step 2 does Y" in a way that leaks execution
  order into its interface; `runScan`'s five concerns live inside one
  function's body, not spread across a temporally-ordered set of public
  methods.
- **Repeated adjacent layers offering the same abstraction** — not found.
  There's no case of two layers in this stack doing the same job.

## Pass 2 — the five discovered design moves

1. `01-decimal-money-boundary.md` — the deepest module in the repo; every
   check's price/margin comparison funnels through `money.ts`.
2. `02-scan-state-machine.md` — `assertTransition` guaranteeing a scan
   can never be silently relabeled further along than it got.
3. `03-encrypted-session-storage-decorator.md` — the ports-and-adapters
   decorator that made at-rest token encryption a config flag, not a
   rewrite.
4. `04-check-registry-pattern.md` — why adding check MG-011 costs three
   files and zero caller changes.
5. `05-tenant-safe-error-collapsing.md` — how the scan-findings API
   guarantees a wrong-tenant request learns nothing.

Full lens-by-lens evidence lives in `audit.md`. Start there for the
complete picture; start here if you only have five minutes.
