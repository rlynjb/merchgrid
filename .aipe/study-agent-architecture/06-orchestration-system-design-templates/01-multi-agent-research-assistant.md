# System design template — multi-agent research assistant

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."
- **Standard architecture:** supervisor decomposes the question → parallel worker agents each retrieve from a source (agentic RAG per worker) → supervisor synthesizes with citations.

```
┌───────────────────────────────────────────────┐
│              Supervisor agent                  │
│   (decomposes question, delegates, synthesizes)│
└───────┬───────────────┬───────────────┬───────┘
        ▼               ▼               ▼
    ┌────────┐      ┌────────┐      ┌────────┐
    │worker 1│      │worker 2│      │worker 3│
    │(source)│      │(source)│      │(source)│
    └────┬───┘      └────┬───┘      └────┬───┘
         └───────────────┼───────────────┘
                         ▼
                supervisor synthesizes
                worker results → cited answer
```

- **Data model:** source registry, per-worker retrieval indices, a shared findings store keyed by sub-question, citation provenance.
- **Key components:** decomposition (supervisor), parallel retrieval (workers, fan-out), synthesis (merge agent), citation tracking. Decision per component: tools-style vs. handoff-style delegation; shared state vs. message passing.
- **Scale concerns:** at many sources, fan-out cost; at deep questions, iteration blowup (cap it); at high volume, the supervisor becomes the bottleneck (cheap workers, expensive supervisor only).
- **Eval framing:** trajectory eval (did each worker hit the right source?), answer groundedness (every claim cites a retrieved chunk), cost/latency per question.
- **Common failure modes:** synthesis of contradictory sources, citation hallucination, cost blowup from deep loops, lost-in-the-middle across many worker results.
- **Applies to this codebase:** No. MerchGrid has no research-question shape at all — it doesn't answer open-ended questions from multiple sources; it runs 10 fixed rule functions (`ALL_CHECKS`) against one normalized catalog snapshot and reports what fired. There's no supervisor, no workers, no synthesis step, no citations — `runChecks` (`app/packages/catalog-checks/src/run.ts:26-28`) is a single deterministic pass, not a decomposed multi-source investigation.
- **How to make it apply:** This template doesn't fit MerchGrid's actual future direction well — "MerchGrid: Bulk AI" is a changeset-proposal agent, not a research assistant, so this specific template would need a genuinely different product goal to become relevant. If it ever did (say, a future feature that investigates *why* a pricing anomaly exists by cross-referencing order history, supplier data, and past merchant notes), the refactor would be: keep `catalog-checks` as one "worker" whose source is the deterministic findings, add new workers for the other sources, and add a supervisor to decompose the investigation and synthesize — none of which exists today, and none of which is on the current roadmap.
