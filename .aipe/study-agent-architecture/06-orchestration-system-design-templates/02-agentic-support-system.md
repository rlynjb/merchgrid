# System design template — agentic support / task system

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."
- **Standard architecture:** intent router → single agent with tools (ReAct) → guardrails (input sanitize, action gating, output schema) → human escalation on low confidence or gated actions.

```
┌────────────────┐    ┌──────────────────────────────────┐
│ Intent router  │───►│ ReAct agent (reason → act →       │
│ (heuristic/LLM)│    │ observe, with tools)               │
└────────────────┘    └──────────────┬─────────────────────┘
                                     ▼
                       ┌──────────────────────────────────┐
                       │ Guardrails: input sanitize,       │
                       │ action gating, output schema      │
                       └──────────────┬─────────────────────┘
                            ┌─────────┴─────────┐
                            ▼ confident          ▼ low-confidence /
                       auto-resolve              gated action
                                              → human escalation
```

- **Data model:** conversation/run history with tool calls and confidence per turn, escalation log, tool registry, action audit trail.
- **Key components:** routing, the agent loop, guardrails, escalation gate, audit logging. Decision: which actions require human approval (irreversible / high-stakes) vs. auto-execute.
- **Scale concerns:** tool-call cascade under load, cost per resolved request, escalation queue as the human bottleneck.
- **Eval framing:** resolution rate without escalation, tool-call accuracy, adversarial set (prompt injection, out-of-scope), action-safety (no unauthorized side effects).
- **Common failure modes:** prompt injection in user input, agent taking an unsafe action directly, infinite loop on an unsolvable request, hallucinated tool results.
- **Applies to this codebase:** No. MerchGrid resolves nothing on a user's behalf — it's read-only by construction (`read_products,read_inventory` scopes only, per `.aipe/project/context.md`), it never takes an action against Shopify, and there is no conversational or task-resolution surface at all. The closest thing to "resolving a request" is `enqueueScan` → `claimAndRunNext` → `runScan` running the fixed audit pipeline — but every step is deterministic code, not an agent choosing actions, and the pipeline never writes to Shopify.
- **How to make it apply:** This is actually the closest of the three templates to what "MerchGrid: Bulk AI" would need to become, if it's framed as "resolve catalog problems by taking action" rather than just reporting them. The concrete refactor: (1) add write scopes and a real Shopify mutation path, currently absent by design; (2) put a ReAct or plan-and-execute agent in front of the findings from `runChecks`, proposing a fix per finding; (3) reuse `runChecks` unmodified as the *output guardrail* — re-running it against the proposed post-fix state before anything applies (see `04-agent-infrastructure/01-guardrails-and-control.md` for exactly this mapping); (4) gate every proposed write behind human approval, since irreversible catalog changes are exactly the "high-stakes action" case this template's escalation gate exists for. None of this exists yet — it's the concrete shape a future Bulk AI would take if it followed this template.
