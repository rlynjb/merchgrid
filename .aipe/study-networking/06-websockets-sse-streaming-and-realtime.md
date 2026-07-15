# WebSockets, SSE, streaming, and realtime
## Industry standard: push transports / long-lived connections — **not yet exercised** in this repo (polling is used instead)

## Zoom out, then zoom in

This app needs to show a merchant live progress on a running scan — "reading catalog," "checking prices," "preparing your report" — updating without a manual refresh. That's the exact scenario WebSockets and Server-Sent Events (SSE) exist for. This repo doesn't reach for either. It reaches for the simpler tool: **HTTP polling**, a plain `GET` re-run on a timer. Worth saying plainly up front: WebSockets, SSE, and any long-lived push connection are **not yet exercised anywhere in this codebase.**

```
  Zoom out — where realtime UPDATES happen, and how

  ┌─ Browser ─────────────────────────────────────────────┐
  │  useRevalidator().revalidate()  every 2500ms            │
  │  ★ THIS CONCEPT ★ — polling stands in for push here      │
  └───────────────────────┬──────────────────────────────────┘
                          │  plain GET, same loader every time
  ┌─ Remix loader ──────────▼────────────────────────────────┐
  │  getScanSummary(shop, scanId)  →  fresh status each poll  │
  └────────────────────────────────────────────────────────────┘

  NOT PRESENT: WebSocket upgrade, `text/event-stream`, reconnect/backoff
  logic for a persistent connection — none of it exists in this repo.
```

## The structure pass

**Axis: who initiates each update — the client (pull) or the server (push)?**

- Polling (what this repo does): the client always initiates. The server has no way to tell the browser "something changed" — it can only answer whatever the browser last asked, whenever it asks again.
- WebSocket/SSE (what this repo does *not* do): the server can initiate — once the connection is open, it pushes a message the instant there's something new, with no fixed delay baked in.

The seam: **polling trades "instant" for "simple."** A poll can never notify faster than its interval (2500ms here), but it needs zero connection-lifecycle management — no reconnect logic, no handling a dropped socket mid-scan, no server-side subscriber bookkeeping. This repo's scans typically finish in seconds to low minutes against a 5,000-variant guardrail, which is short enough that a 2.5-second worst-case delay is a non-issue — the seam where that stops being true is named in Move 3 below.

## How it works

### Move 1 — the mental model

You've built a `setInterval` that refetches data before — that's the entire mechanism here, just wired through Remix's own re-fetch primitive instead of raw `fetch`. There's no new transport to learn: it's the same request/response HTTP call this app already makes for the initial page load, just re-run on a timer until the scan reaches a terminal state.

```
  Pattern — poll loop, terminating on a status check

  loop:
    wait INTERVAL_MS
    if current status is terminal (COMPLETED or FAILED):
      stop looping
    else:
      re-run the loader (GET the same URL again)
      update UI with the fresh status
```

### Move 2 — walking the actual mechanism

**The poll loop, in this repo's own code.** `app/app/routes/app.scans.$id.tsx:510-519`:

```tsx
const isTerminal = TERMINAL_STATUSES.has(summary.status);

useEffect(() => {
  if (isTerminal) return;
  const interval = setInterval(() => {
    revalidator.revalidate();
  }, 2500);
  return () => clearInterval(interval);
}, [isTerminal, summary.status]);
```

`useRevalidator()` is Remix's mechanism for re-running the current route's `loader` without a full navigation — every 2.5 seconds, as long as `summary.status` isn't `COMPLETED` or `FAILED` (`TERMINAL_STATUSES`, line 57), the browser re-issues the same `GET /app/scans/:id` request the initial page load made, and the loader (`app.scans.$id.tsx:68-120`) re-reads `getScanSummary`/`getScanFindings` fresh from SQLite. The moment `isTerminal` flips true, the `useEffect` cleanup clears the interval and polling stops — there's no lingering connection or timer to leak.

```
  Layers-and-hops — one poll tick, full round trip

  ┌─ Browser ────────┐  hop 1: GET /app/scans/:id   ┌─ Fly edge ──┐
  │  setInterval tick │─────────────────────────────►│  TLS term    │
  │  (every 2500ms)   │◄──── hop 4: fresh HTML/JSON ── └──────┬───────┘
  └───────────────────┘                                hop 2 │ plain HTTP
                                                               ▼
                                                        ┌─ Remix loader ─┐
                                                        │ getScanSummary  │
                                                        └──────┬───────────┘
                                                          hop 3│ file I/O
                                                               ▼
                                                        ┌─ SQLite /data ─┐
                                                        │  Scan row       │
                                                        └──────────────────┘
```

**A different poll loop, worth not confusing with this one.** `app/worker.ts:24, 78-91` also has a `POLL_MS = 5000` loop — but this one is the *worker* checking SQLite for the next `QUEUED` scan to claim, entirely inside the Fly machine, with zero network hop involved (it's a `prisma.scan.findFirst()` call, not an HTTP request). Two "poll every N seconds" loops exist in this codebase for two unrelated reasons: the browser polls over the network because it has no push channel to the server; the worker polls the database in-process because there's no queue broker to subscribe to instead. Naming both, and being precise that only one of them is a networking concept, is the point of drawing this contrast rather than lumping them together as "the app polls a lot."

### Move 2.5 — current state vs. what would change this

Nothing here is "half-built toward WebSockets" — this is a complete, deliberate design, not a migration in progress. But it's worth being concrete about the actual condition under which polling would stop being the right call, since that's the honest answer to "why not push":

```
  Comparison — when polling stays right vs. when it would need to change

  ┌─ current shape ──────────────────┐  ┌─ condition that would flip it ──┐
  │ scans finish in seconds–minutes    │  │ scans regularly take many minutes │
  │ one merchant, one open tab typical │  │ many merchants' tabs open at once  │
  │ 2.5s worst-case staleness = fine   │  │ aggregate poll volume becomes real │
  │ zero connection-lifecycle code     │  │   load on the single Fly machine   │
  └─────────────────────────────────────┘  └──────────────────────────────────┘
```

If that right-hand condition ever became true, SSE (`text/event-stream`) would be the natural next step ahead of a full WebSocket — this app's data flow is strictly one-directional (server tells client "here's your new status"; the client never needs to send anything back mid-scan), and SSE gives you server push over plain HTTP/1.1 keep-alive without the bidirectional complexity a WebSocket buys you and doesn't need here.

### Move 3 — the principle

Push transports earn their complexity when the cost of staleness (a fixed poll interval) exceeds the cost of connection-lifecycle management (reconnects, backoff, server-side subscriber bookkeeping). For a scan that finishes in under a couple of minutes with typically one tab watching it, that trade isn't close — polling wins on simplicity with a staleness cost nobody notices. Recognizing *when the trade flips* is the transferable skill; reaching for WebSockets by default when polling already covers the actual latency budget is the mistake this repo avoids.

## Primary diagram

```
  The full realtime picture — what exists, and what deliberately doesn't

  ┌─ Browser (app.scans.$id.tsx) ─────────────────────────────┐
  │  useRevalidator, setInterval(2500ms)  ──►  GET /app/scans/:id│
  │  stops when status ∈ {COMPLETED, FAILED}                     │
  └───────────────────────┬──────────────────────────────────────┘
                          │ HTTP request/response, every tick
  ┌─ Remix loader ──────────▼────────────────────────────────────┐
  │  getScanSummary / getScanFindings (fresh read, no cache)       │
  └────────────────────────────────────────────────────────────────┘

  ┌─ worker.ts poll loop (POLL_MS=5000) ───────────────────────┐
  │  in-process DB poll — NOT a network concept, shown for       │
  │  contrast only (see Move 2 above)                              │
  └────────────────────────────────────────────────────────────────┘

  NOT YET EXERCISED anywhere in this repo:
    → WebSocket upgrade handshake / persistent duplex connection
    → Server-Sent Events (`text/event-stream`)
    → reconnect/backoff logic for a dropped push connection
    → multiplexed or fan-out push to multiple open tabs
```

## Elaborate

Polling-vs-push is one of the oldest tradeoffs in networked UI, predating both WebSockets and SSE by decades (long-poll comet techniques did the same job before either existed). The lesson generalizes past this repo: reach for `setInterval` + refetch first, and only graduate to a push transport once you can name the specific cost polling is imposing (request volume, staleness budget) that push would remove — not because push is the more sophisticated-sounding choice.

## Interview defense

**Q: This app shows live scan progress. Why isn't it using WebSockets?**
Because polling already meets the actual latency budget — scans finish in seconds to low minutes, one merchant typically has one tab open, and a 2.5-second worst-case staleness is invisible at that scale. WebSockets would add reconnect/backoff and server-side subscriber management this app doesn't need yet. Anchor: `app.scans.$id.tsx:510-519`.

**Q: What would make you reconsider that choice?**
Scans regularly running long enough, or enough concurrent open tabs, that the aggregate poll request volume starts to cost real load on the single Fly machine — at that point SSE (one-directional, simpler than a WebSocket, and this app's data flow never needs the client to push anything back) would be the next step, not WebSockets by default.

## See also

- `01-network-map.md` — where this polling loop sits on the full request-path map
- `05-http-semantics-caching-and-cors.md` — the exact GET semantics each poll tick re-runs
- `07-timeouts-retries-pooling-and-backpressure.md` — the worker's *own* poll loop, and why it's a different concept than this one
