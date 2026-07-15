# 01 — LLM Foundations

This sub-section teaches the core mechanics of large language models — what
they are, how text becomes tokens, how sampling works, how output gets
constrained to a schema, how streaming and cost work, and how systems gate
autonomous action — and grounds every concept against the real code in
MerchGrid: Catalog Audit.

**The honest headline:** MerchGrid: Catalog Audit is a deterministic,
rule-based Shopify app. It has zero LLM, ML, or AI code anywhere in its
codebase, by deliberate product decision (see the product spec §2.1, §17.6,
§27). Eight of the nine files below teach a real, transferable concept that
is `not yet exercised` in this repo, and each one names concretely where the
concept would attach if the roadmapped "MerchGrid: Bulk AI" product gets
built. One file — `07-heuristic-before-llm.md` — is different: it documents
a pattern this repo *does* fully implement (the deterministic check engine)
and the real seam the product spec already designed for a future LLM-adjacent
role.

| File | Concept | Status in this repo |
|---|---|---|
| [01-what-an-llm-is.md](./01-what-an-llm-is.md) | The autoregressive next-token loop: frozen weights, one forward pass, sample, repeat | Not yet exercised |
| [02-tokenization.md](./02-tokenization.md) | Subword tokenization (BPE): why text becomes integers before a model ever sees it | Not yet exercised |
| [03-sampling-parameters.md](./03-sampling-parameters.md) | Temperature, top-k, top-p: reshaping and truncating a probability distribution before sampling | Not yet exercised |
| [04-structured-outputs.md](./04-structured-outputs.md) | JSON mode, function/tool schemas, constrained decoding: guaranteeing shape, never truth | Not yet exercised |
| [05-streaming.md](./05-streaming.md) | Token-by-token delivery over SSE, and why it's a UX-latency fix, not a throughput one | Not yet exercised |
| [06-token-economics.md](./06-token-economics.md) | Per-token pricing and the context window as a hard ceiling, not a soft guideline | Not yet exercised |
| [07-heuristic-before-llm.md](./07-heuristic-before-llm.md) | Heuristic-first routing before an LLM fallback | **Implemented** — MerchGrid's real check engine (`ALL_CHECKS` + `runChecks`) is the heuristic side, running at 100% coverage with no LLM branch, by design |
| [08-provider-abstraction.md](./08-provider-abstraction.md) | The port/adapter/factory pattern for swapping an external vendor | Not yet exercised for an LLM — but the identical pattern is real and tested for the Shopify Admin API (`AdminGraphqlClient`) |
| [09-user-override-locks.md](./09-user-override-locks.md) | Human-in-the-loop approval gates on autonomous action | Not yet exercised as a gate — MerchGrid instead uses the strongest version of this pattern: no write capability was ever granted (`shopify.app.toml`'s read-only scopes) |

## How to read this

Read in order once, top to bottom — `01` through `06` build the LLM
mechanism itself (loop → tokens → sampling → output shape → delivery → cost),
`07` is the pivot file that explains why none of that mechanism exists in
this codebase today, and `08`-`09` cover the surrounding architecture
(provider swapping, safety gating) a future LLM integration would need.

If you only have time for one file, read `07-heuristic-before-llm.md`. It's
the only file in this sub-section anchored to code that actually runs in
production today, and it's the file most likely to come up directly in an
interview about this repo: "why doesn't this app use an LLM, and where would
one go if it did."

## Real files this sub-section keeps coming back to

- `app/packages/catalog-checks/src/contract.ts` — the `CatalogCheck` /
  `CatalogCheckContext` / `CatalogFinding` contract; the typed seam a future
  LLM-proposed-changeset validator would target.
- `app/packages/catalog-checks/src/run.ts` — `runChecks`, the one-line proof
  that no LLM routing decision exists anywhere in this pipeline today.
- `app/app/services/shopify/catalog-reader.server.ts` — `AdminGraphqlClient`,
  the real port/adapter seam this guide uses as the template for a future
  LLM provider abstraction, and the query-only code that is half of this
  app's structural "no write capability" lock.
- `shopify.app.toml` — the registered OAuth scopes (`read_products,
  read_inventory`, no write scope) that are the platform-enforced other half
  of that lock.
- `merchgrid-catalog-audit-product-spec.md` — §2.1, §17.6, §25.4, §27 are
  cited throughout this sub-section as the product's own stated reasons for
  building deterministic-first and designing the check engine as reusable
  groundwork for the future MerchGrid: Bulk AI product.
