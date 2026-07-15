# ReAct (Reason + Act)

Industry standard. The default single-agent reasoning pattern: interleave "what should I do" with "do it" one step at a time.

## Zoom out, then zoom in

```
Zoom out — where ReAct would sit, if this codebase used it

┌─ Service layer ──────────────────────────────────────────────┐
│  runScan()'s fixed pipeline — TODAY, no model, no ReAct loop │
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Hypothetical: Bulk AI's changeset agent ─▼───────────────────┐
│  reason: "what should I check/fix next?"                     │
│  act:    call a tool (read a variant, propose a price fix)    │
│  observe: read the result, loop or stop                       │
│  ★ THIS is where ReAct would plug into step() from the        │
│    agent-loop-skeleton file — it doesn't exist yet ★          │
└──────────────────────────────────────────────────────────────────┘
```

ReAct is the agent-loop-skeleton (`01-reasoning-patterns/02-agent-loop-skeleton.md`) with a specific answer for what `step()` does: on every turn, the model produces a short "Thought" (why it's picking the next move) immediately followed by an "Action" (a tool call), then reads the "Observation" (the tool's result) before thinking again. It's the pattern you reach for first, not because it's fancy, but because it's the cheapest thing that can adapt its own path.

**In this codebase:** not yet implemented. There is no autonomous loop anywhere in this repo — the pipeline in `runner.server.ts` never interleaves "reason" and "act," because nothing in it reasons. If "MerchGrid: Bulk AI" is built, a ReAct loop over the catalog (inspecting findings, proposing a fix, checking the fix against the guardrail, re-proposing on rejection) is the natural first thing to try before anything fancier.

## The structure pass

**Layers:** the ReAct loop has exactly the agent-loop-skeleton's four parts, with `step()` specifically implemented as one "Thought → Action" model call per turn.

**Axis to trace: control.** Same axis as `01-chains-vs-agents.md`, but now on the *hypothetical* Bulk AI side: at every turn, the model decides the next tool call — that's the entire point of ReAct over a chain. There is no seam to trace in the current codebase because there's no ReAct loop in it; the seam is the boundary this file would sit behind if built.

## How it works

### Move 1 — the mental model

You already know the loading/success/error states of a `fetch()` call — ReAct is that shape run in a cycle: think about what to fetch, fetch it, look at what came back, decide the next fetch.

```
Thought → Action → Observation, repeated until done

  ┌──────────┐   ┌────────┐   ┌─────────────┐
  │ Thought  │──►│ Action │──►│ Observation │──┐
  │ (reason) │   │ (tool  │   │ (tool       │  │ loop
  │          │   │  call) │   │  result)    │  │
  └──────────┘   └────────┘   └─────────────┘◄─┘
       ▲                                     │
       └───────────── until "done" ──────────┘
```

### Move 2 — the step-by-step walkthrough

**The escalation framing (the point of this file, not the mechanics).** ReAct mechanics — the exact prompt structure, the Thought/Action/Observation format — are covered in `study-ai-engineering.md`'s single-agent section (this repo has no `study-ai-engineering` guide yet, but that's the canonical home for the wire-level mechanics). This file's job is placement: ReAct is the strong default, and the discipline is to *start here* before reaching for anything in this guide's SECTION C.

```
Default to ReAct.
  │
  ├─ measure: success rate, tool-call accuracy, latency, cost
  │
  └─ only escalate (plan-and-execute, reflexion, multi-agent)
     when a SPECIFIC failure mode is identified that ReAct
     can't address
```

**Applied to the hypothetical Bulk AI agent:** the interview-grade answer isn't "I'd use ReAct because it's standard" — it's "I'd build a ReAct baseline over the existing `runChecks` findings, measure its proposal-acceptance rate against the guardrail, and only reach for plan-and-execute or a supervisor-worker split once I could name the specific failure ReAct hit." Most teams skip the baseline and reach for the fancier pattern first; naming that you didn't is the stronger signal.

### Move 3 — the principle

ReAct's real value isn't the prompt format — it's that it's cheap to build, cheap to measure, and gives you a real failure mode to escalate against instead of guessing which fancier pattern you need. Any future agent work in this codebase should be measured against a ReAct baseline before anything else gets built.

## Primary diagram

```
Where ReAct would sit if Bulk AI is built

┌─ Existing (this repo) ────────────────────────────────────────┐
│  runChecks() → findings (deterministic, unchanged)             │
└─────────────────────────┬──────────────────────────────────────┘
                          │ findings feed the agent's context
┌─ Hypothetical Bulk AI ───▼──────────────────────────────────────┐
│  ReAct loop: Thought → Action (propose/edit a changeset) →      │
│  Observation (guardrail: pass/reject) → loop or stop            │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

ReAct (Yao et al., 2022) was proposed specifically as a fix for pure chain-of-thought reasoning's inability to act on the world — it interleaves reasoning traces with actions so the model's next thought can be grounded in a real observation rather than its own unchecked guess. It's the substrate every fancier pattern in this guide builds on: plan-and-execute front-loads the reasoning; reflexion adds a critique step after; multi-agent topologies are many ReAct-shaped loops coordinating.

## Interview defense

**Q: "Why start with ReAct instead of a fancier pattern?"**
A: Because it's the cheapest thing that can adapt its own path, and you need a measured baseline before you can justify anything more expensive. Reaching for plan-and-execute or multi-agent before measuring where ReAct actually fails is guessing at the wrong layer.

**Q: "Does this codebase use ReAct?"**
A: No — not yet implemented. There's no autonomous loop of any kind in this repo; the pipeline is a fixed chain (see `01-chains-vs-agents.md`). If Bulk AI is built, ReAct is the natural first thing to try, with the existing deterministic checks reused as the guardrail the agent's proposals have to pass.

## See also

- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel ReAct instantiates.
- `01-reasoning-patterns/04-plan-and-execute.md` — the escalation path once ReAct's per-step reasoning cost becomes the bottleneck.
- `04-agent-infrastructure/01-guardrails-and-control.md` — what a ReAct loop's "Observation" would actually be checking against in this codebase.
