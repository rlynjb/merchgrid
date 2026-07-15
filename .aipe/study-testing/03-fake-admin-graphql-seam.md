# Hand-rolled test double over a narrow port interface

### Industry names: test double / fake object / dependency injection / hexagonal-architecture port — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Production ───────────────────────────────────────────────────┐
  │  authenticate.admin(request)  →  real AdminApiContext            │
  │        (Shopify SDK, live network, live throttling)               │
  └──────────────────────────┬─────────────────────────────────────┘
                             │ both sides implement the SAME narrow interface
  ┌─ The port ────────────────▼─────────────────────────────────────┐
  │  ★ AdminGraphqlClient ★ — graphql(query, opts): Promise<{json}>  │ ← we are here
  │  catalog-reader.server.ts:16-21                                  │
  └──────────────────────────┬─────────────────────────────────────┘
                             │
  ┌─ Test ─────────────────────▼─────────────────────────────────────┐
  │  createFakeAdmin() / createScriptedAdmin()  — hand-rolled, no SDK │
  │  drives retry, pagination, truncation on command                  │
  └────────────────────────────────────────────────────────────────┘
```

This repo's only external network dependency is the Shopify Admin GraphQL
API. Rather than importing the Shopify SDK's client type and mocking a
method on it, the reader defines its own minimal interface for exactly what
it needs, and every test file that touches it builds a plain object
literal that satisfies that interface — no mocking library involved
anywhere in the suite.

## Structure pass

**Layers:** the port (`AdminGraphqlClient`, an interface) → the real
adapter (Shopify SDK, used in production, never imported by a test) → the
fake adapter (`createFakeAdmin`/`createScriptedAdmin`, used only in tests).

**Axis: who decides what the next `graphql()` call returns?** This is the
axis that exposes why this is a seam worth studying:

```
  "who decides the response to admin.graphql(query)?"

  production:   Shopify's real API — cost-throttling, real Product data,
                real network latency, real 5xx failures
  test:         the TEST ITSELF — a canned array of pages, indexed by
                call count, or a scripted sequence of reject/resolve steps
```

The axis flips completely at the `AdminGraphqlClient` boundary — that flip
is exactly what makes it a load-bearing seam rather than a cosmetic one.

**Seam:** `catalog-reader.server.ts:9-15`'s own comment names the intent —
*"kept minimal and dependency-free so this module can be unit tested with a
fake — no live Shopify calls, no import of the Shopify SDK here."* Nothing
in `readCatalog`, `runScan`, or `claimAndRunNext` imports a Shopify SDK type
directly; they all type against `AdminGraphqlClient`.

## How it works

### Move 1 — the mental model

You've built this exact shape before with `fetch`: define the one method
you actually call (`.json()`), pass in a real `Response` in production and
a plain object with a `.json()` method in tests, and the code under test
never knows the difference. The underlying strategy is dependency
inversion: the reader depends on an interface *it* defines, not on the
Shopify SDK's type — so anything shaped like `{ graphql(query, opts):
Promise<{json(): Promise<any>}> }` can stand in for the real thing.

```
  The port/adapter shape

  ┌───────────────┐        implements        ┌──────────────────┐
  │ readCatalog() │◄────────────────────────  │ AdminGraphqlClient│ (interface)
  │ runScan()     │       depends on           └─────────┬────────┘
  │ claimAndRun.. │                                       │
  └───────────────┘                          ┌────────────┴────────────┐
                                              │                          │
                                    ┌─────────▼────────┐      ┌─────────▼────────┐
                                    │ real Shopify SDK  │      │ createFakeAdmin() │
                                    │ (production only)  │      │ (tests only)     │
                                    └────────────────────┘      └───────────────────┘
```

### Move 2 — the walkthrough

**The interface is deliberately the smallest shape that works.**

```typescript
// app/services/shopify/catalog-reader.server.ts:16-21
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<any> }>;
}
```

One method, two parameters, one return shape. Nothing about auth headers,
retries, or the SDK's own error types leaks into this contract — those are
all handled on the reader's side of the seam (`runQuery`,
`resolveRetryPolicy` in the same file), so the fake never has to simulate
them.

**Two fake flavors, matched to what each test needs to prove.**
`catalog-reader.test.ts` defines `createFakeAdmin` (`catalog-reader.
test.ts:22-43`) for tests that just need canned response *pages*, indexed
by call order — good enough for pagination and field-mapping tests. It
also defines a second, distinct fake, `createScriptedAdmin`
(`catalog-reader.test.ts:69-93`), for tests that need a call to *reject*
(simulating a network blip) rather than always resolve:

```typescript
// catalog-reader.test.ts:67-93 (trimmed)
type ScriptedStep = { reject: Error } | { page: CannedPage };

function createScriptedAdmin(steps: ScriptedStep[]) {
  const admin: AdminGraphqlClient = {
    async graphql(query, options) {
      const step = steps[callIndex] ?? steps[steps.length - 1];
      callIndex += 1;
      if ("reject" in step) throw step.reject;
      return { async json() { return step.page; } };
    },
  };
  return { admin, calls };
}
```

This is the fake that drives `readCatalog`'s retry path
(`catalog-reader.test.ts:410-457`): script a `THROTTLED` GraphQL error body
on call 1, a success page on call 2, and assert `readCatalog` transparently
retried and returned the product. No real Shopify API would let you *make*
a throttle happen on command — the fake is the only way to test this
deterministically, which is exactly the point of the seam.

**Query-shape dispatch, not call-order dispatch, for the multi-query
tests.** `scan-runner.test.ts`'s `createFakeAdmin` (`scan-runner.
test.ts:97-132`) inspects the *query text* itself to decide which canned
response to return:

```typescript
// scan-runner.test.ts:104-114 (trimmed)
async graphql(query: string) {
  // dispatch on the more specific "shop {" shape first — checking for
  // "currencyCode" first would misroute the products query, which also
  // requests a nested currencyCode field.
  if (query.includes("shop {") || query.includes("shop{")) {
    return { async json() { return { data: { shop: { currencyCode: ... } } } } };
  }
  if (query.includes("products")) { ... }
  throw new Error(`Unexpected query in fake admin: ${query}`);
}
```

`runScan` issues two different GraphQL queries (shop currency, then
products), so this fake can't rely on call order the way the reader's own
tests do — it has to route on the query's actual shape. The comment
documents a real gotcha the author hit: `currencyCode` also appears nested
inside the products query, so checking for that substring first would
misroute. And the fallback `throw` on an unrecognized query is itself a
guardrail — a query the fake doesn't expect fails the test loudly instead
of silently returning `undefined`.

**The fake also records every call it received**, so tests can assert on
*what was asked* as well as what was returned — e.g.
`catalog-reader.test.ts:145-148` asserts the second products-page call
carried the correct pagination cursor from the first page's response.

### Move 3 — the principle

The generalizable move: when a piece of code's only real dependency is an
external service, don't mock the SDK's client type — define your own
narrowest-possible interface for exactly the calls you make, and hand-roll
plain objects that satisfy it in tests. You get to script failure modes
(throttling, network rejection, malformed responses) a real API would never
let you trigger on demand, and the fake stays trivial to read because it
has no mocking-library API surface layered on top of it.

## Primary diagram

```
  The seam, with both sides of it

  production path                         test path
  ┌─────────────────────┐                 ┌──────────────────────────┐
  │ authenticate.admin()  │                │ createFakeAdmin(opts)      │
  │  → Shopify SDK client  │                │ createScriptedAdmin(steps)│
  └──────────┬────────────┘                └─────────────┬─────────────┘
             │ both satisfy                                │
             └──────────────┬──────────────────────────────┘
                             ▼
                  ┌─────────────────────┐
                  │  AdminGraphqlClient  │  graphql(query, opts):
                  │  (the port)          │    Promise<{json()}>
                  └──────────┬───────────┘
                             │ consumed by
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        readCatalog()    runScan()   claimAndRunNext()
        (retry/paginate) (pipeline)  (queue draining)
```

## Elaborate

This is the classic "ports and adapters" (hexagonal architecture) shape,
scaled down to a single method — the port doesn't need to be elaborate to
earn its keep. The alternative this repo avoided was importing
`@shopify/shopify-api`'s own `AdminApiContext` type and reaching for a
mocking library (`vi.fn()`, `vi.mock()`) to stub its `graphql` method. That
approach would have worked, but it couples every test to the SDK's actual
type shape — a SDK upgrade that changes the client's method signature would
break tests that never cared about anything but "does the reader retry on
throttle." Defining the interface locally means the tests only ever depend
on what the reader itself needs, which is also why `worker-core.server.ts`
takes the same shape one level up: its `AdminFactory` type
(`worker-core.server.ts:15`) is `(shopDomain: string) =>
Promise<AdminGraphqlClient>`, letting `worker-core.test.ts` fake the
*factory* too, without ever touching Shopify OAuth.

## Interview defense

**Q: Why define a custom `AdminGraphqlClient` interface instead of using
the Shopify SDK's own client type?**
Because the reader only needs one method (`graphql`) with one shape. Typing
against the SDK's real type would couple every test — and the production
code — to the SDK's full surface area, and an SDK upgrade could break tests
that have nothing to do with what actually changed. The local interface is
the minimum contract the reader actually depends on.

```
  coupled to SDK type:      test breaks on any SDK signature change
  coupled to local port:    test breaks only if the reader's OWN contract changes
```

**Q: How do you test a Shopify rate-limit retry without a real API that
throttles you on command?**
You can't, with the real client — so `createScriptedAdmin` scripts a
`THROTTLED` GraphQL error body on the first call and a success page on the
second, and asserts `readCatalog` retried transparently. The fake makes the
untestable-on-demand failure mode testable on demand.

**Q: What's the one thing you have to get right for the fake to be
trustworthy?**
The fake must throw on a query shape it doesn't recognize
(`scan-runner.test.ts:129`), rather than silently returning something. Without
that guardrail, a bug that changes which query the production code sends
could go unnoticed — the fake would just keep returning whatever it always
returned, and the test would pass for the wrong reason.

## See also

- `audit.md` lens 2 (test design and levels) and lens 4 (determinism) —
  this fake is the reason both lenses came back clean.
- `02-sqlite-integration-test-harness.md` — the complementary choice: keep
  the database real, fake only the true external network boundary.
- `05-exhaustive-state-transition-matrix.md` — `claimAndRunNext`'s tests use
  this same `AdminFactory` fake to drive the poison-pill/livelock scenario.
