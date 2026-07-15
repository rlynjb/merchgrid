# Streaming

**Streaming (token-by-token / server-sent events over HTTP) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where token streaming would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app.scans.$id.tsx polls scan STATUS (a whole row, refetched  │
│  wholesale) — not a byte stream of partial content              │
└─────────────────────────┬─────────────────────────────────────┘
                          │  HTTP GET, poll-and-replace, not a kept-open connection
┌─ Service layer — app/app/services/scan/ ───────────────────────┐
│  runner.server.ts runs the WHOLE pipeline to completion before   │
│  a caller ever sees a result — no partial output is ever sent      │
│                                                                       │
│         ★ token streaming would live in a future LLM call ★          │
│         — does not exist; nothing here streams partial model output  │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-checks ─────────────────────────────────┐
│  runChecks(ALL_CHECKS, ctx) returns the FULL CatalogFinding[] in one call │
└───────────────────────────────────────────────────────────────────────┘
```

`01-what-an-llm-is.md` showed you the generation loop producing one token at a time. Streaming is the decision to *ship each of those tokens to the client as it's produced*, instead of waiting for the whole response and sending it as one blob. This file teaches that mechanism, then draws a precise line between it and the progress-reporting MerchGrid already has, which looks superficially similar but is a different pattern solving a different problem.

## Structure pass

**Layers:** the concept is a hop between the service layer and the UI layer — specifically, whether that hop is a single request/response pair or a long-lived connection with multiple pushes.

**Axis: cost — what's the latency-to-first-byte, and who's waiting on what?** Trace it across two shapes: a non-streaming call, the caller waits for the *entire* generation to finish (which can be seconds for a long response) before seeing anything; a streaming call, the caller sees the first token as soon as it's sampled, and the rest arrive incrementally while generation continues server-side. The total wall-clock time to the *last* token is roughly the same either way — streaming doesn't make the model faster, it changes when the *first useful pixel* reaches the user.

**Seam:** the seam is the transport between server and client during a long-running operation — a single request/response (client blocks until done), pure polling (client repeatedly asks "are we there yet," each ask a fresh request), or a kept-open connection (SSE, or a WebSocket) that pushes updates without the client re-asking. MerchGrid's scan pipeline uses the *polling* shape for its own (non-LLM) long-running work — worth naming precisely, because it's easy to conflate with streaming when skimming code, and the two solve genuinely different problems.

## How it works

### Move 1 — the mental model

You've built a `fetch()` with `loading`/`success`/`error` state, where the UI sits in `loading` until the whole response lands. Streaming is that same request, except the response body isn't one blob that arrives all-at-once — it's a sequence of chunks the client reads as they arrive, updating the UI progressively instead of flipping straight from `loading` to `success`.

```
Pattern — non-streaming vs streaming, same request, different delivery

  non-streaming:
    client ──request──► server ──[ full generation, no output yet ]──►
    client ◄──────────────────── entire response, all at once ────────

  streaming:
    client ──request──► server ──► token 1 ──► client renders "The"
                                 ──► token 2 ──► client renders "The cat"
                                 ──► token 3 ──► client renders "The cat sat"
                                 ──► [DONE]  ──► client marks response complete
```

### Move 2 — the step-by-step walkthrough

**Part 1 — why streaming exists: perceived latency, not actual latency.** A 500-token response might take 8 seconds to fully generate either way. Non-streaming, the user stares at a spinner for all 8 seconds. Streaming, the user starts reading at ~200ms (time to first token) and the rest arrives while they're still reading the beginning — the *total* time is unchanged, but the *experienced* wait drops to almost nothing. This is the single biggest reason production chat UIs stream: it's a UX latency hack, not a throughput optimization.

**Part 2 — the mechanism is usually Server-Sent Events (SSE) over a single HTTP response.** The server keeps the HTTP response open and writes discrete chunks to it as they become available, each one typically framed as a `data: {...}\n\n` line; the client reads the response as a stream instead of waiting for it to close. This is the same idea as reading a Node.js `Readable` stream chunk-by-chunk instead of buffering it all with `.text()` first — the transport-level primitive is generic, LLM streaming is one particular use of it.

```
function handleStreamedResponse(response):
  reader = response.body.getReader()      // stream reader, not response.json()
  accumulated = ""

  while true:
    chunk = await reader.read()
    if chunk.done: break
    accumulated += decode(chunk.value)     // one chunk = one or more tokens
    render(accumulated)                    // re-render on every chunk
```

**Part 3 — streaming and structured outputs are in tension, and real systems pick a resolution.** If you're constraining the model to emit a single valid JSON object (`04-structured-outputs.md`), streaming it token-by-token means the client sees `{ "sever` then `{ "severity":` — invalid JSON at every intermediate point until the closing brace arrives. Production systems either (a) don't stream schema-constrained responses at all, buffering until the object is complete, or (b) use a streaming-aware partial-JSON parser that can render a best-effort partial object and finalize once the stream closes. This tension — "I want progressive rendering AND a guaranteed valid final shape" — is a real, load-bearing design decision in any LLM product, not an edge case.

**Part 4 — a client-side timeout has to account for "still streaming" differently than "hung."** A non-streaming call that's silent for 30 seconds looks identical whether it's about to finish or dead. A streaming call gives you a signal a plain request/response doesn't: if tokens keep arriving, however slowly, the connection is alive and making progress; only a gap with *zero* new chunks for some threshold should trip a timeout. Getting this wrong (treating "slow but streaming" the same as "hung") is a common production bug.

**In this codebase:** not yet implemented — there is no SSE endpoint, no chunked response, and no client-side stream reader anywhere in this repo, because there's no token-by-token model output to progressively deliver. What MerchGrid does have, and what's worth naming precisely so you don't conflate it with streaming, is **polling for scan progress**: the scan pipeline moves through discrete stages — `QUEUED` → `READING_CATALOG` → `RUNNING_CHECKS` → `PREPARING_RESULTS` → `COMPLETED` — enforced by `assertTransition` in `app/app/services/scan/state.ts` (lines 40-56), and a route like `app/app/routes/api.scans.$id.tsx` is fetched by the client to check the current `status` of a scan already in flight. This is architecturally the opposite shape from streaming: the client re-asks a fresh request each time ("are we at `COMPLETED` yet?"), the server has no open connection to push through, and what comes back on each poll is a *whole replaced snapshot* of scan status — not an incremental delta appended to what the client already had. It's a legitimate, simpler pattern for MerchGrid's use case (a scan takes seconds to low-tens-of-seconds, not the multi-second-per-token cadence a chat UI needs to hide), and it's the right call here — but it's not streaming, and conflating the two in an interview is a real tell that you haven't built either.

If MerchGrid ever streamed anything, the only plausible attachment point is a future LLM call in the roadmapped bulk-AI feature — a merchant typing a prompt (spec §25.4) and watching the proposed changeset build up progressively, the same way a chat UI streams a response. That would need a genuinely new transport (SSE or equivalent) at whatever route serves that feature, layered on top of — not replacing — the existing poll-based scan-status pattern, since the two would coexist for different kinds of long-running work.

### Move 3 — the principle

Streaming trades "the client waits for the operation to fully finish" for "the client sees progress as it happens," at the cost of a kept-open connection and, if the payload needs to be schema-valid at every point, real complexity in how you render a partial result. It's a UX-latency optimization, not a correctness or throughput one — and it's a different pattern entirely from status polling, which re-fetches a whole snapshot on a fixed cadence instead of pushing incremental deltas over a live connection.

## Primary diagram

```
Primary diagram — streaming vs polling, side by side

  STREAMING (LLM chat UIs)              POLLING (MerchGrid's real pattern)
  ────────────────────────              ──────────────────────────────────
  one connection, kept open             many separate requests, one per poll
  server PUSHES chunks as generated     client PULLS current status each time
  client renders incremental deltas     client replaces whole snapshot
  built for: multi-second generation    built for: a background job whose
  the user should watch happen           progress the user checks in on

  MerchGrid: Catalog Audit today  →  polling only (api.scans.$id.tsx checks
                                      ScanStatus via state.ts's fixed stages);
                                      no streamed content anywhere
  MerchGrid: Bulk AI (roadmap)    →  a streamed changeset-generation UI would
                                      be a NEW transport, coexisting with
                                      (not replacing) scan-status polling
```

## Elaborate

Server-Sent Events predates LLM products by over a decade — it's a plain HTML5 spec (`text/event-stream`) originally built for things like live stock tickers and notification feeds, chosen for LLM chat products because it's simpler than a WebSocket for the common case (server → client only, no need for the client to push mid-stream) and works over plain HTTP without an upgrade handshake. The broader pattern this file sits inside — "how do you show progress on something that takes longer than a user wants to wait" — has plenty of non-LLM solutions too (progress bars backed by polling, exactly what MerchGrid does; long-polling; WebSockets for bidirectional cases). Streaming is the LLM-specific instance of that broader problem, chosen because token-by-token arrival is a natural fit for it — the model genuinely does produce output incrementally, unlike most backend jobs where "progress" has to be synthesized.

## Project exercises

### Add a stubbed streaming endpoint to see the transport, without a real model

- **Exercise ID:** EX-1
- **What to build:** A new Remix resource route, `app/app/routes/api.ai.stub-stream.tsx`, that returns a `text/event-stream` response manually chunking a hardcoded string (e.g. one word at a time with a short delay) so you can observe SSE framing and a client-side stream reader end to end, without any real provider involved.
- **Why it earns its place:** It isolates the *transport* mechanic from the LLM specifics — you'll see exactly what "kept-open response, incrementally written" looks like at the HTTP level, which is the part people usually skip past when they've only ever consumed a streaming chat SDK.
- **Files to touch:** New file `app/app/routes/api.ai.stub-stream.tsx`; optionally a scratch client fetch script to observe it (not committed).
- **Done when:** Watching the network tab (or a simple script using `response.body.getReader()`) shows multiple discrete chunks arriving over time on a single connection, not one response landing all at once.
- **Estimated effort:** 1 hour.

### Contrast the two patterns by reading the real polling code

- **Exercise ID:** EX-2
- **What to build:** Nothing new — annotate (in a scratch note, not committed) `app/app/routes/api.scans.$id.tsx` and `app/app/services/scan/state.ts`, marking exactly which HTTP calls happen, how many round trips a full scan lifecycle takes under polling, and what data is re-sent on every poll versus what would be a "delta" in a streaming model.
- **Why it earns its place:** This is the fastest way to walk away with the streaming-vs-polling distinction cold enough to defend in an interview — you're tracing MerchGrid's real request pattern, not reasoning about it abstractly.
- **Files to touch:** No production files.
- **Done when:** You can state, from memory, how many separate HTTP requests a client makes over a 30-second scan under the current polling interval, and why that number would be different (ideally: one, kept open) under a streaming design.
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: Why do chat products stream tokens instead of waiting for the full response?**
A: It's about perceived latency, not actual latency — total generation time is the same either way, but streaming lets the user start reading at time-to-first-token (often under a second) instead of staring at a spinner for the full response duration. It's a UX optimization on top of an unchanged backend cost.

```
  non-streaming: [ ---------- silence ---------- ] then full response
  streaming:     [ token ][ token ][ token ]...   user reading the whole time
```

**Q: Does MerchGrid stream anything?**
A: No — and it's worth distinguishing that from what it *does* have, because they look similar from a distance. The scan pipeline reports progress through polling: the client re-fetches a scan's `status` (one of the fixed stages enforced by `assertTransition` in `app/app/services/scan/state.ts`) on its own cadence, and each poll gets back a whole replaced snapshot, not an incremental delta over a kept-open connection. Streaming pushes partial output as it's generated; polling pulls a full current state repeatedly. MerchGrid does the latter, for a background job, not an LLM.

**Q: If MerchGrid streamed a future LLM-generated changeset, what would break, and how would you handle it?**
A: Structured-output validity would break mid-stream — if the model is emitting a single JSON changeset object, every partial chunk before the closing brace is invalid JSON. I'd either buffer the full object before validating and rendering (simplest, gives up progressive rendering) or use a streaming-aware partial-JSON parser that can render a best-effort partial view and only run the real schema/value validation (`04-structured-outputs.md`, `07-heuristic-before-llm.md`) once the stream closes.

## See also

- `01-what-an-llm-is.md` — the token-by-token generation loop that makes streaming possible in the first place.
- `04-structured-outputs.md` — the tension between streaming and schema-valid output described in Move 2 Part 3.
- `app/app/services/scan/state.ts` — the real, deterministic polling-friendly state machine MerchGrid uses instead of streaming.
- `app/app/routes/api.scans.$id.tsx` — the real route a client polls for scan status today.
