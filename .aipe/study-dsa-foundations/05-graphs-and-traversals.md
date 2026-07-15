# 05 — Graphs and traversals

### Graph models, state machines as directed graphs, BFS/DFS, shortest paths — Industry standard

## Zoom out, then zoom in

A scan moves through five non-terminal states before it's done, and can fail
out of any of them. That's a graph — nodes are statuses, edges are legal
transitions — even though nothing in `state.ts` uses the word "graph." Once
you name it as a graph, questions that felt like special-cased `if`
statements ("can a `COMPLETED` scan go anywhere?", "can any state jump
straight to `FAILED`?") become graph properties you can check systematically:
which nodes are sinks, which edges exist, is there a cycle.

```
Zoom out — where the graph lives

┌─ Service layer — services/scan/state.ts ──────────────────────────┐
│  ScanStatus = 6 nodes                                               │
│  ★ LEGAL_FORWARD_TRANSITIONS = a directed edge list ★               │
│  assertTransition() = an edge-membership check     ← we are here   │
└──────────────────────────┬──────────────────────────────────────┬─┘
                            │ called by                            │
┌─ Service layer — runner.server.ts ─────────────────────────────────┘
│  advances the scan through the graph, one edge per pipeline stage  │
└────────────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** the graph definition (`state.ts`, pure data + one guard
function) sits below the code that actually walks it (`runner.server.ts`,
which calls `assertTransition` at each stage boundary).

**Axis to trace: control — who decides which edge gets taken next?**

```
"Who decides the next edge?" — traced across the two layers

┌─ state.ts ─────────────────────┐   ┌─ runner.server.ts ─────────────┐
│ DEFINES which edges are legal   │   │ DECIDES to attempt one          │
│ (LEGAL_FORWARD_TRANSITIONS,      │   │   specific edge, at each        │
│ FAILED reachable from any        │   │   pipeline stage, and calls     │
│ non-terminal node)                │   │   assertTransition to verify    │
│ has no opinion about WHEN         │   │   it's legal before committing  │
└────────────────────────────────────┘   └──────────────────────────────────┘
```

**Seam:** `state.ts` never runs a transition — it only validates one.
`runner.server.ts` decides *when* to move (after `readCatalog` succeeds,
move to `RUNNING_CHECKS`) but defers to `assertTransition` for *whether* the
move is legal. That split is the whole reason a partial/aborted run can
never be silently relabeled as further along than it actually got (the
docstring at `state.ts:1-8` says this directly): the code that has an
incentive to "just mark it done" (the runner, mid-pipeline) is not the code
that owns the rules about what's allowed.

## How it works

### Move 1 — the mental model

You've drawn a state diagram before — bubbles for states, arrows for
transitions, exactly the shape of a directed graph. What's different here
from a textbook graph problem is scale: this graph has six nodes and five
edges total. That's small enough that no traversal algorithm is needed at
all — you don't run BFS to check whether an edge exists, you just look it
up. The graph vocabulary is still the right lens, though, because it's what
lets you answer "is this correct?" precisely: which nodes are sinks (no
outgoing edges), and is the whole thing acyclic.

```
Pattern — the scan pipeline as a directed graph

  QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED
    │              │                     │                   │              (sink)
    │              │                     │                   │
    └──────────────┴─────────────────────┴───────────────────┘
                          │  (FAILED reachable from every
                          ▼   non-terminal node)
                       FAILED
                       (sink)
```

### Move 2 — the walkthrough

**Nodes — the `ScanStatus` type.** `state.ts:9-15` enumerates every node in
the graph as a TypeScript union — a closed, finite vertex set:

```ts
// app/app/services/scan/state.ts:9-15
export type ScanStatus =
  | "QUEUED"
  | "READING_CATALOG"
  | "RUNNING_CHECKS"
  | "PREPARING_RESULTS"
  | "COMPLETED"
  | "FAILED";
```

Six nodes. A union type instead of a `string` is what makes "is this even a
valid node?" a compile-time question rather than a runtime one — you cannot
construct a `ScanStatus` the graph doesn't know about.

**Sinks — nodes with no outgoing edges.** `state.ts:17-20` names the two
sinks explicitly, as a set:

```ts
// app/app/services/scan/state.ts:17-32
const TERMINAL_STATUSES: ReadonlySet<ScanStatus> = new Set(["COMPLETED", "FAILED"]);

export function isTerminal(status: ScanStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
```

In graph terms, `isTerminal` is an out-degree-zero check — but instead of
computing "does this node have any outgoing edges?" by inspecting the edge
list, the code just maintains a separate, explicit set of the two nodes that
have none. That's a deliberate readability tradeoff: computing it from the
edge list would be equally correct and one line longer, but naming the
sinks directly is what makes `assertTransition`'s first check
self-explanatory.

**Edges — the forward path, plus the wildcard failure edge.**
`state.ts:23-28` is the entire non-failure edge list:

```ts
// app/app/services/scan/state.ts:22-28
// The single legal forward path through the pipeline.
const LEGAL_FORWARD_TRANSITIONS: Readonly<Record<string, ScanStatus>> = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```

Four edges, one per non-terminal node, each pointing at exactly one
successor — this graph has **out-degree exactly one** for every forward
edge, which is what makes it a chain rather than a general graph (a chain
is the degenerate case of a DAG: no branching, no merging, one path from
start to finish). The `FAILED` edges aren't in this map at all — they're
handled as a rule, not a lookup, in `assertTransition`.

**Edge-membership check — `assertTransition`.** `state.ts:40-56` is the
whole "is this a legal move" function:

```ts
// app/app/services/scan/state.ts:40-56
export function assertTransition(from: ScanStatus, to: ScanStatus): void {
  if (isTerminal(from)) {
    throw new Error(/* … */);            // sinks have NO outgoing edges — full stop
  }
  if (to === "FAILED") {
    return;                                // FAILED is reachable from every non-terminal node
  }
  if (LEGAL_FORWARD_TRANSITIONS[from] === to) {
    return;                                // matches the one legal forward edge from `from`
  }
  throw new Error(`Illegal scan transition: ${from} -> ${to}.`);
}
```

Read this as three graph rules in order, each one a check you'd write for
*any* directed graph, not just this one: (1) a sink has no outgoing edges,
full stop — check this first because it overrides everything else; (2) one
specific node (`FAILED`) is reachable from every non-terminal node — a
"wildcard" edge that doesn't need to appear in the forward-edge map because
it's the same rule for all five sources; (3) otherwise, look up the one
legal forward edge and compare. What breaks if you drop rule (1): a
`COMPLETED` scan could be "transitioned" back to `FAILED` after the fact —
exactly the bug the docstring at the top of the file (lines 1-8) says this
whole module exists to prevent.

**Execution trace — three transition attempts:**

```
Execution trace — assertTransition, three calls

call 1: assertTransition("QUEUED", "READING_CATALOG")
  isTerminal("QUEUED")?              false
  to === "FAILED"?                    false
  LEGAL_FORWARD_TRANSITIONS.QUEUED    "READING_CATALOG" === "READING_CATALOG" → MATCH
  result: returns normally (legal)

call 2: assertTransition("RUNNING_CHECKS", "FAILED")
  isTerminal("RUNNING_CHECKS")?       false
  to === "FAILED"?                     true → MATCH (wildcard edge)
  result: returns normally (legal)

call 3: assertTransition("COMPLETED", "RUNNING_CHECKS")
  isTerminal("COMPLETED")?            true (COMPLETED is a sink)
  result: throws immediately — "COMPLETED is terminal and cannot transition"
```

Call 3 is the case that matters most: `COMPLETED` is checked as terminal
*before* anything else runs, so no downstream edge lookup even gets a
chance to (incorrectly) allow a "step backward."

### Move 3 — the principle

**A finite, small state machine is still a graph, and naming it as one buys
you graph vocabulary for free — sinks, edges, reachability — even when the
graph is small enough that you'll never need a traversal algorithm to
reason about it.** The moment this graph grows a branch (say, a `PAUSED`
status reachable from `RUNNING_CHECKS` and able to resume to either
`RUNNING_CHECKS` or `FAILED`), the same lookup-table approach still works —
but a *reachability* question ("can a scan ever get from `PAUSED` back to
`COMPLETED`?") stops being answerable by eyeballing a 4-entry map and starts
being a BFS/DFS reachability question over a real edge list.

## Primary diagram

```
Graphs and traversals — the full picture

  nodes (ScanStatus, 6 total):
    QUEUED, READING_CATALOG, RUNNING_CHECKS, PREPARING_RESULTS,  (non-terminal)
    COMPLETED, FAILED                                             (terminal / sinks)

  forward edges (out-degree 1 each, from LEGAL_FORWARD_TRANSITIONS):
    QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED

  wildcard edge (from assertTransition's rule, not a map entry):
    { QUEUED, READING_CATALOG, RUNNING_CHECKS, PREPARING_RESULTS } ──► FAILED

  sink check (isTerminal, rule (1) in assertTransition):
    COMPLETED, FAILED → no outgoing edges, checked FIRST, overrides everything

  runner.server.ts calls assertTransition(from, to) at every pipeline stage
  boundary before committing the new status — never trusts a caller-supplied
  status without validating the edge first.

  not yet exercised: BFS/DFS, shortest path, cycle detection, topological
  sort — this graph is a single chain, so no traversal algorithm is needed
  yet. See "Elaborate" for where one would attach if the graph grew branches.
```

## Elaborate

Modeling a workflow's legal transitions as a directed graph is the same
underlying idea behind CI/CD pipeline DAGs, Kubernetes pod lifecycle states,
and order-fulfillment status machines — anywhere "what can happen next"
needs to be enforced, not just documented. The traversal algorithms
(BFS/DFS, topological sort, cycle detection) become necessary the instant
the graph stops being a simple chain: a build pipeline with parallel stages
needs topological sort to decide execution order; a workflow with retry
loops needs cycle detection to make sure a retry can't spin forever without
a way out. MerchGrid's check-dependency comment in `mg-003.ts` ("Below-cost
(negative margin) variants are MG-002's job; skip here to avoid
double-flagging") is a *semantic* dependency between two checks that's
currently enforced only by a code comment and by both checks reading the
same input — if the check suite grew and checks needed to run in a specific
order based on real data dependencies (not just avoiding duplicate
findings), that dependency would need to become an explicit graph (nodes =
checks, edges = "runs after"), with a topological sort deciding execution
order — exactly the DAG-scheduling pattern build systems use. This repo
doesn't need that yet: `run.ts`'s `runChecks` treats all ten checks as
order-independent (`checks.flatMap((c) => c.run(ctx))`), and MG-003's
dependency on MG-002 is a "don't double-report," not a "must run after," so
no ordering is actually enforced or required.

## Interview defense

**Q: "Is `state.ts` really a graph, or is that overselling a lookup
table?"**
A: It's a graph — a small, degenerate one (a chain plus one wildcard edge),
but a graph nonetheless: a finite vertex set (`ScanStatus`), a directed edge
relation (`LEGAL_FORWARD_TRANSITIONS` plus the `FAILED` rule), and a
membership check (`assertTransition`) that's exactly "does this edge exist
in the graph." Calling it a lookup table isn't wrong, but it undersells what
the lookup table *is*: an adjacency representation for a 6-node directed
graph. The vocabulary matters because it's what tells you the right next
question if the graph grows — reachability, cycles, topological order — none
of which "it's a lookup table" prompts you to ask.
*(sketch: the primary diagram's node/edge list)*
One-line anchor: **a state machine IS a graph; the size of the graph, not
the concept, is what's small here.**

**Q: "Why check `isTerminal(from)` before checking whether `to` matches the
forward-edge map?"**
A: Order matters because it's a precedence rule, not just a sequence of
independent checks. A terminal node has no outgoing edges *at all* — that
has to win over every other rule, including the `FAILED`-is-reachable-from-
anywhere wildcard. If the terminal check ran last, a bug where `to ===
"FAILED"` is checked first would let a `COMPLETED` scan "transition" to
`FAILED`, silently un-completing a finished scan.
One-line anchor: **sink-check first means a terminal node's "no edges out"
rule can never be shadowed by a more permissive rule below it.**

## See also

- `03-stacks-queues-deques-and-heaps.md` — the FIFO queue that decides
  *when* a scan gets a chance to attempt its next edge in this graph.
- `.aipe/study-system-design/02-atomic-idempotent-scan-pipeline.md` — the
  transaction boundary around each edge traversal (why a transition and its
  side effects commit together or not at all).
- `08-dsa-foundations-practice-map.md` — where BFS/DFS practice would
  connect to a grown version of this graph.
