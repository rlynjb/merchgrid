# 03 — Remix loader/action data flow

**Server-owned data fetching via route loaders/actions (no client fetch library).** Framework-specific mechanism (Remix), teaching the language-agnostic pattern it replaces: a typed request/response cycle standing in for `react-query`/SWR/a hand-rolled `fetch` layer.

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Browser ────────────────────────────────────────────────────┐
│  useLoaderData<typeof loader>() / useActionData<typeof action>│
└──────────────────────────┬──────────────────────────────────┘
                            │  GET (loader) / POST (action)
┌─ Remix route module ──────▼──────────────────────────────────┐
│  export const loader = ...   ★ THIS CONCEPT ★  ← we are here   │
│  export const action = ...                                     │
└──────────────────────────┬──────────────────────────────────┘
                            │  calls
┌─ Service layer ─────────────▼──────────────────────────────────┐
│  scan-api.server.ts, settings.server.ts                         │
└────────────────────────────────────────────────────────────────┘
```

You've reached for `react-query`/SWR before to get "typed server data, with loading and error states, without writing your own `fetch` + `useEffect`." Remix's `loader`/`action` pair is that same job, moved server-side and type-inferred end to end: the function that fetches the data *is* the function whose return type `useLoaderData<typeof loader>()` infers from, with no separate client cache layer in between.

## Structure pass

**Axis: control — who decides when a mutation completes, and where the user ends up after?** This is the axis worth tracing across this repo's two mutating routes, because the answer flips between them even though both use the exact same `action` mechanism.

**Seam:** the return value of the `action` function. Return a `redirect()` and the browser ends up on a new URL, with the mutated resource freshly loaded via *that* route's loader. Return `json({...})` and the browser stays exactly where it was, re-rendering the same route with `useActionData()` now populated.

```
The seam — same mechanism, action's return value decides what happens next

axis traced = "does completing this mutation move the user somewhere else?"

┌─ app._index.tsx action ──┐  seam: return redirect() vs json()  ┌─ app.settings.tsx action ─┐
│ redirect(`/app/scans/:id`)│ ═══════════╪═══════════════════════► │ json({ ok, ... })          │
│ → new route, new loader   │   (it flips)                        │ → same route re-renders     │
└────────────────────────────┘                                    └─────────────────────────────┘
         ▲                                                                    ▲
         └──────────── same `action` contract, two different endings ────────┘
```

## How it works

Think of `loader`/`action` as the two halves of a REST resource, colocated with the component that renders it: `loader` is your `GET` handler, `action` is your `POST`/`PUT`/`DELETE` handler, and both live in the same file as the component instead of a separate API layer you'd have to keep in sync by hand.

**The kernel: typed function in, typed hook out — no cache in between.**

```
Loader/action kernel

  navigation/submit
        │
        ▼
  route module's loader() or action()   ← runs server-side, every time
        │                                  (never cached client-side)
        ▼
  return value (plain object / redirect / Response)
        │
        ▼
  useLoaderData<typeof loader>()   /   useActionData<typeof action>()
        │                                  (type inferred from the
        ▼                                   function's own return type)
  component re-renders with fresh data
```

### The read half — `loader`, always re-run, never cached

Every one of this app's three UI routes exports a `loader` that authenticates, reads from the service layer, and returns a plain object — no `Response.json()` wrapper needed in newer Remix (`app._index.tsx:13-28`, `app.scans.$id.tsx:68-120`) though `app.settings.tsx:16-22` still uses the explicit `json()` helper (both forms coexist in this codebase and behave identically; the explicit form is slightly more common where an error status code needs setting, as in `app.settings.tsx:33-39`). `useLoaderData<typeof loader>()` (`app._index.tsx:48`, `app.scans.$id.tsx:503`) gets its TypeScript type by *reading the loader function's own return type* — there's no separate schema, no manually kept-in-sync interface. Rename a field the loader returns, and every `useLoaderData()` call site that reads it fails to typecheck immediately.

### The write half — two shapes for two different completion stories

**Shape A: navigate to the result (Post-Redirect-Get).** `app._index.tsx:30-45`:

```ts
// app._index.tsx:30-45
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const scan = await startScan(session.shop);
    return redirect(`/app/scans/${scan.id}`);
  } catch (error) {
    if (error instanceof ActiveScanError) {
      const active = await getActiveScanForShop(session.shop);
      if (active) {
        return redirect(`/app/scans/${active.id}`);
      }
    }
    throw error;
  }
};
```

Starting a scan creates a *new* resource (a `Scan` row) that didn't exist before the click — there's nowhere sensible to "re-render in place." The action redirects to that new resource's own route. **What breaks without the redirect:** if the action just returned the new scan's data instead, the browser's URL would still say `/app`, and refreshing the page (or sharing the URL) would land back on the onboarding screen, not the in-progress scan — the classic "form resubmission on refresh" problem PRG exists to solve. Note the fallback branch: catching `ActiveScanError` and redirecting to the *existing* active scan instead of surfacing a raw error — the merchant's "Run catalog audit" click always ends up looking at *a* scan, whether it's the one they just started or the one already running.

**Shape B: stay and show the result (in-place `json` response).** `app.settings.tsx:24-51`:

```ts
// app.settings.tsx:32-50
if (trimmed === "" || Number.isNaN(value)) {
  return json(
    {
      ok: false as const,
      error: `Enter a whole number between ${MARGIN_MIN} and ${MARGIN_MAX}`,
    },
    { status: 400 },
  );
}
try {
  const saved = await updateMinimumMargin(session.shop, value);
  return json({ ok: true as const, minimumMarginPercent: saved });
} catch (error) {
  if (error instanceof InvalidMarginError) {
    return json({ ok: false as const, error: error.message }, { status: 400 });
  }
  throw error;
}
```

Saving a setting mutates a resource that's already fully represented by the current URL (`/app/settings`) — there's no new place to send the merchant. The action returns a discriminated union (`ok: true` / `ok: false as const`), and the component (`app.settings.tsx:62-63`) reads it straight off `useActionData<typeof action>()`:

```ts
// app.settings.tsx:62-63
const errorMessage = actionData && !actionData.ok ? actionData.error : undefined;
const showSuccess = actionData?.ok === true && !isSubmitting;
```

The `as const` on each `ok` literal is what makes this a real discriminated union instead of a widened `boolean` — without it, TypeScript would let `actionData.error` be accessed even when `ok` is `true`, or vice versa, defeating the entire point of branching on `.ok`.

### Pending-UI state — derived, never hand-tracked

Neither route keeps its own `isLoading` boolean. Both derive it from Remix's router: `app._index.tsx:49-51` and `app.settings.tsx:56-58` both compute `navigation.state !== "idle" && navigation.formMethod === "POST"` from `useNavigation()`. **What breaks if a component tracked its own `isSubmitting` state instead:** it would need to manually flip it `true` before calling `fetch`/submitting and `false` after — miss the `false` on an error path, and the button stays disabled forever. Deriving it from the router's own in-flight state means there's exactly one source of truth for "is a submission currently in flight," and it can never go stale relative to what the browser is actually doing.

### The seam this repo does *not* use — a parallel JSON API

`api.scans.tsx` and `api.scans.$id.tsx` (resource routes with no default component) expose the same read/write operations as plain JSON endpoints — `POST /api/scans` mirrors `app._index.tsx`'s action almost line for line (`api.scans.tsx:12-30`), and `GET /api/scans/:id` mirrors the scan-detail loader. The embedded UI never calls either: it uses its own route's `loader`/`action` exclusively. These resource routes exist for a caller *outside* the React tree (programmatic access, a future integration) — worth naming because it's easy to assume "the JSON API is what the frontend calls," when here the frontend and the JSON API are two independent consumers of the same service layer, never each other.

## Primary diagram

```
Full recap — the loader/action seam, both shapes

┌─ GET (any route) ──────────────────────────────────────┐
│  loader() → plain object / json()                        │
│  useLoaderData<typeof loader>()  ← type-inferred            │
└────────────────────────────────────────────────────────────┘

┌─ POST, new-resource shape (app._index.tsx) ────────────────┐
│  action() → startScan() → redirect(`/app/scans/${id}`)        │
│  browser navigates; NEW route's loader runs                    │
└──────────────────────────────────────────────────────────────┘

┌─ POST, in-place shape (app.settings.tsx) ──────────────────┐
│  action() → validate → updateMinimumMargin() → json({ok,..}) │
│  SAME route re-renders; useActionData<typeof action>()        │
│  drives Banner + TextField error prop                          │
└──────────────────────────────────────────────────────────────┘

  pending UI in both: derived from useNavigation(), never a
  hand-tracked isSubmitting flag
```

## Elaborate

This is the same problem `react-query`'s `useMutation` or `SWR`'s mutate solves — typed, cache-aware server communication without hand-rolled `fetch` + `useState` juggling — solved instead by moving the fetch entirely server-side and letting the framework's own router own the request lifecycle. The tradeoff: there's no client-side cache to configure (no stale time, no background refetch interval to tune) because there's no client cache at all — every loader call is a fresh server round-trip. That's the right call for an admin app with low request volume and a database on the same machine; it would stop being free the moment a loader call became genuinely expensive or rate-limited, at which point this repo would need to reach for something react-query-shaped after all.

`not yet exercised`: optimistic UI (Remix's own `useFetcher` + pending-state pattern for updating the screen before the server confirms), multi-field client-side form validation before submit (both actions validate entirely server-side, on submit), and any mutation that touches more than one resource in a single round-trip.

## Interview defense

**Q: Why does `app._index.tsx`'s action redirect, but `app.settings.tsx`'s doesn't?**
A: It comes down to whether the mutation creates a resource the current URL doesn't represent. Starting a scan makes a brand-new `Scan` — the only sensible "result" page is that scan's own route, so the action redirects there (Post-Redirect-Get, which also prevents a refresh from re-submitting the form). Saving a setting mutates a resource the current URL *already* represents (`/app/settings` is still `/app/settings` after saving) — there's nothing to redirect to, so the action returns data in place instead.

**Q: How does this avoid the classic `useState`-tracked `isLoading` bug?**
A: It doesn't track loading state at all — it derives `isSubmitting` from `useNavigation().state`, which Remix's router itself flips as the request goes out and comes back. There's no separate boolean to forget to reset on an error path, because there's no separate boolean.

**Q: If there's no client cache, doesn't every navigation re-fetch everything?**
A: Yes, deliberately — every `loader` re-runs on every navigation and every `revalidate()` call, full stop. That's the tradeoff for zero cache-invalidation logic: correct-by-construction (you can never see stale data) at the cost of redundant reads. It's the right tradeoff against a same-machine SQLite file at this request volume; see `01-loader-driven-progress-polling.md` for where that cost actually shows up (a hundred-plus redundant polls over a long scan).

## See also

- `01-loader-driven-progress-polling.md` — the loader re-invoked by `useRevalidator` is this same read half.
- `02-url-state-as-filter-source-of-truth.md` — the loader's other job: parsing filters/pagination out of the URL on every GET.
- `05-resource-route-csv-download.md` — a third shape, a loader with no component and no JSON at all.
- `audit.md` → lens 4 (data-fetching and cache).
