# 00 — Frontend overview

The frontend of MerchGrid: Catalog Audit in one picture, then a legend for every box.

**Rendering mode, in one sentence:** it's a server-rendered Remix (Vite) app hydrated once per document load — no RSC, no islands, no client-only SPA shell — and the one place it feels "live" is a plain `setInterval` + `useRevalidator` poll on the scan-results route, not a websocket.

```
Frontend — MerchGrid: Catalog Audit, browser to bundle

┌─ Browser (Shopify admin iframe) ───────────────────────────────────────┐
│  Polaris components + App Bridge TitleBar/NavMenu                       │
│  routes rendered here: app._index / app.scans.$id / app.settings        │
│  local state: selected finding (modal), filter-form draft               │
└──────────────────────────┬──────────────────────────────────────────┬─┘
      GET (loader) / POST (action), same-origin, session-token auth   │
                            ▼                                          │
┌─ Remix (Vite) — SSR + route modules ──────────────────────────────┐  │
│  root.tsx (html shell) → app.tsx (layout: auth + NavMenu + Outlet)  │  │
│    → app._index.tsx (start scan)                                    │  │
│    → app.scans.$id.tsx (poll + filter + paginate + CSV link)  ──────┼──┘
│    → app.settings.tsx (in-place form + banner)                      │
│  entry.server.tsx: streaming SSR, isbot-aware handoff                │
└──────────────────────────┬──────────────────────────────────────────┘
                            │  scan-api.server.ts reads (shop-scoped)
                            ▼
┌─ Service layer (server-only) ──────────────────────────────────────┐
│  services/scan/scan-api.server.ts, queue.server.ts, runner.server.ts│
│  → SQLite via Prisma (Scan, Finding)                                 │
└──────────────────────────────────────────────────────────────────────┘

  build: Vite (Remix plugin) → SSR + client bundle
         esbuild (separate) → worker.ts bundle (never touches the browser)
         tsc -b               → packages/catalog-checks (pure engine)
```

## State architecture, in one diagram

```
State ownership — who holds what, and where it lives

┌─ server-owned (source of truth) ───────────────────────────┐
│  Scan.status, Finding rows — read fresh on every loader call │
└──────────────────────────┬───────────────────────────────────┘
                            │ crosses into the browser as
                            │ typed loader data, never cached
┌─ URL-owned (shareable, survives refresh) ────────────────────┐
│  page, severity, checkId, q — search params, not client memory│
└──────────────────────────┬───────────────────────────────────┘
                            │ mirrored into
┌─ component-owned (ephemeral, UI-only) ────────────────────────┐
│  selected finding (modal open/closed)                          │
│  filter-form draft (re-synced from URL via useEffect)          │
│  submitting/pending flags (derived from useNavigation(), never │
│    a hand-rolled isLoading boolean)                            │
└──────────────────────────────────────────────────────────────┘
```

## Network seam, in one diagram

```
The fetch seam — loaders/actions only, no client fetch library

  Form (GET, filters/pagination)  ──►  route's own loader  ──► re-render
  Form (POST, start scan)         ──►  action → redirect()  ──► new route
  Form (POST, save setting)       ──►  action → json({ok,..})──► same route,
                                                                   banner
  setInterval (2.5s, in-flight)   ──►  useRevalidator()      ──► same loader,
                                                                   re-render
  <Button url=.../export>         ──►  full navigation to a resource route
                                       (Content-Disposition download,
                                        no JS fetch at all)

  not present: react-query/SWR, a global client store, WebSocket/SSE
```

## The three highest-leverage frontend patterns

1. **Loader-driven progress polling** (`app/app/routes/app.scans.$id.tsx:505-519`) — a scan's live progress reaches the browser with `useRevalidator` + `setInterval`, not a push channel. Strip it out and the merchant has to manually refresh to see whether a scan finished. → `01-loader-driven-progress-polling.md`.
2. **URL as the filter/pagination source of truth** (`app/app/routes/app.scans.$id.tsx:68-119,214-274,383-400`) — severity, check, search, and page all live in the URL via a GET `<Form>`, not client memory, so a filtered results view survives a refresh and is shareable as a link. → `02-url-state-as-filter-source-of-truth.md`.
3. **The loader/action seam as the entire data layer** (`app/app/routes/app._index.tsx:30-45`, `app/app/routes/app.settings.tsx:24-51`) — one mutation shape redirects to a new resource (Post-Redirect-Get), the other re-renders in place with a typed `json()` payload; no client fetch library exists anywhere in this app because Remix's own loader/action cycle *is* the fetch layer. → `03-remix-loader-action-data-flow.md`.

## Legend — what each box is, owns, and talks to

| Box | What it is | What it owns | Talks to |
|---|---|---|---|
| **Browser (embedded)** | Polaris + App Bridge inside Shopify's admin iframe | Ephemeral UI state (modal, filter draft), the 2.5s poll timer while a scan runs | Remix loaders/actions over same-origin HTTP, session-token authenticated |
| **Remix (Vite) app** | `app/app/root.tsx` → `app.tsx` layout → three leaf routes | Server rendering (streaming, `entry.server.tsx`), routing (`routes.ts`'s `flatRoutes()`), the loader/action data seam | The service layer (`scan-api.server.ts` et al.), never the database directly |
| **Service layer** | `app/app/services/scan/*.server.ts` | Shop-scoped reads/writes, the scan state machine, CSV formatting | SQLite via Prisma — out of this guide's scope, see `study-system-design` |
| **Build pipeline** | Vite (Remix plugin) + a second `esbuild` pass + `tsc -b` | Three artifacts from one `npm run build`: SSR+client bundle, worker bundle, compiled engine package | Nothing at runtime — build-time only |

## Map of the concept files

- `audit.md` — walks all 8 lenses (rendering, state, components, data-fetching, routing, styling, platform/build, red flags) against this map; start there for the "is X exercised here?" answer on any topic.
- `01-loader-driven-progress-polling.md` — the `useRevalidator`/`setInterval` mechanism behind the "this page updates automatically" copy on the scan-results route.
- `02-url-state-as-filter-source-of-truth.md` — why filters and pagination live in `searchParams`, not a client store.
- `03-remix-loader-action-data-flow.md` — the loader/action seam itself, and why two routes' mutations complete differently (redirect vs. in-place banner).
- `04-scan-state-machine-driving-ui-branching.md` — how a server-owned enum (`ScanStatus`) picks which of three Polaris views renders, with no client-side derived status.
- `05-resource-route-csv-download.md` — the export endpoint as a Remix resource route reached by a plain link, not a fetch+blob.
- `06-route-scoped-design-system-boundary.md` — why Polaris owns every embedded route and a hand-rolled CSS Module owns exactly one pre-auth route, never both on the same route.
