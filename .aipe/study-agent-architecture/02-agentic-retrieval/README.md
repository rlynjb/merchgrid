# 02 — Agentic retrieval (skipped)

No concept files are generated in this sub-section, and that's a deliberate, honest call rather than an oversight.

## Why this sub-section is empty

Agentic retrieval — agentic RAG, self-corrective RAG, retrieval routing — is retrieval treated as a control loop a model drives. MerchGrid: Catalog Audit has:

- no LLM anywhere in the runtime
- no embeddings, no vector store, no chunking
- no retrieval of any kind — the "read" step in the scan pipeline is a paginated GraphQL fetch of the shop's catalog (`app/app/services/shopify/catalog-reader.server.ts`), not a search over a knowledge base

This sub-section's anchor (per this guide's spec) is single-agent work specifically — it does not include the workflow/chain shape this codebase actually matches. A codebase with zero retrieval of any kind, agentic or otherwise, doesn't have a toehold for this material, so no files are generated rather than padding the guide with "not yet implemented" write-ups that have nothing real to attach to.

## If this changes

If "MerchGrid: Bulk AI" is ever built and needs to ground its proposals in something beyond the deterministic findings it already has access to (product descriptions, past merchant decisions, catalog history), retrieval would become relevant — and agentic retrieval specifically would become relevant the moment that lookup needs more than one round-trip to get right (e.g. the agent needs to decide *which* source to check based on what the first lookup returned). Until then, this sub-section stays empty by design.

See `00-overview.md` for how this sub-section fits into the guide's overall shape.
