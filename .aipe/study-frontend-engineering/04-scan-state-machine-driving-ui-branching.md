# 04 — Scan state machine driving UI branching

**State-machine-driven rendering (render off an enum, not ad-hoc booleans).** Language-agnostic pattern — project-specific implementation (`ScanStatus`, enforced server-side, consumed read-only by the view).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Storage ────────────────────────────────────────────────────┐
│  Scan.status: QUEUED → READING_CATALOG → RUNNING_CHECKS →       │
│               PREPARING_RESULTS → COMPLETED | FAILED             │
│  transitions enforced by state.ts (never by the client)          │
└──────────────────────────┬────────────────────────────────────┘
                            │  crosses into the browser as
                            │  a plain string, via the loader
┌─ Browser ───────────────────▼──────────────────────────────────┐
│  ScanDetail component: if (!isTerminal) ... else if (FAILED)... │
│  ★ THIS CONCEPT ★  ← we are here                                 │
│  else /* COMPLETED */ ...                                        │
└──────────────────────────────────────────────────────────────┘
```

You've written `if (isLoading) ... else if (error) ... else ...` off three separate booleans before, and you've probably watched that pattern let you render an "impossible" combination (loading *and* error both true) because nothing enforced they couldn't be. This repo sidesteps that by never inventing client-side booleans at all — the view branches directly off one server-owned enum, and that enum's own legal transitions are enforced in exactly one place, far from the component.

## Structure pass

**Axis: control — who's allowed to decide the scan has moved to the next stage?** Only the worker process, and only through `assertTransition` (`state.ts:40-56`). The browser is a pure reader of whatever value it's handed; the component tree has no code path that could set `status` to anything.

**Seam:** the `ScanStatus` string itself, crossing from `Scan` row → loader → component. Everything on the storage side of that seam is enforced (illegal transitions throw); everything on the browser side is just a `switch`/`if` over a value it trusts completely. That asymmetry — validated writer, trusting reader — is what let the UI stay this simple.

```
The seam — enforced on write, trusted on read

axis traced = "who can this value ever come from?"

┌─ storage: state.ts ────────┐  seam: Scan.status (string)  ┌─ browser: ScanDetail ─┐
│ assertTransition() gates    │ ═══════════╪═════════════════► │ reads it, branches,   │
│ every write                  │   (it flips)                  │ never writes it        │
└───────────────────────────────┘                              └─────────────────────────┘
         ▲                                                                ▲
         └────────── one value, one writer, one (trusting) reader ───────┘
```

## How it works

You've built a `<select>` bound to an enum before, where the UI's whole job was "show whichever of these N views matches the current value." That's the shape here — three views, one three/four-way branch, and the interesting engineering decision isn't the branch itself, it's *where the legality of the underlying value is enforced* (nowhere near the branch).

**The kernel: enum + legal-transition table + terminal set.**

```
State machine kernel (state.ts)

  QUEUED ──► READING_CATALOG ──► RUNNING_CHECKS ──► PREPARING_RESULTS ──► COMPLETED
     │              │                    │                    │
     └──────────────┴────────────────────┴────────────────────┴──────────► FAILED

  TERMINAL_STATUSES = { COMPLETED, FAILED }   — no outgoing transitions
  LEGAL_FORWARD_TRANSITIONS — exactly one forward step per non-terminal status
  assertTransition(from, to) — throws unless `to` is the forward step from
                                `from`, or `to === "FAILED"` from anywhere
                                non-terminal
```

### The kernel, isolated

`state.ts:9-56` in full is the entire state machine — no class, no library, four things:

```ts
// state.ts:9-15, 17-20, 23-28 (condensed)
type ScanStatus = "QUEUED" | "READING_CATALOG" | "RUNNING_CHECKS"
  | "PREPARING_RESULTS" | "COMPLETED" | "FAILED";

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);

const LEGAL_FORWARD_TRANSITIONS = {
  QUEUED: "READING_CATALOG",
  READING_CATALOG: "RUNNING_CHECKS",
  RUNNING_CHECKS: "PREPARING_RESULTS",
  PREPARING_RESULTS: "COMPLETED",
};
```

**What breaks if you removed `TERMINAL_STATUSES` and just let `LEGAL_FORWARD_TRANSITIONS` drive everything:** a `COMPLETED` scan has no entry in that table (there's nothing legal to transition *to* from `COMPLETED`), so a lookup would return `undefined` and any comparison against it would fail — but silently, not with a clear thrown error naming the state as terminal. `assertTransition` (`state.ts:40-56`) checks `isTerminal(from)` first and throws a specific, readable error before ever consulting the transition table, which is what turns "some code tried to advance a finished scan" into a loud, debuggable failure instead of an obscure `undefined`-comparison bug three layers down.

This type (`ScanStatus`) is imported by nothing in `app/app/routes/**` — the UI branches on raw strings compared against literals (`summary.status === "FAILED"`), not against the `ScanStatus` type or `isTerminal` itself re-implemented client-side. It re-derives its own `isTerminal` check locally instead (see below) rather than importing the server module's version — worth noticing as a seam that *could* import shared logic but currently duplicates one line of it.

### The component's own terminal check — a deliberate, separate copy

`app.scans.$id.tsx:57`:

```ts
// app.scans.$id.tsx:57
const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED"]);
```

This is the same two values as `state.ts:17-20`, redefined rather than imported. That's not an accident of laziness so much as a boundary choice: `state.ts` lives in a server-only module path alongside Prisma-touching code, and importing it into a route file risks pulling server-only dependencies into the client bundle (the same hazard `settings.shared.ts` was carved out specifically to avoid — see `audit.md` lens 3). The cost of the duplication: if a third terminal status were ever added to the pipeline, both copies would need updating, and nothing enforces that at compile time. A safer fix would be a tiny shared (`.ts`, not `.server.ts`) module exporting just the `ScanStatus` union and `TERMINAL_STATUSES`, following the same shared-constants pattern `settings.shared.ts` already established.

### The three-way branch itself

`app.scans.$id.tsx:502-609`, condensed to its control flow:

```
isTerminal = TERMINAL_STATUSES.has(summary.status)

if (!isTerminal)              → ScanProgressCard (stage checklist, spinner)
else if (status === "FAILED") → Banner(critical) + "Back to start"
else /* COMPLETED */          → summary cards + findings table + export
```

Three renders, one condition each, evaluated top to bottom — no state is ever computed from *combining* two independent booleans (there's no separate `isLoading` AND `isError` that could both be true at once). `ScanProgressCard` itself (`app.scans.$id.tsx:122-170`) does a second, finer-grained version of the same move: it looks up `STAGE_STATUSES.indexOf(status)` (123-125) to find which of the four in-progress stages is current, and renders a checkmark for every stage *before* that index, a spinner for the current one, and a hollow circle for every stage after — again, one lookup against an ordered list, not four independent flags that could fall out of sync with each other.

**What breaks if the UI tracked its own `isLoading`/`hasFailed`/`isDone` booleans instead of branching on the single server enum:** nothing guarantees only one of those three is ever true. A bug that failed to flip `isLoading` to `false` on completion would render the progress spinner *alongside* the results table — a real, reachable "impossible" state that a single-enum branch structurally cannot produce, because there's exactly one value and exactly one branch it can satisfy.

## Move 3 — the principle

The safest UI branching is branching directly on the value the source of truth already owns, not re-deriving a parallel set of booleans that are supposed to stay consistent with it. Every extra boolean you introduce is another combination the type system won't rule out for you — `isLoading && isDone` compiles fine even though it should be impossible. A single enum with an exhaustive branch (or, better, a `switch` the compiler can check for exhaustiveness) makes the impossible combination not just unlikely, but unrepresentable.

## Primary diagram

```
Full recap — one value, one writer, one branching reader

┌─ worker (writer) ───────────────────────────────────────┐
│  runner.server.ts calls assertTransition(from, to)        │
│  before every Scan.status write — throws on illegal move   │
└──────────────────────────┬────────────────────────────────┘
                            │ Scan.status (string)
┌─ loader (reader) ──────────▼────────────────────────────────┐
│  getScanSummary → { status, ... } — no re-validation, just    │
│  a read                                                        │
└──────────────────────────┬────────────────────────────────────┘
                            │ summary.status
┌─ component (branches) ──────▼────────────────────────────────┐
│  isTerminal ? (FAILED ? Banner : ResultsView) : ProgressCard   │
│  ProgressCard: STAGE_STATUSES.indexOf(status) → done/current/  │
│  pending per stage                                              │
└──────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the same idea a well-designed Redux reducer or a `useReducer` state machine buys you over a pile of `useState(true/false)` calls: collapsing "what can the UI be doing right now" into one value with a closed set of legal states removes an entire category of bug before it can happen. The specific cost this repo accepts: the client-side `TERMINAL_STATUSES` duplication (see above) is a small, real seam where the single-source-of-truth property could quietly break if the two copies ever drift — worth fixing with a shared constants module the moment a third terminal status is ever added, but not urgent today given how rarely this pipeline's shape changes.

`not yet exercised`: a client-side `switch` with an exhaustiveness check (a `never` fallthrough) that would catch a new `ScanStatus` value at compile time instead of silently falling into the `COMPLETED` branch by default; any animated transition between stages beyond the current stage's spinner.

## Interview defense

**Q: Why not just track `isLoading`/`isError`/`isDone` as separate flags in the component?**
A: Because nothing then prevents two of them from being true at once — a bug in one code path setting `isLoading` and never clearing it would render the loading UI right alongside the results. Branching on one server-owned enum instead means there is exactly one value, and exactly one branch it can satisfy at a time; the "impossible" combined state simply has no representation.

**Q: Where is the actual transition validated — client or server?**
A: Server, exclusively — `state.ts:40-56`'s `assertTransition`, called by the worker before every status write. The browser never validates a transition; it only ever reads whatever the server already wrote and trusts it. That asymmetry (validated writer, trusting reader) is deliberate: validating twice would mean keeping two copies of the transition table in sync across a client/server boundary for no safety benefit, since the browser can't write `Scan.status` at all.

**Q: What's the one place this pattern is slightly duplicated, and why?**
A: `app.scans.$id.tsx:57` redefines `TERMINAL_STATUSES` locally instead of importing it from `state.ts`, because `state.ts` sits in a server-only module path and importing it risks pulling server-only code into the client bundle — the same hazard that motivated carving `settings.shared.ts` out of `settings.server.ts`. The fix, if this ever needs to change, is a tiny non-`.server.ts` shared module, not a client-side import of the server file.

## See also

- `01-loader-driven-progress-polling.md` — `isTerminal` is exactly the value the polling effect's stop condition watches.
- `.aipe/study-system-design/02-atomic-idempotent-scan-pipeline.md` — how `assertTransition` gets enforced inside the actual scan run, and what happens on a mid-pipeline failure.
- `audit.md` → lens 1 (rendering and reactivity), lens 2 (state architecture).
