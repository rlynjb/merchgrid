# The ReAct Pattern

**ReAct (Reason + Act + Observe loop) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where a ReAct loop would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions          │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  runner.server.ts: runScan() — ONE straight pass, no loop at all │
│  ★ a ReAct loop would replace or wrap this, if it existed ★      │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ──────────────────────────┐
│  runChecks(ALL_CHECKS, ctx) — a ReAct loop's "Action" step would  │
│  call exactly this function, over a proposed changeset instead   │
│  of the live catalog                                              │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Shop, ShopSettings, Scan, Finding tables                          │
└───────────────────────────────────────────────────────────────────┘
```

This one has no anchor in this codebase at all, so say that plainly up front and teach it as general knowledge: MerchGrid runs `runScan` exactly once per scan, start to finish, with no loop where a model reasons about what it just saw and decides what to try next. That's worth naming honestly rather than stretching a straight-line pipeline into something it isn't. This file teaches ReAct as the pattern it is everywhere else it shows up, then names precisely where it would attach if this codebase ever needed it.

## Structure pass

**Layers (general pattern, not this repo):** a ReAct loop sits between "user request" and "final answer" as its own layer — Reason (an LLM call that produces a thought and a chosen action), Act (a tool call, executed by the host, not the model), Observe (the tool's result fed back in as new context).

**Axis: control, traced across one iteration.** Reason step: the MODEL decides what to do next, based on everything observed so far. Act step: the HOST executes the model's chosen tool — the model never runs code directly, it only names an action and arguments. Observe step: the HOST decides what raw result to feed back (sometimes truncated, sometimes summarized) — the model doesn't see the tool's internals, only what the host chooses to hand it.

**Seam:** the load-bearing seam in ReAct is the boundary between "Act" and "Observe" — that's where a tool's real, possibly messy output (an API error, a huge JSON blob, a stack trace) gets translated into something the model can usefully reason over next. Get that translation wrong and the loop either hallucinates progress it didn't make or spins forever re-trying the same failed action, because the model never saw the failure clearly enough to change its plan.

## How it works

### Move 1 — the mental model

You've debugged something by trial and error at a REPL: try a call, look at what came back, adjust your next call based on that, repeat until it works or you give up. ReAct is that loop, except the "you" deciding what to try next is a model, and every "look at what came back" step is fed back into the model's context as more text to reason over.

```
Pattern — the ReAct loop

  ┌───────────────────────────────────────────────────────────┐
  │                                                             │
  │   Thought: "I need to check the current price of SKU-123"  │
  │        │                                                    │
  │        ▼                                                    │
  │   Action: getPrice(sku="SKU-123")     ← model NAMES this,   │
  │        │                                 host RUNS it        │
  │        ▼                                                    │
  │   Observation: "price = $0, currency = USD"                │
  │        │                                                    │
  │        ▼                                                    │
  │   Thought: "That's zero — this looks like the pricing bug.  │
  │             I should flag it instead of trying more calls." │
  │        │                                                    │
  │        ▼                                                    │
  │   Action: finish(answer="SKU-123 is priced at $0")          │
  │                                                             │
  │   loop ends when the model emits a "finish" action,         │
  │   or a hard iteration budget is hit                          │
  └───────────────────────────────────────────────────────────┘
```

The underlying strategy in one sentence: interleave the model's reasoning with real, grounded tool results, one step at a time, so each new decision is made with facts instead of a guess about what a tool would probably return.

### Move 2 — the step-by-step walkthrough

**Part 1 — Thought: reasoning is a text-generation step, not a hidden process.** In a ReAct prompt, "Thought:" is literally a token prefix the model is trained (or instructed, via few-shot examples) to emit before it commits to an action. It's not a separate mechanism from next-token prediction — it's the same generation loop from `01-what-an-llm-is.md`, just steered by the prompt format to produce a short piece of reasoning text before the action line. This matters because it means the "reasoning" is inspectable: you can read exactly what the model claims informed its next move, which is the whole debugging value of ReAct over a model that jumps straight to actions with no visible justification.

**Part 2 — Action: the model names it, the host runs it.** This is the exact tool-calling mechanism from `02-tool-calling.md` — the model emits `{name, arguments}`, and the host looks that name up in its registry and executes real code. ReAct doesn't invent a new execution mechanism; it wraps tool-calling in a loop and gives the "why did you call this" step a name (Thought) and a place in the prompt.

**Part 3 — Observation: the seam that decides whether the loop is trustworthy.** The host takes the tool's real return value and re-injects it into the model's context as text. Pseudocode for the whole loop:

```
function reactLoop(task, tools, maxSteps):
  history = [task]
  for step in 1..maxSteps:
    thought, action = model.reason(history)         // Part 1 + choose an action
    if action.name == "finish":
      return action.answer
    result = tools[action.name].run(action.arguments) // Part 2 — HOST executes
    observation = formatForModel(result)              // Part 3 — HOST decides
                                                        // what the model gets to see
    history.append(thought, action, observation)
  return "gave up after maxSteps"                     // hard budget — see below
```

**Part 4 — the boundary condition everyone glosses over: the hard iteration budget.** Nothing about the loop above guarantees it terminates on its own. A model that keeps deciding "I need one more piece of information" will keep looping forever unless the host enforces `maxSteps` — the loop needs a termination guarantee that doesn't depend on the model behaving well, exactly the way `01-agents-vs-chains.md`'s chain gets termination for free from a finite transition table. This is the single most commonly forgotten piece of a ReAct implementation, and the one worth naming first in an interview.

**In this codebase:** not yet exercised — there is no loop anywhere in MerchGrid where a model reasons, acts, and observes. `runScan` runs its four stages exactly once, unconditionally, and stops. If MerchGrid ships the roadmapped "MerchGrid: Bulk AI" (product spec §25.4), the Action step of a ReAct loop over a proposed changeset would be exactly the existing `runChecks(ALL_CHECKS, ctx)` call — the same function, called with a proposed edit's `CatalogCheckContext` instead of the live catalog's. That's a real, useful anchor to hold onto, but it describes an unbuilt flow, not code that exists today.

### Move 3 — the principle

ReAct's value is forcing every action a model takes to be grounded in a real, observed result before the next decision — it trades raw speed (one big generation) for a sequence of small, checkable steps, each of which can be logged, retried, or halted independently. That tradeoff is worth it exactly when a task's next step genuinely can't be known until you've seen a prior step's real output — the same escalation condition `01-agents-vs-chains.md` uses to decide chain vs. agent in the first place. ReAct is what that agent loop looks like once you commit to building one; it's not a different decision, it's the shape the "agent" side of that fork actually takes.

## Primary diagram

```
Primary diagram — the ReAct loop, and where it would attach here

┌─ General pattern ────────────────────────────────────────────────┐
│                                                                    │
│   Thought → Action → Observation → Thought → Action → ... → Finish│
│   (model)   (host)     (host)                                     │
│                                                                    │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
             ✗ NOT BUILT in MerchGrid today — runScan is one
               straight pass, no reasoning loop anywhere.
               Would attach in Bulk AI (spec §25.4): Action =
               runChecks(ALL_CHECKS, ctx) over a proposed
               changeset instead of the live catalog.
```

## Elaborate

ReAct is a specific published pattern (Yao et al., "ReAct: Synergizing Reasoning and Acting in Language Models," 2022) that showed interleaving reasoning traces with tool actions beat both pure chain-of-thought (reasoning with no grounding in real tool results) and pure action-only agents (acting with no visible reasoning) on multi-step tasks. It became the default mental model for "agent loop" in the years since, and most agent frameworks (LangChain's `AgentExecutor`, various open-source agent SDKs) implement some variant of exactly this Thought/Action/Observation cycle under different naming. The two things that get bolted onto vanilla ReAct as systems mature are a hard step budget (Move 2 Part 4) and some form of reflection or self-critique when an action's observation looks like a failure rather than progress — see `06-error-recovery.md` for the honest version of that in a codebase, this one, that has no agent loop to reflect inside of at all.

## Project exercises

### Build a tiny ReAct loop with `runChecks` as the Action, no real model

- **Exercise ID:** EX-1
- **What to build:** A standalone script implementing the `reactLoop` pseudocode from Move 2, with a hardcoded, deterministic "model" (a function that returns a fixed sequence of `{thought, action}` pairs instead of calling a real LLM) and `runChecks(ALL_CHECKS, ctx)` as the one available tool. Wire at least two iterations: iteration 1 calls `runChecks` on a fixture catalog and gets findings back; iteration 2's stub "reasons" over those findings and emits a `finish` action.
- **Why it earns its place:** ReAct is easy to describe and easy to get wrong in the two places that matter — Observation formatting and the hard step budget. Building even a fake-model version forces you to write both, which is the part reading about the pattern skips.
- **Files to touch:** New scratch file, e.g. `app/scripts/toy-react-loop.ts`; imports `ALL_CHECKS`/`runChecks` from `@merchgrid/catalog-checks`.
- **Done when:** The script runs to completion via the stub model's `finish` action, and separately, a version with `maxSteps` set below what the stub needs demonstrates the "gave up after maxSteps" exit path.
- **Estimated effort:** 1-2 hours.

### Write the Bulk AI ReAct trace by hand, before any of it is built

- **Exercise ID:** EX-2
- **What to build:** A written (not coded) Thought/Action/Observation trace, in the ReAct format from Move 1, for a hypothetical Bulk AI request: "raise all size-M shirt prices 10%." Write out 2-3 realistic Thought/Action/Observation steps, using `runChecks(ALL_CHECKS, ctx)` as the Action and a plausible `CatalogFinding[]` result (modeled on this repo's real finding shape) as the Observation.
- **Why it earns its place:** This is the fastest way to test whether you actually understand both ReAct and this repo's contract well enough to combine them convincingly — a trace that reads as fake or hand-wavy is a signal you haven't internalized one or the other yet.
- **Files to touch:** No production files — a scratch markdown note.
- **Done when:** Every Observation in your trace is a value that `runChecks`'s real `CatalogFinding` shape (`app/packages/catalog-checks/src/contract.ts` lines 11-25) could actually produce.
- **Estimated effort:** 45 minutes.

## Interview defense

**Q: What problem does ReAct solve that plain chain-of-thought prompting doesn't?**
A: Chain-of-thought reasoning with no tool calls is the model reasoning about a world it can't actually check — it can "think" its way to a wrong fact and never notice. ReAct interleaves real tool results into the reasoning, so each step is grounded in something the model actually observed rather than something it guessed. The cost is latency and complexity: every step is a full model call plus a tool call, instead of one shot.
*Sketch while you say it:* the Thought → Action → Observation loop diagram from Move 1.

**Q: What's the part of a ReAct implementation people forget, and why does it matter?**
A: The hard iteration budget. Nothing about "reason, then act, then observe, then repeat" guarantees the loop ends — a model can decide it needs "just one more piece of information" indefinitely. Production ReAct loops need a `maxSteps` the host enforces regardless of what the model wants, the same way MerchGrid's own scan pipeline (no ReAct loop, but the same termination discipline) gets a guaranteed end from `state.ts`'s finite transition table rather than trusting a caller to stop on its own.
*Sketch while you say it:* the pseudocode's `for step in 1..maxSteps` line and the "gave up" fallback path.

**Q: Does MerchGrid use ReAct anywhere?**
A: No — there's no loop in this codebase where a model reasons and acts repeatedly; `runScan` is one straight pass through four fixed stages. The honest, concrete attachment point is the roadmapped Bulk AI product (spec §25.4): if that ships as an agent, its Action step would be `runChecks(ALL_CHECKS, ctx)` called against a proposed changeset instead of the live catalog — but that's a description of an unbuilt future flow, not of anything running today.
*Sketch while you say it:* the primary diagram's "✗ NOT BUILT" callout.

## See also

- `01-agents-vs-chains.md` — the fork-in-the-road decision that, if resolved toward "agent," produces exactly this loop shape.
- `02-tool-calling.md` — the Action step's real mechanism (model names a call, host executes it).
- `04-tool-routing.md` — a narrower decision (which tool, not whether to loop) that a single ReAct "Reason" step often makes.
- Product spec `merchgrid-catalog-audit-product-spec.md` §25.4 — the future flow this file's "would attach here" note is grounded in.
