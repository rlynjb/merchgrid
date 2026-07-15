# Agent Memory

**Agent memory (short-term/working memory vs. long-term/persisted memory) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where agent memory would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────────┐
│  app._index.tsx, app.scans.$id.tsx  →  loaders/actions          │
└─────────────────────────┬─────────────────────────────────────┘
                          │ HTTP, session-authenticated
┌─ Service layer — app/app/services/scan/ ─────────────────────────┐
│  runner.server.ts: runScan() — no model, so nothing here reads    │
│  or writes anything as "memory" in the agent sense                │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ──────────────────────────┐
│  runChecks(ALL_CHECKS, ctx) — stateless, pure, no memory of any   │
│  prior scan influences this run at all                            │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Storage layer — Prisma / SQLite ─────────────────────────────────┐
│  Scan, Finding rows — REAL persisted state, but nothing ever      │
│  reads it back as conversational/agent memory ★                  │
└───────────────────────────────────────────────────────────────────┘
```

This one needs a careful distinction before anything else, because MerchGrid has real, persisted application state and it would be easy to mistake that for "agent memory." It isn't — this file draws that line precisely, then teaches agent memory as the general pattern it is everywhere it actually shows up.

## Structure pass

**Layers (general pattern):** short-term/working memory lives inside a single agent run — the growing transcript of Thought/Action/Observation steps from `03-react-pattern.md`, held in the context window and gone when the run ends. Long-term memory lives outside any single run, in a store (a database, a vector index, a key-value cache) the agent explicitly reads from and writes to across separate conversations or tasks.

**Axis: state — who owns it, where does it live, is it mutable, and does anything ever read it back as memory?** MerchGrid's `Scan` and `Finding` rows (Prisma/SQLite) are real, durable, mutable application state — but nothing that produces them or reads them is a model, and nothing ever feeds a past `Scan` row back into a model's context to influence a future decision. That's the exact test that separates "persisted state" from "agent memory": the same row can be either, depending only on whether something reasoning over it treats it as memory.

**Seam:** there's no seam here to trace across in this codebase, because there's no agent on either side of any boundary. The nearest real seam is between `runScan` and the `Scan`/`Finding` tables — but it's a plain read/write boundary to a relational store, not a memory-retrieval boundary. Naming that difference precisely — "this repo has persistence, not agent memory" — is the honest finding.

## How it works

### Move 1 — the mental model

You know the difference between a component's local `useState` and a value read from a database on page load — one dies when the component unmounts, the other survives across sessions and users. Agent memory is exactly that same split, one layer up: short-term memory is the agent's "state while this task is running" (it dies when the run ends, the way `useState` dies on unmount), and long-term memory is "state this agent can read back on a *different* run" (it survives, the way a database row does).

```
Pattern — two kinds of memory, two different lifetimes

  ┌─ Short-term / working memory ───────────────────────┐
  │  the growing Thought/Action/Observation transcript   │
  │  lives in: the context window, for THIS run only     │
  │  dies when: the run ends                              │
  └───────────────────────────────────────────────────────┘

  ┌─ Long-term / persisted memory ─────────────────────────┐
  │  facts, past conversations, prior decisions             │
  │  lives in: a database, vector store, key-value cache    │
  │  survives: across runs, across users, across sessions    │
  │  requires: an explicit WRITE after a run, an explicit    │
  │            READ (often a retrieval step) before the next │
  └───────────────────────────────────────────────────────────┘
```

The underlying strategy in one sentence: a model call is stateless by default (as `01-what-an-llm-is.md` establishes — no request remembers a prior one), so anything you want an agent to "remember" across separate calls has to be engineered as an explicit write-then-read loop through some store; there's no memory an LLM API gives you for free.

### Move 2 — the step-by-step walkthrough

**Part 1 — short-term memory is just "resend the transcript."** Every multi-turn agent loop (ReAct or otherwise) re-sends its entire accumulated history — every prior Thought, Action, and Observation — as input tokens on every single call, because the model itself retains nothing between calls. This is the same fact `01-what-an-llm-is.md` names for plain chat: "conversation history" isn't stored inside the model, it's stored by the host and resent. The consequence that bites in production: a long-running agent's context grows every step, until it either exceeds the model's context window or the cost of resending it all gets prohibitive — which is why systems add summarization (compact the older half of the transcript into a shorter summary before resending) once a run gets long.

**Part 2 — long-term memory needs a retrieval step, not just a bigger database.** Writing "the user prefers metric units" to a table is trivial; the hard part is *finding* the three facts relevant to the current request out of thousands stored across weeks of past sessions, without resending all of them (which defeats the purpose and blows the context budget from Part 1). That's why long-term agent memory usually means an embedding-indexed store (see `03-retrieval-and-rag/01-embeddings.md`'s pattern) queried for the handful of memories relevant to *this* turn, not a full table dump.

**Part 3 — episodic vs. semantic memory, the distinction that matters for design.** Episodic memory is "what happened in a specific past interaction" (a specific prior conversation, a specific prior decision and its outcome) — useful for "last time this exact situation came up, what did we do?" Semantic memory is "a durable fact, independent of when or how it was learned" (a user's stated preference, a business rule) — useful regardless of which past conversation it came from. Systems that conflate the two end up either re-litigating the same fact in every conversation (no semantic memory) or losing the specific context of *why* a past decision was made (no episodic memory).

**In this codebase:** MerchGrid's `Scan` and `Finding` Prisma rows are real, durable state — but they are not agent memory by the definition above, because nothing that writes or reads them is a model, and nothing ever retrieves a past scan's rows to influence how a *future* scan runs. Each scan's `runChecks(ALL_CHECKS, ctx)` call is stateless with respect to every prior scan — the `CatalogCheckContext` (`contract.ts` lines 5-9) is built fresh from the live catalog and the shop's current settings every time, and nothing about a previous `Scan`'s outcome ever feeds into it. If MerchGrid ships the roadmapped "MerchGrid: Bulk AI" (product spec §25.4), the natural attachment point for real agent memory is the approval loop itself: a merchant might reject a proposed changeset with feedback ("don't touch clearance-tagged products"), and a genuinely agentic Bulk AI would need to remember that instruction across a multi-turn negotiation — semantic memory, in the Part 3 sense — rather than treating every proposal as a stateless first attempt. That's a real design requirement for an unbuilt product, not a description of anything running today.

### Move 3 — the principle

Memory isn't a feature you get by pointing an agent at a database — it's an explicit engineering decision about what to write, when to retrieve it, and how to keep the retrieved slice small enough to fit a stateless model call's context window. The load-bearing distinction to carry forward: persisted state and agent memory are not the same thing just because both live in a database — the difference is entirely in whether something reasoning over that data treats it as memory of a past interaction that should shape a future one. A system can have extensive, well-designed persisted state (MerchGrid does) and zero agent memory (MerchGrid also does), and that's not a contradiction — it's what a fully deterministic system with no model in the loop looks like.

## Primary diagram

```
Primary diagram — persisted state (real) vs. agent memory (absent)

┌─ MerchGrid today — persisted state, not agent memory ───────────┐
│  Scan / Finding rows (Prisma/SQLite)                              │
│  written by: runScan (deterministic pipeline)                     │
│  read by: the UI (findings list), CSV export — never by a model  │
│  each new scan's runChecks() call: stateless w.r.t. every         │
│  prior scan — nothing about the past ever feeds forward           │
└─────────────────────────────────────────────────────────────────────┘

┌─ Agent memory (general pattern, NOT built here) ──────────────────┐
│  short-term: this run's Thought/Action/Observation transcript      │
│  long-term: a store an agent explicitly WRITEs to after a run     │
│             and RETRIEVEs a relevant slice from before the next    │
└─────────────────────────────────────────────────────────────────────┘

             ✗ no agent, so no memory — the closest attachment
               point is Bulk AI's approval loop (spec §25.4):
               remembering a merchant's rejection feedback across
               a multi-turn changeset negotiation
```

## Elaborate

"Memory" entered the agent-engineering vocabulary specifically to name the gap that a stateless model API leaves open — early chatbot frameworks called it "conversation memory" for the simple resend-the-transcript case, and the term expanded as agents got long-running enough that resending everything stopped being viable. Vector-store-backed long-term memory (store an embedding per remembered fact, retrieve the nearest few at query time) is the dominant current implementation because it solves Part 2's retrieval problem cheaply, but it's an implementation choice, not the definition — memory is defined by the write-then-retrieve *behavior*, not by which storage engine backs it. The interesting failure mode worth knowing: memory that's too eager to write (an agent that persists every passing detail as a "fact") degrades retrieval quality over time, because the relevant handful of memories gets buried in noise — the same signal-to-noise problem any search or retrieval system faces, just with the added twist that the "documents" here are the agent's own past outputs.

## Project exercises

### Prove `runChecks` has zero memory across scans

- **Exercise ID:** EX-1
- **What to build:** A small test (or scratch script) that runs `runChecks(ALL_CHECKS, ctx)` twice in a row against two different `CatalogCheckContext` fixtures representing "the same shop, one day apart, with one variant's price fixed in between" — and confirms the second run's findings depend *only* on the second context, with no leftover influence from the first run's findings or from any global/module-level state.
- **Why it earns its place:** This is the fastest way to convert "MerchGrid has no agent memory" from an assertion into something you've verified — and it doubles as a real regression test for an important property (statelessness) this codebase actually needs to keep for its determinism guarantee to hold.
- **Files to touch:** New test file, e.g. `app/packages/catalog-checks/src/run.no-memory.test.ts`, or a scratch script if you'd rather not add a permanent test.
- **Done when:** The second run's findings differ from the first *only* in the ways the changed context explains, and re-running the first context again afterward reproduces the exact original findings.
- **Estimated effort:** 45 minutes.

### Design (on paper) the memory a Bulk AI approval loop would need

- **Exercise ID:** EX-2
- **What to build:** A written design (a scratch note, no code) for what a Bulk AI approval loop's memory store would need to hold, using the episodic-vs-semantic split from Move 2 Part 3. Specify: what counts as episodic ("last time we proposed a price change on this SKU, the merchant rejected it") vs. semantic ("this merchant never wants clearance-tagged products touched"), and sketch the retrieval query each would need at the start of a new proposal.
- **Why it earns its place:** Forces you to apply the episodic/semantic distinction to a concrete, plausible future feature in this exact codebase rather than a generic example — which is what makes the distinction stick well enough to defend in an interview.
- **Files to touch:** No production files — a scratch note.
- **Done when:** Your design names, for at least three example memories, which category each falls into and why conflating them would cause a real problem (re-litigating a settled preference, or losing the specific reason a past proposal was rejected).
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: Does MerchGrid have agent memory?**
A: No — and it's worth being precise about why the `Scan`/`Finding` tables don't count. They're real, durable, persisted state, but nothing that reads or writes them is a model, and no past scan's data ever gets retrieved to influence a future scan's outcome. `runChecks` is stateless with respect to every prior run by design — that statelessness is exactly what makes MG-003 reproducible on identical data.
*Sketch while you say it:* the primary diagram's top box, with the "never by a model" annotation on the read arrow.

**Q: What's the difference between persisted application state and agent memory, in general?**
A: Both can live in the same database — the difference is entirely behavioral: agent memory is state a model reasoning process explicitly writes after a run and retrieves before a future one, to let a past interaction shape a future decision. Plain persisted state is written and read by deterministic code with no reasoning step involved. The same row can be either, depending only on who's on the read/write side.
*Sketch while you say it:* the two-box "short-term vs. long-term" diagram from Move 1, relabeled with "who reads/writes this" underneath each.

**Q: If Bulk AI needed memory, what kind, and why?**
A: Semantic memory, primarily — durable facts like a merchant's standing preference ("never touch clearance-tagged products") that should apply across every future proposal, not just the specific conversation where it was stated. Episodic memory (the record of a specific past rejection and why) would matter too, for explaining *why* a rule exists when a merchant asks. Neither exists today because there's no agent to own them.
*Sketch while you say it:* the episodic-vs-semantic split from Move 2 Part 3, with one Bulk AI example under each.

## See also

- `01-agents-vs-chains.md` — the absence of any loop in this codebase that could own memory in the first place.
- `03-react-pattern.md` — where short-term/working memory actually lives inside a single agent run (the growing transcript).
- `03-retrieval-and-rag/01-embeddings.md` — the retrieval mechanism long-term agent memory is usually built on top of.
