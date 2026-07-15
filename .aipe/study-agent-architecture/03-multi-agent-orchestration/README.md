# 03 — Multi-agent orchestration

Only one file in this sub-section, and that's a deliberate call, not a gap.

## Reading order

1. **`01-when-not-to-go-multi-agent.md`** — the only file. This sub-section's anchor is multi-agent work, and this codebase doesn't match that shape at all — it has zero agents, single or multiple. The one file generated here is the boundary/escalation-gate file, which every agent-architecture guide carries regardless of what the codebase currently builds, because it's the discipline to apply *before* reaching for any of the topologies (supervisor-worker, pipeline, fan-out, debate, swarm, graph) this sub-section would otherwise cover.

## Why the topology files aren't here

Supervisor-worker, sequential pipeline, parallel fan-out, debate/verifier-critic, swarm handoff, graph orchestration, shared state and message passing, and coordination failure modes are all real, well-established patterns — they're just not generated for this codebase, because nothing here has crossed the gate that would make them relevant. If "MerchGrid: Bulk AI" is ever built and a single-agent baseline demonstrates a specific, decomposable failure (per the gate in `01-when-not-to-go-multi-agent.md`), that's the point to regenerate this sub-section with the specific topology that addresses it — not before.
