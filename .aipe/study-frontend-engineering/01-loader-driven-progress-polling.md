# 01 — Loader-driven progress polling

**Client-side polling (short-polling) over a stateless request/response cycle.** Industry-standard pattern — project-specific wiring (`useRevalidator` re-running a Remix loader, not a hand-rolled `fetch` loop).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Browser ────────────────────────────────────────────────────┐
│  app.scans.$id.tsx component                                    │
│  setInterval(2.5s) → revalidator.revalidate()  ★ THIS CONCEPT ★ │ ← we are here
└──────────────────────────┬────────────────────────────────────┘
                            │  re-invokes the SAME route's loader
┌─ Remix (server) ──────────▼──────────────────────────────────┐
│  app.scans.$id.tsx loader → getScanSummary(shop, scanId)       │
└──────────────────────────┬────────────────────────────────────┘
                            │  reads
┌─ Storage ──────────────────▼──────────────────────────────────┐
│  Scan.status, mutated only by the worker process               │
└──────────────────────────────────────────────────────────────┘
```

You've built a `fetch()` with loading/success/error states before. This is that, minus the manual `fetch` — Remix's own client router re-runs the route's `loader` function on a timer and swaps in whatever it returns, the same way it would after a real navigation. The only new idea is *why* it's on a timer at all: nothing pushes "the scan finished" to the browser, so the browser has to keep asking.

## Structure pass

**Axis: control — who decides when the UI updates?** Nothing server-side ever tells the browser "re-render now." The browser decides, on a fixed interval, to ask again. That makes this a **pull** model end to end — the same axis this repo's job queue trips on the *backend* side (`.aipe/study-system-design/01-single-worker-db-queue.md`: the worker also polls, never gets pushed to). Same shape, two different layers.

**Seam:** `summary.status` — read by the loader on every poll, and by the component's `isTerminal` check (`app.scans.$id.tsx:510`) that decides whether to keep polling at all. The component never inspects any other field to make that call; `status` is the single value the poll loop watches.

```
The seam — control flips from "ask" to "stop asking"

axis traced = "who decides whether to poll again?"

┌─ non-terminal status ─┐   seam: isTerminal(status)   ┌─ terminal status ─┐
│ keep polling every 2.5s│ ══════════╪═════════════════► │ interval cleared   │
└─────────────────────────┘   (it flips)                └─────────────────────┘
         ▲                                                        ▲
         └──────────── same field, two different behaviors ──────┘
```

## How it works

**The kernel: interval + revalidate + terminal-status stop condition.**

```
Polling kernel

  mount ──► isTerminal(status)? ──yes──► do nothing, no interval
               │
               no
               ▼
        setInterval(2.5s) ──► revalidator.revalidate()
               │                        │
               │                        ▼
               │                 loader re-runs, fresh `summary`
               │                        │
               └────── re-render ◄──────┘
                        │
                 isTerminal(new status)?
                    │           │
                   no          yes
                    │           │
              (loop continues) clearInterval, stop
```

### The effect that owns the timer

`app.scans.$id.tsx:512-519`:

```tsx
// app.scans.$id.tsx:512-519
useEffect(() => {
  if (isTerminal) return;
  const interval = setInterval(() => {
    revalidator.revalidate();
  }, 2500);
  return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isTerminal, summary.status]);
```

Three parts, each load-bearing:

- **The early return (`if (isTerminal) return;`)** — without it, a completed or failed scan would keep setting a fresh interval every time the effect re-ran, and a "finished" page would silently keep hitting the database every 2.5s forever. This is the stop condition; drop it and polling never ends.
- **The cleanup function (`return () => clearInterval(interval)`)** — without it, every re-run of the effect (which happens on every `summary.status` change, i.e. every successful poll) would stack a *new* interval on top of the old one instead of replacing it, doubling, then quadrupling, the poll rate within seconds. This is the part people forget: an effect that sets an interval without clearing the previous one on every dependency change, not just on unmount.
- **The dependency array (`[isTerminal, summary.status]`)** — the ESLint suppression comment right above it is intentional: `revalidator` itself is deliberately left out of the dependency list, because `useRevalidator()` returns a new object reference on every render, and including it would re-create the interval on every single render instead of only when the scan's status actually changes.

**What breaks if you swapped the stop condition for a fixed max poll count instead of `isTerminal`:** a scan that legitimately takes longer than your count × interval would stop updating the UI while still running server-side — the merchant would see a stale "still scanning" page even after the scan finished, because nothing re-checks once polling has given up. Coupling the stop condition to the actual server-owned status, not a client-side counter, is what keeps the UI honest.

### `useRevalidator` vs. a manual `fetch` loop

`useRevalidator()` (imported at `app.scans.$id.tsx:8`) is Remix's escape hatch for "re-run this route's loader without a navigation." The alternative — a hand-rolled `fetch('/api/scans/' + id)` on the same timer — exists as working code right next to this route (`api.scans.$id.tsx`'s JSON GET endpoint), but the UI deliberately doesn't use it. Reusing the *same* loader the initial page render used means the poll can never drift from what a fresh page load would show: there's exactly one code path that decides what `summary`, `checkNames`, and `findingsPage` look like (`app.scans.$id.tsx:68-120`), and both "first paint" and "poll tick #40" go through it.

### Cost of this shape

Every tick is a full loader re-run — not just the `Scan.status` column, but `getScanSummary` (a full row read) and, once the scan reaches `COMPLETED`, a full `getScanFindings` paginated query too (`app.scans.$id.tsx:101-110`). For a scan that runs for several minutes on a large catalog, that's on the order of a hundred+ redundant round-trips to SQLite for a value that changes maybe five times total (once per pipeline stage). This is cheap here — SQLite on the same machine, low request volume — but it's the first thing that gets expensive if this pattern were reused against a real network-hop database or a rate-limited upstream.

## Primary diagram

```
Full recap — polling end to end

┌─ browser ────────────────────────────────────────────┐
│  mount → isTerminal? → no → setInterval(2.5s)          │
│           │                        │                    │
│          yes                revalidator.revalidate()    │
│           │                        │                    │
│      no interval             (re-runs THIS route's       │
│                                loader, same code path     │
│                                as first paint)            │
└────────────────────────────────────┬────────────────────┘
                                       │ GET, same URL
┌─ Remix loader ────────────────────▼────────────────────┐
│  getScanSummary(shop, scanId) → { status, counts, ... }  │
└────────────────────────────────────┬────────────────────┘
                                       │ new summary
┌─ browser (re-render) ─────────────▼────────────────────┐
│  isTerminal(new status)? → no → loop continues           │
│                            → yes → clearInterval, stop    │
└──────────────────────────────────────────────────────────┘
```

## Elaborate

Short-polling is the cheapest correct way to surface server-owned progress to a browser when you don't have (or don't want) a push channel — no WebSocket connection to keep alive, no SSE stream to manage reconnects for, no extra infrastructure. The cost you accept up front is exactly what lens 8 of `audit.md` names: no cap on total elapsed polling time, and no distinct "this is taking unusually long" UI state — a scan stuck behind a dead worker process (see `.aipe/study-system-design/01-single-worker-db-queue.md`'s poison-pill handling) polls forever with no visible signal to the merchant that anything's wrong. The fix that keeps the *shape* but not the cost is a max-elapsed-time or max-tick-count check alongside `isTerminal`, surfacing a "this scan is taking longer than expected" banner rather than silently polling past it.

`not yet exercised`: exponential backoff on the poll interval (a scan that's still `QUEUED` after 30s doesn't need to be asked about every 2.5s forever), Server-Sent Events or a WebSocket push, and any visibility-based pause (polling continues even if the browser tab is backgrounded).

## Interview defense

**Q: Why polling instead of a WebSocket for scan progress?**
A: The scan pipeline has five states total and changes maybe five times over its lifetime — a persistent connection is a lot of infrastructure (connection management, reconnect-on-drop, a pub/sub fan-out from the worker) to save a handful of redundant reads against a same-machine SQLite file. Polling is the right tradeoff at this scale; it stops being the right one the moment reads get expensive (a remote DB, a rate-limited upstream) or the update frequency needs to be sub-second.

**Q: What's the part of this effect that's easy to get wrong?**
A: The cleanup function. `setInterval` inside a `useEffect` that re-runs (here, on every `summary.status` change) without `clearInterval` in the cleanup stacks a new interval on every re-run instead of replacing the old one — the poll rate silently multiplies. Draw the kernel diagram: mount → interval → *(re-render triggers effect again)* → without cleanup, a second interval starts alongside the first.

**Q: How do you know this can't poll forever after the scan finishes?**
A: `isTerminal(status)` gates the interval creation itself (`if (isTerminal) return;`, before `setInterval` ever runs) — not just a check on whether to display fresh data. The moment `summary.status` becomes `COMPLETED` or `FAILED`, the next effect run hits that early return and never registers a new timer, and the previous one was already cleared by the same effect's own cleanup.

## See also

- `04-scan-state-machine-driving-ui-branching.md` — what `isTerminal`/`status` actually mean, and how the same value picks which Polaris view renders.
- `03-remix-loader-action-data-flow.md` — the loader this poll re-invokes is the same one the initial page load uses.
- `.aipe/study-system-design/01-single-worker-db-queue.md` — the *other* poll loop in this system (the worker's), and why a stuck scan here traces back to a livelock there.
- `audit.md` → lens 1 (rendering and reactivity), lens 8 finding 1.
