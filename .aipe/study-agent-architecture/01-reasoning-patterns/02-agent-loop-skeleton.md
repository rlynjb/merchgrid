# The agent loop skeleton

Industry standard (the kernel underlying ReAct, plan-and-execute, reflexion, and every multi-agent topology). Language-agnostic.

## Zoom out, then zoom in

```
Zoom out — where a loop kernel would sit, if this codebase had one

┌─ Worker layer ────────────────────────────────────────────────┐
│  worker.ts: while(!shuttingDown) { claimAndRunNext(); sleep }  │
│  ★ a REAL bounded loop — but its step function is fixed code ★│
└─────────────────────────────┬──────────────────────────────────┘
                              │
┌─ Read layer ─────────────────▼──────────────────────────────────┐
│  catalog-reader.server.ts: for(;;) { fetch page; check budget }│
│  ★ a REAL loop with a success exit AND a budget exit ★         │
└──────────────────────────────────────────────────────────────────┘

┌─ What's missing for either of these to be an "agent loop" ──────┐
│  a step function where a MODEL — not code — picks the next     │
│  action. Neither loop above has one. This file teaches the     │
│  kernel so you can recognize it if one is ever added.           │
└──────────────────────────────────────────────────────────────────┘
```

Every named reasoning pattern — ReAct, plan-and-execute, reflexion, tree of thoughts — and every multi-agent topology in this guide's SECTION C is the *same four-part kernel* with a different step function bolted in. Learn the kernel once here, and the rest of this guide can point back at it instead of re-deriving it every time.

**In this codebase:** not yet implemented — there is no model-decided step function anywhere in this repo. But two *loops that already exist* here are worth studying against this kernel, because they get half of it right (state, execute, termination) without the "smart" part (a model choosing the next action) — which makes them a genuinely useful contrast, not a stretch.

## The structure pass

**Layers:** the loop kernel has one internal layer worth separating — the *step function* (the one part that's replaceable: code today, a model call if this ever becomes agentic) versus everything around it (state, execution, termination), which stays the same either way.

**Axis to trace: control — who decides the next action, and does the loop know when to stop?**

```
One axis, traced across the kernel's parts

  ┌─────────────┐   ┌─────────┐   ┌───────────┐   ┌─────────────┐
  │ state       │──►│ step()  │──►│ execute() │──►│ terminate?  │
  │ (accumulate)│   │(decide) │   │(run it)   │   │ (2 exits)   │
  └─────────────┘   └─────────┘   └───────────┘   └─────────────┘
        │                 │              │               │
   who owns it?      who decides?   who runs it?    who guarantees
   (the loop,        (THIS is the    (the harness,   it stops?
   always)           only variable   never the       (the loop
                     part)           step function)  itself, always)

  three of four parts never change between a chain-shaped loop
  and a model-shaped loop. only step() flips. that's the seam.
```

**Seam:** the step function is the only load-bearing seam in this kernel — swap code for a model call there and everything downstream (state accumulation, execution, termination) is unchanged. That's why this file teaches the kernel independent of "is it an LLM" — the skeleton is agnostic to what's inside `step()`.

## How it works

### Move 1 — the mental model

You already know a `while` loop with an exit condition. The agent loop kernel is that, plus one extra decision baked into every iteration: *what should happen this time around* isn't hardcoded — it's computed by calling `step()`, which in an LLM agent is a model inference call.

```
The kernel — every reasoning pattern and topology in this guide
is this shape with a different step() implementation

  runLoop(state, tools):
    while not done:
      action = step(state)          # who decides: code or model?
      if action.is_final:           # ─┐ termination,
        return action.output        #  │ exit 1 (success)
      result = execute(action, tools)
      state  = update(state, result)  # accumulate
      if budget_exceeded(state):     # ─┐ termination,
        return fallback(state)       #  │ exit 2 (budget)
```

### Move 2 — the load-bearing skeleton

**Isolate the kernel.** The pseudocode above is the whole pattern — nothing in it can be removed and still be "an agent loop." Four parts, named by what breaks when each is missing:

- **state (accumulate)** — without it, every turn is amnesiac: N independent calls, not a loop. State is the thing that turns repetition into progress.
- **step function** — without it, nothing chooses the next action. This is the only part that's "smart," and the only part that changes between a chain and an agent.
- **execute (run it, feed the result back)** — the step function only ever emits *intent*; something else has to actually run it and hand the result back. The model (or code) never touches the real world directly — that boundary is the whole control/safety story for any autonomous system.
- **termination — two exits, both required.** This is the part everyone forgets to name unprompted, and naming it is the strongest signal in this file.

**The two exits, made concrete against this codebase's real code.** The success exit is obvious — the loop finishes because it reached its goal. The exit people skip is the budget exit: *nothing guarantees the success exit is ever reached*, so a hard cap has to exist independent of whether the work is "done." Both real loops in this repo already carry this discipline, even with a hardcoded step function:

```typescript
// app/app/services/shopify/catalog-reader.server.ts:410-451 — readCatalog's loop
for (;;) {
  const body = await runQuery(admin, PRODUCTS_PAGE_QUERY, { cursor }, policy);
  // ...fetch this page, process it...
  if (truncated || variantsProcessed >= opts.variantLimit) {
    // ── exit 2: BUDGET. variantLimit is a hard cap independent of
    //    whether more pages exist — this is the exact "budget_exceeded"
    //    branch from the kernel pseudocode, just named `variantLimit`.
    return { products, productsProcessed, variantsProcessed, partial: true };
  }
  if (!pageInfo.hasNextPage) {
    // ── exit 1: SUCCESS. the catalog is exhausted — this is the
    //    kernel's `action.is_final`, just spelled `!hasNextPage`.
    return { products, productsProcessed, variantsProcessed, partial: false };
  }
  cursor = pageInfo.endCursor ?? undefined;   // ── state (accumulate)
}
```

Read that against the kernel: `cursor` and the running `variantsProcessed` count are the loop's `state`; "fetch the next page" is `execute`; the two `return`s are the two termination exits. The only thing missing to call this "an agent loop" is a `step()` that a model computes — today, "fetch the next page unless the budget or the pages run out" is fixed logic, not a decision. `worker.ts:69-89`'s poll loop is the same shape one layer up: `while (!shuttingDown)` is the loop, `claimAndRunNext()` is `execute`, and the exit is an external signal (SIGINT/SIGTERM) rather than an internal budget — a third valid termination style worth naming: **externally triggered shutdown**, which a production agent loop needs too (a human-in-the-loop kill switch), on top of the success and budget exits.

**Separate skeleton from hardening.** The kernel is the minimum that makes something a loop. Everything past the four parts is optional hardening layered on top — and this repo already demonstrates several of these hardening layers, again without a model in the loop: `catalog-reader.server.ts:200-241`'s `runQuery` adds retry-with-backoff on top of `execute` (a hardening layer any agent's tool-execution step would also need); `worker.ts:32-61`'s idle-sleep-cancel logic is graceful-shutdown hardening on top of the poll loop's termination. Naming which parts are skeleton (state, step, execute, two exits) versus which are hardening (retry, backoff, graceful shutdown, observability) is itself the lesson — not just this file's, but the one that transfers to the next loop you build, agentic or not.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition and a hard budget — a rule this codebase already follows for its non-agentic loops (`variantLimit`, `!hasNextPage`, `shuttingDown`), which is exactly why they were worth reading closely here: the discipline of "know your two exits before you ship the loop" doesn't originate with LLMs. It's a property of any bounded, repeating process, and a codebase that gets it right without a model in the loop is well-positioned to get it right if a model is ever dropped into the `step()` slot.

## Primary diagram

```
The kernel, with this codebase's real loops mapped onto each part

  ┌─────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
  │ state        │──►│ step()       │──►│ execute()     │──►│ terminate?   │
  │ cursor,      │   │ TODAY: fixed │   │ runQuery()    │   │ variantLimit │
  │ variantsProc-│   │ code ("next  │   │ (with retry/  │   │ (budget) or  │
  │ essed        │   │ page or      │   │ backoff       │   │ !hasNextPage │
  │              │   │ stop")       │   │ hardening)    │   │ (success)    │
  │              │   │ FUTURE (Bulk │   │               │   │              │
  │              │   │ AI, not      │   │               │   │              │
  │              │   │ built): a    │   │               │   │              │
  │              │   │ model call   │   │               │   │              │
  └─────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
```

## Elaborate

This kernel is the reason ReAct, plan-and-execute, and reflexion don't need to be learned as three unrelated patterns — they're the same four parts with `step()` prompted differently (interleave reason/act; plan up front then execute; critique your own output and retry). `01-reasoning-patterns/03-react.md` through `06-tree-of-thoughts.md` all point back here rather than re-deriving state/execute/terminate each time. The same collapse happens one level up: SECTION C's multi-agent topologies are N of this kernel composed, with an orchestrator deciding how the individual loops' outputs combine — supervisor-worker is N kernels fanning in through a merge step; a debate topology is two kernels whose `execute` step is "read the other agent's last output."

## Interview defense

**Q: "What are the load-bearing parts of an agent loop, and which one is optional?"**
A: Four parts are load-bearing — state, the step function, execute, and two-exit termination. Nothing about a model is required for three of the four; this codebase's own `readCatalog` pagination loop proves that, since it has state (cursor), execute (fetch page), and two real termination exits (`variantLimit` budget, `!hasNextPage` success) with zero model involved. The only thing that changes when a system becomes "agentic" is what computes `step()`.
*Sketch while you say it:* the primary diagram, with the real file/line references for each box.

**Q: "What's the part people forget when they build an agent loop?"**
A: The budget exit. It's easy to code the success path (the model says it's done) and forget that nothing guarantees the model ever reaches it — it can cycle indefinitely. This codebase's `variantLimit` guardrail in `catalog-reader.server.ts` and `worker.ts`'s `shuttingDown` flag are both non-agentic examples of exactly this discipline: a hard stop that doesn't depend on the "smart" part of the loop deciding it's done.

**Q: "Is a fixed poll loop like this repo's worker basically an agent loop already?"**
A: No — it has the shape (state, execute, two-exit termination) but not the defining feature: nothing in it decides. `claimAndRunNext()` always does the same thing (claim the oldest QUEUED scan); there's no point where it looks at the situation and picks between multiple next actions. That's the entire distinction this file exists to sharpen — shape versus decision-maker.

## See also

- `01-reasoning-patterns/01-chains-vs-agents.md` — the boundary question this file assumes answered ("is there a loop with a model-decided step at all") before this file asks "what's inside the loop."
- `01-reasoning-patterns/03-react.md` — the first named pattern that plugs a model into this kernel's `step()`.
- `04-agent-infrastructure/01-guardrails-and-control.md` — the full control envelope (caps, cost ceiling, human gate) that would wrap this kernel in production; this file's job was narrower — establishing that the budget exit belongs to the skeleton itself.
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — the escalation gate for composing N of this kernel together.
