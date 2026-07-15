# 04 — Agent infrastructure

One file in this sub-section, chosen deliberately over the other four this sub-section normally covers (context engineering, agent memory tiers, tool calling and MCP, agent evaluation).

## Reading order

1. **`01-guardrails-and-control.md`** — the only file, and the second-most load-bearing file in this whole guide after `01-reasoning-patterns/01-chains-vs-agents.md`. This one has real code to point at: `runChecks` and the `CatalogFinding` contract are, structurally, already the output-guardrail half of a full control envelope — built for the current deterministic product, and explicitly named in `.aipe/project/context.md` as designed for reuse by the future "MerchGrid: Bulk AI" product.

## Why the other four files aren't here

This sub-section's anchor is single-agent and multi-agent work, and this codebase matches neither shape — there's no context window to curate (no LLM calls at all), no agent memory to tier (nothing persists across turns because there are no turns), no tool-calling surface (no model ever calls a tool), and no trajectory to evaluate (nothing traces a multi-step reasoning path). Generating those four as "not yet implemented" stubs with nothing real to attach to would pad the guide without teaching anything specific to this codebase. Guardrails-and-control earns an exception because the guardrail's *engine* genuinely already exists here, unlike the other four concepts, which have no analog in this repo at all — real or embryonic.
