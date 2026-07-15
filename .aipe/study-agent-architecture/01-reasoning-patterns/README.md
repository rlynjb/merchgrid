# 01 — Reasoning patterns

How one model (or, in this codebase's case, one deterministic pipeline standing where a model could go) thinks through a task. This sub-section is the richest one in the guide — it's the only place where a real, load-bearing piece of MerchGrid's own architecture (the scan pipeline, the worker, the state machine) gets studied directly.

## Reading order

1. **`01-chains-vs-agents.md`** — start here. The boundary question, answered concretely against `runner.server.ts`, `state.ts`, and `worker-core.server.ts`. This is the spine of the whole guide.
2. **`02-agent-loop-skeleton.md`** — the kernel every reasoning pattern and topology in this guide instantiates, taught against two real bounded loops already in this repo (`catalog-reader.server.ts`'s pagination loop, `worker.ts`'s poll loop) even though neither has a model-decided step.
3. **`03-react.md`** through **`07-routing.md`** — the named single-agent patterns. All marked "Not yet implemented" in this codebase; each still teaches the pattern and names where it would attach if "MerchGrid: Bulk AI" is ever built.

## What's real here vs. what's template

Files 1 and 2 teach real code with file paths and line numbers. Files 3 through 7 are honest curriculum — the patterns exist in the industry and are worth knowing, but this codebase doesn't exercise any of them, because it has no autonomous loop at all.
