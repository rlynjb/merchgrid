# 02 — URL state as filter source of truth

**URL-as-state (search-params-driven UI).** Industry standard pattern — project-specific implementation (a GET `<Form>` plus a loader that reads `URLSearchParams` directly, no router-state library).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Browser ──────────────────────────────────────────────────┐
│  FilterBar (draft inputs)  →  <Form method="get">             │
│  FindingsTable pagination  →  useNavigate(?page=N)             │
└──────────────────────────┬──────────────────────────────────┘
                            │  navigation, URL changes
┌─ URL ──────────────────────▼──────────────────────────────────┐
│  ?severity=&checkId=&q=&page=   ★ THIS CONCEPT ★  ← we are here│
└──────────────────────────┬──────────────────────────────────┘
                            │  read by
┌─ Remix loader ─────────────▼──────────────────────────────────┐
│  app.scans.$id.tsx loader → getScanFindings(shop, id, opts)    │
└────────────────────────────────────────────────────────────────┘
```

You've built a form before where you had to decide "where does the current value live while the user is typing, and where does it live once submitted?" This is that question, answered by putting the *submitted* value nowhere but the URL — no Context, no store, no prop drilled down from a parent. The URL bar is the state container.

## Structure pass

**Axis: state — where does the committed filter value live, and who can read it?** Everyone: the URL is visible to the loader (server-side, on the next request), to `useSearchParams()` (client-side, to build pagination links), and to the merchant (in the address bar, copy-pasteable). Compare that to the alternative — a `useState` in a shared ancestor — which only the React tree can see, and which resets to nothing on refresh.

**Seam:** the boundary between the *draft* value (what's typed but not yet submitted) and the *committed* value (what's actually filtering the results) is a real seam, and it's exactly where lens 8's finding #2 lives. On one side of the seam, local `useState` owns the value; on the other, the URL does; the two are kept in sync by an effect, not by sharing the same piece of state.

```
The seam — draft vs. committed, and what crosses it

axis traced = "who owns this value right now?"

┌─ before submit ──────────┐  seam: <Form method="get"> submit  ┌─ after submit ───┐
│ local useState owns it    │ ══════════╪═══════════════════════► │ URL owns it       │
│ (per keystroke)            │   (it flips)                       │ (loader reads it) │
└────────────────────────────┘                                    └────────────────────┘
         ▲                                                                  ▲
         └──────────── same logical value, two different owners ──────────┘
```

## How it works

You already know the shape of "controlled input backed by `useState`." The twist here is that the *real* value being controlled isn't kept in React state at all past the point of submission — it's re-derived from `window.location.search` on every render, via Remix's `useLoaderData`/`useSearchParams`, the same way you'd re-derive a value from a prop instead of copying it into local state.

**The kernel: parse on the server, form-submit on the client, no client-side filtering.**

```
URL-state kernel

  loader:  URL.searchParams → { page, severity, checkId, q }
              │
              ▼
       getScanFindings(shop, id, { page, severity, checkId, search: q })
              │                         (SQL WHERE clause — not
              ▼                          a client-side .filter())
        findingsPage { findings, total, page, pageSize }
              │
              ▼
  component:  <Form method="get">  → browser navigates to new URL
              useNavigate(?page=N) → same, for pagination
```

### Parsing the URL — server-side, defensively

`app.scans.$id.tsx:72-79`:

```ts
// app.scans.$id.tsx:72-79
const pageParam = Number(url.searchParams.get("page") ?? "1");
const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1;

const severity = url.searchParams.get("severity") || "";
const checkId = url.searchParams.get("checkId") || "";
const q = url.searchParams.get("q") || "";
```

Every value from `searchParams.get()` is untyped (`string | null`) and fully attacker-controlled — a merchant (or a bookmarked/shared link) can put anything in that query string. `page` gets validated to "a finite positive integer, or fall back to 1" before it ever reaches a SQL `skip`/`take` clause (`scan-api.server.ts:239-245`); `severity`/`checkId`/`q` fall back to empty string, which the query layer treats as "no filter" (`scan-api.server.ts:247-262`, `if (opts.severity) { where.severity = ... }`). **What breaks if you skipped that validation:** a malformed `?page=-5` or `?page=abc` would either produce a negative `skip` (Prisma would reject it, surfacing a raw 500) or `NaN` propagating into the pagination math silently returning zero rows — either way, a URL the merchant typed by hand or a stale bookmark would break the page instead of gracefully falling back to page 1.

### Filtering happens in SQL, never in the browser

`getScanFindings` (`scan-api.server.ts:225-275`) builds a `Prisma.FindingWhereInput` from the parsed params and hands it straight to the database — there is no `findings.filter(...)` anywhere in the React code. This matters for a reason beyond performance: the *total count* (`total` in `FindingsPage`, used to compute `hasNext`/`hasPrevious` for `Pagination`, `app.scans.$id.tsx:459-460`) has to reflect the filtered set, not the full set. If filtering happened client-side after receiving one page of unfiltered data, pagination math would be wrong the instant a filter was active — you'd be paginating over a page that no longer matches what's displayed.

### Submitting a filter — a real navigation, not an XHR

`FilterBar` (`app.scans.$id.tsx:214-274`) wraps its inputs in a plain `<Form method="get">` (240). Clicking "Apply filters" is a real browser navigation to `/app/scans/:id?severity=...&checkId=...&q=...` — Remix intercepts it client-side (no full page reload), but the *result* is indistinguishable from typing that URL directly. That's deliberate: it's what makes the filtered view a real, shareable, bookmarkable, back-button-correct URL, not an ephemeral client state that vanishes on refresh.

### Pagination — the same mechanism, built by hand

`FindingsTable`'s `buildPageUrl` (`app.scans.$id.tsx:396-400`):

```ts
// app.scans.$id.tsx:396-400
const buildPageUrl = (targetPage: number) => {
  const params = new URLSearchParams(searchParams);
  params.set("page", String(targetPage));
  return `?${params.toString()}`;
};
```

This clones the *current* search params (preserving whatever filters are active) and overwrites only `page`, then hands the result to `useNavigate()` (493-495). **What breaks if you built the URL from scratch instead of cloning `searchParams`:** clicking "next page" while a severity filter was active would silently drop that filter — the merchant would see an unfiltered page 2 after a filtered page 1, with no visible cause. Preserving the rest of the query string is the load-bearing part of this one-liner.

### The draft/committed seam — where the smell lives

`FilterBar` keeps local `useState` for each field (`app.scans.$id.tsx:223-225`) so the `Select`/`TextField` components feel responsive while the merchant is choosing values, then re-syncs from the URL-derived `filters` prop on every change (`app.scans.$id.tsx:227-231`):

```ts
// app.scans.$id.tsx:227-231
useEffect(() => {
  setSeverity(filters.severity);
  setCheckId(filters.checkId);
  setQ(filters.q);
}, [filters.severity, filters.checkId, filters.q]);
```

This is "state that mirrors a prop," the pattern React's own docs warn is usually a smell — and it's not free of one here: between a keystroke and the next `Apply filters` click, the draft and the URL can diverge, and if a *fourth* filter field were added without also adding it to this effect's dependency array, that field would silently stop re-syncing after navigation. It's low-risk today because the only way `filters` changes is a full navigation (which remounts nothing but does re-run this effect), and there's no async default value competing with it. The real fix, if this repo needed a fifth or sixth filter, would be deriving directly from `filters` with `key={filters.severity + filters.checkId + filters.q}` forcing a remount, or dropping local state entirely and controlling the inputs straight off the loader-derived value with `defaultValue` instead of `value`.

## Primary diagram

```
Full recap — URL as the filter/pagination source of truth

┌─ URL ───────────────────────────────────────────────────┐
│  /app/scans/:id?severity=CRITICAL&checkId=MG-001&page=2   │
└──────────────────┬────────────────────────────────────┬──┘
     read by loader │                    read by useSearchParams
                     ▼                                    ▼
┌─ loader (server) ──────────────┐        ┌─ FindingsTable (client) ─┐
│ parse + validate → getScanFindings│      │ buildPageUrl(page+1)      │
│ (SQL WHERE + LIMIT/OFFSET)        │      │ preserves existing filters │
└──────────────────┬────────────────┘      └───────────┬────────────────┘
                    │ findingsPage                       │ navigate(url)
                    ▼                                    ▼
              re-render with new rows            new URL, loader re-runs

┌─ FilterBar (client, draft-only) ────────────────────────┐
│ useState per field ←──sync-on-nav──── filters (from URL)  │
│ <Form method="get"> submit → real navigation, URL owns it │
└────────────────────────────────────────────────────────────┘
```

## Elaborate

Putting filter/pagination state in the URL instead of a client store is the same move `react-router`/Next.js apps reach for when they want "shareable, refreshable, back-button-correct" views without adding a state library — the URL was always a synchronization primitive, long before SPAs; this repo just leans on it directly instead of wrapping it in a hook abstraction. The cost it accepts: every filter change is a real navigation (a network round-trip to re-run the loader), not an instant client-side re-filter of already-fetched data. That's the right tradeoff here because the *data* has to come from the server anyway (SQL pagination over potentially thousands of findings) — there's no "already have all the rows, just filter them" option to give up.

`not yet exercised`: debouncing the search field before it becomes a URL change (today, `q` only updates the URL on explicit "Apply filters" click, so this isn't actually a live-search-as-you-type UI — worth naming plainly, since the `TextField` looks like it could be), and any client-side optimistic filter preview before the loader round-trip completes.

## Interview defense

**Q: Why not just keep filters in a `useState` at the route's top level?**
A: Because the requirement isn't "the component remembers the filter" — it's "a merchant can bookmark or share a filtered view, and refreshing the page doesn't lose it." `useState` dies on refresh and can't be shared as a link; the URL survives both for free, because it *is* the address the merchant is looking at.

**Q: Why does `FilterBar` still need local `useState` if the URL is the source of truth?**
A: Purely for input responsiveness — Polaris's `Select`/`TextField` need a controlled `value` on every keystroke, and re-running the loader on every keystroke (which is what a URL-only controlled input would require) would be far too chatty. The local state is a draft buffer between keystrokes and the explicit "Apply filters" submit; it's re-synced from the URL after every navigation so it can never diverge for longer than one form session.

**Q: Where's the actual bug risk in this pattern?**
A: The sync `useEffect` (`app.scans.$id.tsx:227-231`) has to list every filter field in its dependency array by hand. Add a filter and forget to add it there, and that one field silently stops resetting after navigation — the classic missed-dependency bug, and it's easy to miss because the component still *looks* correct until you specifically test "apply a filter, then click a link that clears query params."

## See also

- `03-remix-loader-action-data-flow.md` — the loader that reads these params is the same loader `useLoaderData` and the poll in `01` both depend on.
- `audit.md` → lens 2 (state architecture), lens 5 (routing and navigation), lens 8 finding 2.
