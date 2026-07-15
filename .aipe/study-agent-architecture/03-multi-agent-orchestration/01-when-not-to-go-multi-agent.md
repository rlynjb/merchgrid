# When NOT to go multi-agent

Industry standard (production scar tissue). The most important multi-agent decision is whether to be multi-agent at all.

## Zoom out, then zoom in

```
Zoom out — this codebase's actual answer to "how many agents?"

┌─ This codebase, today ───────────────────────────────────────┐
│  ZERO agents. Not "one agent" — zero. The scan pipeline is a  │
│  fixed chain (see 01-reasoning-patterns/01-chains-vs-agents.md)│
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ If Bulk AI is built ────────▼──────────────────────────────────┐
│  the honest default answer is ONE agent (a ReAct or            │
│  plan-and-execute loop), not several — multi-agent has to be    │
│  earned, and nothing about proposing catalog changesets has     │
│  demonstrated it needs more than one agent yet                  │
└──────────────────────────────────────────────────────────────────┘
```

Every topology in the rest of this sub-section (supervisor-worker, pipeline, fan-out, debate, swarm, graph) is generated for a codebase whose shape matches multi-agent work today. This one doesn't — MerchGrid has no agents of any count, let alone several coordinating ones — so this file is the only one this sub-section generates, and it's generated on purpose: this decision (single agent, or none, before multiple) is the one every codebase's agent-architecture guide should carry regardless of what it currently builds.

**In this codebase:** not applicable in the sense of "here's the multi-agent system and here's why it's justified" — there is no multi-agent system, and there is no single-agent system either. But the gate below is exactly the discipline that should be applied *first*, before Bulk AI reaches for anything past a single ReAct or plan-and-execute loop.

## The structure pass

**Axis to trace: coordination overhead vs. quality gain.** Multi-agent adds real cost (coordination overhead, a much larger debugging surface) for a quality gain that's often smaller than expected unless the problem genuinely splits into independent specialties. The seam that matters is the one named in the gate below: is the failure a single agent hits actually decomposable into separate specialties, or is it a prompt/tool/retrieval problem wearing a multi-agent costume?

## How it works

### Move 1 — the mental model

Think of it like deciding whether a team needs to split into sub-teams: splitting only pays off when the work genuinely decomposes into independent specialties with a clean handoff — splitting a task that doesn't decompose just adds a meeting (coordination overhead) with no matching gain in output.

```
┌───────────────────────────────────────────────┐
│ 1. Build a single-agent (ReAct) baseline      │
│ 2. Measure: success rate, tool-call accuracy, │
│    latency, cost                              │
│ 3. Identify the SPECIFIC failure single-agent │
│    cannot fix                                  │
│ 4. Is that failure genuinely decomposable     │
│    into independent specialties?               │
│       │                                        │
│       ├─ no  → stay single-agent, fix the      │
│       │        prompt / tools / retrieval      │
│       └─ yes → escalate to the SPECIFIC        │
│                topology that addresses it      │
└───────────────────────────────────────────────┘
```

### Move 2 — the step-by-step walkthrough

**The cost of crossing this gate:** multi-agent adds roughly 2-5x coordination overhead and a much larger debugging surface — once you cross the gate, you're debugging the conversation *between* agents, not just one agent's loop. The quality gain is often modest unless the underlying problem genuinely splits into specialties; teams that skip straight to multi-agent because it sounds more sophisticated routinely pay this cost for no matching benefit.

**Applied to the hypothetical Bulk AI agent (the only place this gate has anything to attach to in this codebase):** walk the gate concretely. Step 1 — a single ReAct or plan-and-execute agent over `runChecks`' findings, proposing changesets, checked against the same engine as a guardrail. Step 2 — measure proposal-acceptance rate against the guardrail, cost per changeset, latency. Step 3 — suppose the single agent's failure turns out to be "it proposes good individual fixes but doesn't notice when two fixes conflict across the same product" (say, a price fix and a compare-at-price fix that together violate a margin rule). Step 4 — is that decomposable into a specialty split? Possibly: a "propose fixes" agent and a "cross-check for conflicts" agent is a plausible supervisor-worker or verifier-critic split. But the discipline this file exists to enforce is: don't build that split *until* you've actually observed that specific failure in a measured single-agent baseline — building it speculatively is exactly the mistake this gate is designed to prevent.

**The senior-grade answer this earns:** "I considered multi-agent for Bulk AI and would hold off, because I haven't observed a single-agent failure yet that's genuinely decomposable — the deterministic guardrail already catches the failures a second agent would otherwise need to catch." That sentence is worth more in an interview than describing a multi-agent architecture that was never measured against a baseline.

### Move 3 — the principle

The default is one agent, or none. Multi-agent is a response to a *measured, specific, decomposable* failure — never a starting architecture chosen because the problem sounds complex enough to deserve it.

## Primary diagram

```
The gate, applied to the only place it has something to attach to

┌─ Today: this codebase ───────────────────────────────────────┐
│  zero agents. the gate doesn't even apply yet — there's no    │
│  single-agent baseline to measure because there's no agent.   │
└─────────────────────────────┬──────────────────────────────────┘
                              │ IF Bulk AI is built
┌─ Step 1-2: single-agent baseline ▼───────────────────────────────┐
│  ReAct/plan-and-execute agent + runChecks guardrail, measured   │
└─────────────────────────┬──────────────────────────────────────┘
                          │ only on a SPECIFIC, decomposable failure
┌─ Step 3-4: escalate, narrowly ▼──────────────────────────────────┐
│  a named topology (e.g. verifier-critic) for that ONE failure,  │
│  not a general-purpose multi-agent rebuild                      │
└──────────────────────────────────────────────────────────────────┘
```

## Elaborate

This gate is the single most repeated piece of production wisdom in agent-architecture writing for a reason: multi-agent systems are genuinely harder to build, run, and debug than they look on a whiteboard, and the failure of "we built a supervisor-worker system because the problem seemed complex" without ever measuring a single-agent baseline is extremely common. The rest of this guide's SECTION C topologies (supervisor-worker, pipeline, fan-out, debate, swarm, graph) exist in the industry for real reasons — but every one of them is generated in this guide only for codebases that have already crossed this gate with something to show for it. This one hasn't, so those files aren't generated here; if Bulk AI eventually does cross the gate, `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` is the closest template to work from.

## Interview defense

**Q: "Would you build Bulk AI as a multi-agent system?"**
A: Not as a starting point. I'd build a single ReAct or plan-and-execute agent first, with the existing deterministic check engine as its guardrail, measure its failure modes, and only reach for a specific topology (verifier-critic, most plausibly, for catching cross-finding conflicts) if I observed a failure that a single agent genuinely can't fix and that decomposes cleanly into separate specialties.
*Sketch while you say it:* the four-step gate diagram from Move 1.

**Q: "What's the cost of going multi-agent too early?"**
A: Roughly 2-5x coordination overhead, plus a debugging surface that's now the conversation between agents instead of one agent's own reasoning — and often a quality gain that doesn't justify either, because the problem didn't actually need the split.

**Q: "Does this codebase have any multi-agent orchestration?"**
A: No — it has zero agents of any count. The gate in this file is forward-looking: it's the discipline to apply before Bulk AI's design gets past a single agent, not a description of anything currently built.

## See also

- `01-reasoning-patterns/01-chains-vs-agents.md` — the prior gate (chain vs. single agent) that has to be crossed before this one is even relevant.
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the single-agent kernel that has to exist and be measured before step 3-4 of this gate can fire.
- `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — the template to reach for if this gate is ever crossed for real.
