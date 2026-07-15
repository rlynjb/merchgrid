# Provider Abstraction

**Provider abstraction (adapter pattern over an LLM vendor) — Industry standard**

## Zoom out, then zoom in

```
Zoom out — where an LLM provider seam would sit in MerchGrid

┌─ UI layer — Remix routes / Polaris ─────────────────────────┐
│  app.scans.$id.tsx — no provider concept at this layer          │
└─────────────────────────┬─────────────────────────────────────┘
                          │
┌─ Service layer — app/app/services/ ─────────────────────────────┐
│  shopify/catalog-reader.server.ts DOES have a real adapter seam    │
│  today — AdminGraphqlClient — but it's for the Shopify Admin API,   │
│  not an LLM provider                                                  │
│                                                                         │
│         ★ an LLM provider adapter would live in a NEW sibling         │
│           module, e.g. app/app/services/ai/providers/ ★                │
│         — does not exist; no LLM vendor is wired in anywhere           │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │
┌─ Engine layer — packages/catalog-core, packages/catalog-checks ─────────┐
│  pure functions, no I/O, no vendor of any kind                            │
└───────────────────────────────────────────────────────────────────────┘
```

Provider abstraction is the seam you put between your application code and *whichever* external vendor is currently answering a call, so swapping vendors — or testing without one — never means rewriting the callers. MerchGrid has exactly this seam today, real and tested, for a different external dependency (the Shopify Admin API). This file teaches the general pattern, then reads that real seam line-by-line as the template a future LLM-provider adapter would follow.

## Structure pass

**Layers:** the seam sits inside the service layer, between "code that constructs a request and interprets a response" and "whichever concrete SDK/HTTP client actually talks to a vendor."

**Axis: dependency — who depends on whom, and which way does the arrow point?** Trace it without the abstraction: your business logic imports a vendor's SDK directly, calls vendor-specific methods, and every test that exercises that logic has to either hit the real vendor or mock the SDK's exact shape — the arrow points from your code straight at a concrete vendor. Trace it with the abstraction: your business logic depends on an interface (a port) it defines itself, a thin adapter implements that interface against one specific vendor's SDK, and a factory decides at startup which adapter to construct — the arrow now points from your code to the interface, and from the adapter to the vendor, never the other way. This is dependency inversion: the abstraction is owned by the caller, not the vendor.

**Seam:** the port is the interface; the client is the code that depends on it; the adapter is the concrete implementation wrapping one vendor's SDK; the factory is whatever selects and constructs the right adapter; dependency injection is passing the constructed adapter into the client instead of the client constructing it itself. MerchGrid has built exactly this seam for the Shopify Admin API — `AdminGraphqlClient` in `app/app/services/shopify/catalog-reader.server.ts` — and the same shape, with a different concrete vendor on the other side, is what an LLM provider abstraction would look like.

## How it works

### Move 1 — the mental model

You've swapped a component's data-fetching hook for a mocked version in a test without touching the component itself — the component depended on a hook *interface* (call it, get data back), not on `fetch` or a specific endpoint directly. Provider abstraction is that same swap, generalized to an entire external vendor instead of one hook: define what you need from "a thing that answers requests," implement that against today's vendor, and anything depending on the interface never has to know which vendor — or whether a real one — is on the other side.

```
Pattern — the port/adapter/factory shape

  ┌─ your business logic (the CLIENT) ───────────┐
  │  depends only on the PORT (the interface)      │
  └────────────────────┬──────────────────────────┘
                       │  calls through the interface
  ┌─ the PORT ─────────▼──────────────────────────┐
  │  interface AdminGraphqlClient {                 │
  │    graphql(query, options): Promise<Response>    │
  │  }                                                │
  └────────────────────┬──────────────────────────┘
                       │  implemented by
        ┌──────────────┴──────────────┐
        ▼                              ▼
  ┌─ real ADAPTER ──────┐      ┌─ fake ADAPTER (tests) ──┐
  │  wraps Shopify's SDK  │      │  returns fixture data     │
  └───────────────────────┘      └───────────────────────────┘
        both satisfy the SAME interface — the client can't tell which one it got
```

### Move 2 — the step-by-step walkthrough

**Part 1 — the port is defined by what the client needs, not by what the vendor's SDK offers.** A vendor's real SDK is almost always bigger than what any one caller needs — dozens of methods, config options, vendor-specific types. A good port is the *minimal* shape your code actually calls, so an adapter for a different vendor only has to satisfy that minimal shape, not replicate the whole original SDK's surface.

**Part 2 — the adapter is a thin translation layer, and it's where vendor-specific error handling and retry policy lives.** This is the part people underestimate: the adapter isn't just "call the vendor's method instead of yours" — it's also the single place that translates vendor-specific failure modes (a specific error code, a specific rate-limit header) into whatever generic contract the port promises. Put that translation anywhere else and every caller ends up needing to know vendor-specific details the port was supposed to hide.

**Part 3 — the factory is what makes the swap a config change instead of a code change.** Something has to decide, at startup (or per-request, for multi-tenant vendor routing), which concrete adapter to construct. A factory reading an environment variable or a config value is the common shape — swap the vendor by changing config, not by editing every call site.

```
function createProvider(config):
  switch config.PROVIDER:
    case "vendorA": return new VendorAAdapter(config.vendorAApiKey)
    case "vendorB": return new VendorBAdapter(config.vendorBApiKey)
    case "fake":    return new FakeAdapter(config.fixtureData)  // tests
    default: throw new Error(`Unknown provider: ${config.PROVIDER}`)

// callers everywhere just receive whatever createProvider() returns,
// typed as the PORT interface — they never branch on which vendor it is
```

**Part 4 — the pattern only pays for itself if the port is actually vendor-agnostic.** The most common way this pattern fails in practice: the "interface" leaks a vendor-specific concept through it (a parameter only vendor A's API needs, a response shape shaped exactly like vendor B's JSON), and every other adapter has to fake or ignore that leak. A port that's secretly "vendor A's API with the serial numbers filed off" isn't a real abstraction — it's vendor lock-in with an extra layer of indirection. The test that catches this: can you write a second, *meaningfully different* adapter against the same port without adding new methods to the interface? If not, the port isn't done yet.

**In this codebase:** MerchGrid has built this exact pattern once, for the Shopify Admin API, not for an LLM provider — worth being precise that these are two different applications of the same pattern, not the same thing. `AdminGraphqlClient` in `app/app/services/shopify/catalog-reader.server.ts` (lines 16-21) is the port:

```typescript
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<any> }>;
}
```

Read the comment directly above it (lines 9-15): "The subset of the Shopify Admin GraphQL client we need. Matches the shape of `admin` returned by `authenticate.admin(request)`... but kept minimal and dependency-free so this module can be unit tested with a fake — no live Shopify calls, no import of the Shopify SDK here." That sentence is Move 2 Part 1 and Part 4, verbatim, applied to a real file: the port is deliberately narrower than Shopify's full SDK (`graphql(query, options)` — one method, not the dozens the real SDK exposes), and it exists specifically so a fake adapter can satisfy it in tests without touching the real vendor. `readCatalog` (lines 400-452), the client in this pattern's vocabulary, only ever calls `admin.graphql(...)` — it has no idea, and doesn't need to know, whether `admin` is the real Shopify SDK object or a test fake. The adapter-level translation this pattern calls for (Move 2 Part 2) is real here too: `isThrottledErrorBody` (lines 192-198) and `runQuery`'s retry loop (lines 200-241) translate Shopify's vendor-specific `extensions.code: "THROTTLED"` error shape into a generic retry-then-throw contract the rest of the module can rely on without knowing Shopify's error format.

What MerchGrid does *not* have is a factory selecting between multiple concrete adapters — there's exactly one real implementation (the live Shopify SDK object passed in from `app/app/shopify.server.ts`'s `authenticate.admin(request)`) plus test fakes constructed directly in test files. That's a legitimate, smaller version of the pattern: MerchGrid has never needed to swap *which* commerce platform it talks to, so it never built the factory step — only the port-and-adapter seam that makes testing possible.

An LLM provider abstraction would follow the identical shape, with an LLM vendor's SDK in place of Shopify's, and it would need the factory MerchGrid's real code skipped — because "which LLM provider" is a decision a real system usually *does* need to change without a code rewrite (cost, latency, capability tradeoffs across vendors; a fallback if one vendor is down). Speculatively, in a new `app/app/services/ai/providers/` module: a port like `interface LlmProvider { complete(prompt, options): Promise<LlmResponse> }`, adapters wrapping each vendor's specific SDK, and a factory reading an environment variable to construct the right one — with a fake adapter, exactly like `catalog-reader.server.ts`'s test fakes, so the future `services/ai/` module's own logic can be unit tested without ever calling a real model.

### Move 3 — the principle

A provider abstraction is dependency inversion applied to "which vendor answers this call": the port is owned by your code, sized to exactly what your code needs, and any vendor-specific translation (errors, retries, response shape) lives inside the adapter, never leaking through the interface. The payoff isn't hypothetical vendor-swapping — it's that a fake adapter, satisfying the same narrow interface, is what lets you test the calling code at all without paying for or depending on a live external service every time you run your suite.

## Primary diagram

```
Primary diagram — the pattern, and MerchGrid's one real instance of it

  GENERAL PATTERN                     MERCHGRID'S REAL INSTANCE (Shopify, not LLM)
  ────────────────                     ─────────────────────────────────────────
  port (interface)                    AdminGraphqlClient (catalog-reader.server.ts:16-21)
  client (depends on port)            readCatalog() (same file, lines 400-452)
  adapter (wraps one vendor)          the real `admin` object from
                                        authenticate.admin(request) (shopify.server.ts)
  adapter (test fake)                 fixtures satisfying AdminGraphqlClient,
                                        used directly in test files — no factory
  factory (selects adapter)           NOT BUILT — only one real vendor ever needed
  vendor-error translation            isThrottledErrorBody + runQuery's retry loop
                                        (lines 192-241)

  MerchGrid: Bulk AI (roadmap)  →  an LlmProvider port + adapter(s) + factory
                                      would live in a NEW services/ai/providers/
                                      module, following this exact shape
```

## Elaborate

Port-and-adapter (also called Hexagonal Architecture, or the Ports & Adapters pattern, credited to Alistair Cockburn) is one specific packaging of the older dependency-inversion principle — depend on abstractions, not concretions — applied specifically to a system's boundary with the outside world. The LLM-specific flavor of this pattern has become common enough to have its own vocabulary in the ecosystem (LiteLLM and similar libraries exist specifically to be a pre-built `LlmProvider`-shaped port over dozens of vendors), precisely because vendor churn in the LLM space is fast and real — pricing, capability, and even latency characteristics shift often enough that hardcoding one vendor's SDK into your business logic is a genuine, not theoretical, maintenance risk. MerchGrid's own version of this concern shows up in its product spec too: §23.8 names "API and App Store changes" as a risk and names the mitigation directly — "Isolate Shopify access in an adapter" — the exact same instinct, aimed at Shopify instead of an LLM vendor.

## Project exercises

### Build the LLM provider port this file only sketches

- **Exercise ID:** EX-1
- **What to build:** A new `app/app/services/ai/providers/provider.ts` defining a minimal `LlmProvider` interface (`complete(prompt: string, options?: { maxTokens?: number }): Promise<{ text: string }>`, modeled directly on how narrow `AdminGraphqlClient` is), a `FakeLlmProvider` implementation returning canned fixture responses for tests, and a `createLlmProvider(config)` factory reading a `LLM_PROVIDER` env var (`"fake"` by default, so no real key is ever required to run the suite) that MerchGrid's real code never needed to build for Shopify.
- **Why it earns its place:** It's the direct, buildable counterpart to `AdminGraphqlClient` — same minimal-port discipline, same fake-for-tests approach — plus the one piece (the factory) MerchGrid's real code skipped, because an LLM integration genuinely does need to swap vendors in a way Shopify access never did.
- **Files to touch:** New files `app/app/services/ai/providers/provider.ts`, `app/app/services/ai/providers/fake-provider.ts`, `app/app/services/ai/providers/factory.ts`; new test `app/app/services/ai/providers/factory.test.ts`.
- **Done when:** A test constructs a provider via the factory with `LLM_PROVIDER=fake`, calls `complete()`, and asserts the fixture response comes back — proving the calling code never needs to import or configure a real vendor SDK to be tested.
- **Estimated effort:** 1-2 hours.

### Read and diagram the real Shopify adapter's error-translation boundary

- **Exercise ID:** EX-2
- **What to build:** Nothing new — a short written trace (a scratch note) of exactly which lines in `app/app/services/shopify/catalog-reader.server.ts` translate a Shopify-specific error shape (`extensions.code: "THROTTLED"`) into the module's own generic retry contract, versus which lines would need to change if you swapped in a hypothetically different commerce platform's SDK.
- **Why it earns its place:** This is the fastest way to internalize Move 2 Part 2 (adapters own vendor-specific error translation) against real, working code instead of the abstract pattern — you'll be able to point at the exact function (`isThrottledErrorBody`, lines 192-198) in an interview instead of describing the idea generically.
- **Files to touch:** No production files.
- **Done when:** You can name, from memory, which function in this file would need to change for a different vendor, and which (the port, `AdminGraphqlClient` itself, and `readCatalog`'s core pagination logic) would not.
- **Estimated effort:** 30 minutes.

## Interview defense

**Q: What's the difference between a port and an adapter, and why does the port belong to your code, not the vendor's?**
A: The port is the minimal interface your calling code actually needs; the adapter is the concrete implementation that satisfies it by wrapping one vendor's SDK. The port belongs to the client's side because that's what makes dependency inversion work — if the "interface" is really just the vendor's own SDK shape, you haven't abstracted anything, you've just renamed a direct dependency. `AdminGraphqlClient` (`catalog-reader.server.ts` lines 16-21) is a one-method interface, far narrower than Shopify's actual SDK, specifically so it's owned by MerchGrid's code and can be satisfied by a fake in tests.

```
  vendor's real SDK:   dozens of methods, vendor-specific types
  the PORT you define:  only what YOUR code calls — minimal, yours
  the ADAPTER:          wraps the vendor's SDK to satisfy YOUR port
```

**Q: Does MerchGrid have a provider abstraction anywhere in it?**
A: Yes, for the Shopify Admin API, not for an LLM. `AdminGraphqlClient` is the port, `readCatalog` (`catalog-reader.server.ts` lines 400-452) is the client that only ever calls through it, and the real Shopify SDK object versus test fixtures are two interchangeable adapters. What it doesn't have is a factory selecting between multiple *real* vendors, because MerchGrid has never needed to swap commerce platforms — only to test against a fake one, which the narrow port already makes possible without a factory.

**Q: If MerchGrid added an LLM feature, would you reuse `AdminGraphqlClient`, or build something new?**
A: Something new, structurally identical but not the same interface — `AdminGraphqlClient`'s one method (`graphql(query, options)`) is Shopify-GraphQL-shaped, not a generic "call a language model" shape. I'd build a parallel `LlmProvider` port in a new `app/app/services/ai/providers/` module following the exact same discipline this repo already proved out: minimal interface, vendor-specific error translation inside the adapter, and — unlike the Shopify case — an actual factory, since LLM vendor choice is a real, live decision this integration would need to make in a way MerchGrid's Shopify dependency never has.

## See also

- `01-what-an-llm-is.md` — what the `LlmProvider` port sketched here would actually be calling.
- `06-token-economics.md` — why the factory step (absent from MerchGrid's real Shopify adapter) matters more for LLM vendors: pricing and context-window limits differ meaningfully by provider.
- `09-user-override-locks.md` — a different kind of guardrail that would sit alongside a provider abstraction, not inside it.
- `app/app/services/shopify/catalog-reader.server.ts` — the real port/adapter/client code this file is built around.
