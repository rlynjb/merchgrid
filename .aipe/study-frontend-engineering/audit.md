# Audit — frontend engineering, 8 lenses

Walks the codebase against the standard frontend-engineering lens inventory. Every claim below is grounded in a real file and line range. Where a lens finds nothing, it says so plainly rather than inventing a pattern this repo doesn't have. This is the reader's home turf — no on-ramp on what a loader, a hook, or a component is; the lenses go straight to how *this* repo does it.

## 1. Rendering and reactivity

**Rendering mode: server-rendered on every request, then hydrated — classic Remix SSR, not RSC, not islands, not a client-only SPA.** `app/entry.server.tsx:26-53` calls `renderToPipeableStream` on every document request; `app/root.tsx:23-27` ships `<Scripts />` so React rehydrates the same tree client-side. There is no `loader`-free client-only route and no server-components split — every route file exports one component that renders on both sides.

**Bot-aware streaming handoff.** `entry.server.tsx:20-23` picks the completion callback based on the request's user agent:

```ts
// entry.server.tsx:20-23
const callbackName = isbot(userAgent ?? '')
  ? "onAllReady"
  : "onShellReady";
```

A crawler waits for the full tree (`onAllReady`) so it indexes complete HTML; a real browser gets the shell the instant it's ready (`onShellReady`) and streams the rest in — the standard streaming-SSR tradeoff (fast paint vs. complete-on-first-byte), inherited from the Shopify Remix template and left as shipped. `streamTimeout` (`entry.server.tsx:11`) caps this at 5s, with a hard `abort()` at `streamTimeout + 1000` (`entry.server.tsx:57`) so a hung render can't hold the connection open forever.

**Reconciliation: React 18 virtual-DOM diffing, no fine-grained reactivity.** Nothing in `app/app/**` reaches for `useMemo`/`React.memo`/`useTransition` — every route re-renders its whole component tree on loader data change (see lens 8, finding 1, for the cost of that on `app.scans.$id.tsx`).

**When work happens: mount (loader → paint), then update (revalidate → re-render).** The one non-trivial reactivity story in this repo is *client-triggered revalidation without a client navigation* — `app.scans.$id.tsx:512-519` calls `useRevalidator().revalidate()` on a 2.5s interval while a scan is in flight, re-running the route's own loader and re-rendering with fresh data, with no URL change and no full-page transition. Full walkthrough: `01-loader-driven-progress-polling.md`.

Cross-link: the event loop and `setInterval` scheduling underneath that poll belong to `study-runtime-systems`; this lens only covers what triggers a re-render, not how the JS engine schedules the timer.

## 2. State architecture

Five kinds of state show up, and the codebase is disciplined about which one owns what:

| State | Owner | Where |
|---|---|---|
| Scan progress/results | Server (`Scan`/`Finding` rows), read fresh on every loader call | `app.scans.$id.tsx:68-120` |
| Filters (severity, checkId, search) + pagination | URL search params, not client memory | `app.scans.$id.tsx:72-79,383-400` |
| Selected finding (modal open/closed) | Local component state, `useState` | `app.scans.$id.tsx:506-508` |
| Filter form draft (before submit) | Local component state, re-synced from the URL after navigation | `app.scans.$id.tsx:223-231` |
| Pending-submission UI (button spinners) | Derived from Remix's own router state (`useNavigation()`), never a separate `isLoading` flag | `app._index.tsx:49-51`, `app.settings.tsx:56-58` |

There is no global client store (no Redux, no Zustand, no Context provider for domain data) anywhere in `app/app/**`. That's not a gap — Remix's loader/action model *is* the state-management layer: every route re-derives its truth from the server on every navigation and every `revalidate()`, so there's nothing for a global store to cache. The only client-owned state is UI-transient (which modal is open, what's typed but not yet submitted).

**The one place this gets subtle** is the filter form: `FilterBar` (`app.scans.$id.tsx:214-274`) keeps a local `useState` per field so the `Select`/`TextField` inputs are responsive while typing, then a `useEffect` (`app.scans.$id.tsx:227-231`) re-syncs that local state from `filters` (which itself comes from the URL) whenever the URL changes — so the draft and the committed value can only ever drift between a keystroke and the next `Apply filters` submit. See `02-url-state-as-filter-source-of-truth.md` for the full walkthrough and lens 8 for the tradeoff this creates.

Cross-link: system-level state ownership (which *process* owns the `Scan` row, atomicity of the write) belongs to `.aipe/study-system-design/` — see its `02-atomic-idempotent-scan-pipeline.md` and `05-shop-scoped-authorization.md`. This lens only covers where state lives once it crosses into the browser.

## 3. Component architecture

**Composition style: flat, route-colocated function components — no shared `components/` directory, no compound components, no render props, no headless UI layer.** `app.scans.$id.tsx` alone defines five presentational components inline in the route file: `ScanProgressCard` (122-170), `SummaryCard` (172-185), `FilterBar` (214-274), `FindingDetailModal` (276-381), `FindingsTable` (383-500). Each is a plain function taking props and returning Polaris JSX — no `memo`, no context, no shared base component between them.

This is a deliberate scale-appropriate choice, not an oversight: three routes, no reused visual pattern across routes (a `SummaryCard` used once per route isn't worth extracting to a shared file), and Polaris already supplies the actual design-system primitives (`Card`, `Badge`, `IndexTable`). Extracting these into `app/app/components/` would add a layer of indirection with no second caller to justify it yet. The container/presentational split *does* exist, just not as file boundaries — every one of these components is presentation-only, and every data-owning piece (the loader, the `useState` calls in the parent) stays in the route's default export.

**Abstraction earning its place — the one exception.** `settings.shared.ts` (`app/app/models/settings.shared.ts:1-8`) is pulled out specifically so the client bundle doesn't import `settings.server.ts`'s Prisma dependency:

```ts
// settings.shared.ts:1-8
/**
 * Constants shared between the settings service (server-only) and the
 * settings route's UI component (client + server). Kept in a non-`.server`
 * module so referencing it from the React component doesn't pull
 * `settings.server.ts` (and its Prisma import) into the client bundle.
 */
export const MARGIN_MIN = 0;
export const MARGIN_MAX = 90;
```

That's the one place in this codebase where a module boundary was drawn *because of* the client/server split, not despite it — worth noticing because it's easy to get backwards (importing a `.server.ts` constant from a component works in dev, then breaks the production bundle).

`not yet exercised`: slots/children-as-API patterns, render props, a headless-component layer, or any shared component reused across more than one route.

Cross-link: module depth and interface design (Ousterhout's lens on whether an abstraction earns its complexity) belongs to `.aipe/study-software-design/`; this lens only covers where component boundaries sit.

## 4. Data-fetching and cache

**The fetch seam is Remix loaders and actions — there is no client-side fetch library (no react-query, no SWR, no manual `useEffect` + `fetch`).** Every route's `useLoaderData<typeof loader>()` call is typed straight off its own `loader` export (e.g. `app.scans.$id.tsx:503-504`), so server state crosses into client state as a plain typed object, no cache/store in between.

Two distinct data-fetch shapes coexist, and the seam between them is worth tracing precisely — full walkthrough in `03-remix-loader-action-data-flow.md`:

- **Navigation-completing mutations** — `app._index.tsx`'s action (30-45) calls `startScan`, then `redirect()`s to the new scan's detail route. Post-Redirect-Get: the browser's URL bar and back button both land on the *result*, never on a bare form resubmission.
- **In-place mutations** — `app.settings.tsx`'s action (24-51) returns a typed `json({ ok, ... })` payload instead of redirecting, and the same route re-renders with `useActionData<typeof action>()` (55) driving a success/error `Banner`. No navigation happens at all.

**A separate, unused-by-the-UI JSON API surface exists in parallel.** `api.scans.tsx` (POST enqueue), `api.scans.$id.tsx` (GET summary + optional findings page) are resource routes with no default component — they exist for programmatic/webhook-style access, not for the embedded UI's own polling. The UI polls its *own* route's loader via `useRevalidator` (see lens 1), never `fetch()`s `api.scans.$id.tsx`. That's a real seam worth naming: two parallel read paths to the same data (`getScanSummary`/`getScanFindings` in `scan-api.server.ts:161-275`), one consumed by React re-render, one consumed by whatever external caller wants JSON.

**Cache invalidation: none needed, because there is no cache.** Every loader call re-reads SQLite directly (`scan-api.server.ts:225-275`); a `revalidate()` is a full re-read, not a cache-bust. This mirrors `study-system-design`'s audit.md lens 4 finding — `not yet exercised` here too, for the same reason: single-tenant-per-request, low-QPS embedded admin app, no client-visible staleness to manage.

**Error/retry behavior at the fetch seam:** none client-side. A loader that throws (e.g. `ScanNotFoundError` → `throw new Response("Not found", { status: 404 })` at `app.scans.$id.tsx:84-87`) is caught by Remix's route-level `ErrorBoundary` (`app.scans.$id.tsx:611-636`), not by any client retry logic. There's no exponential backoff, no stale-while-revalidate — the retry story that *does* exist (Shopify GraphQL throttling) lives entirely server-side in `catalog-reader.server.ts` and is out of scope for this generator (see `.aipe/study-system-design/audit.md` lens 6).

Cross-link: HTTP semantics of the loader/action request-response cycle belong to `study-networking`; cache-as-architecture (why there's no Redis layer) belongs to `study-system-design`.

## 5. Routing and navigation

**File-based routing via `@remix-run/fs-routes`.** `app/app/routes.ts:1-3` is the entire route-config surface:

```ts
// app/app/routes.ts
import { flatRoutes } from "@remix-run/fs-routes";
export default flatRoutes();
```

Route files under `app/app/routes/` are named by convention: `app.tsx` is the shared layout (a dot-segment prefix, `app.*`, nests under it), `app._index.tsx` is `/app`'s index, `app.scans.$id.tsx` is `/app/scans/:id` (the `$` marks a dynamic segment), `app.settings.tsx` is `/app/settings`, and `api.scans.$id.export.tsx` is a resource route with no UI at all. No config-based route table, no manual `<Route>` tree.

**Nested layout, one level deep.** `app.tsx:18-32` wraps every `app.*` route: it authenticates once (`authenticate.admin(request)` in its own loader, 12-16), renders Shopify's `NavMenu` (23-28) and Polaris's `AppProvider` (22) around an `<Outlet />` (29) that the three child routes render into. There's no second nesting level — every leaf route is one hop from the layout.

**Code-splitting at the route boundary is Remix/Vite's default, not hand-tuned.** Each route file becomes its own chunk automatically under `@remix-run/dev`'s Vite plugin (`vite.config.ts:54-64`); nothing in this repo opts a route out of that or lazy-loads a sub-tree manually.

**Navigation lifecycle:** two distinct mechanisms, not one —
- **Full navigation, server round-trip:** `redirect()` after a POST (`app._index.tsx:35`), and plain `<Link>`/`<Button url=...>` to another route.
- **Shallow client-side navigation, same route, only search params change:** `FindingsTable`'s pagination (`app.scans.$id.tsx:392-400,493-495`) calls `useNavigate()` with a `?page=N` URL built from the current `useSearchParams()` — Remix's client router intercepts this, re-runs the *same* route's loader, and re-renders without a full document reload.

No prefetch-on-hover, no `<Link prefetch="intent">`, no view-transition API usage, no scroll-restoration customization beyond Remix's default `<ScrollRestoration />` (`root.tsx:25`). `not yet exercised`: nested routes beyond one level, route guards/redirects beyond the OAuth check in `app.tsx`'s loader, and any deep-linking concern beyond "the URL is shareable" (see lens 2 and `02-url-state-as-filter-source-of-truth.md`).

## 6. Styling and design system

**Two styling systems, cleanly partitioned by route, not mixed.** The embedded admin surface (`app.tsx` and everything nested under it) pulls in Shopify Polaris wholesale — `app.tsx:6,10` links Polaris's compiled stylesheet (`@shopify/polaris/build/esm/styles.css?url`) at the layout root, and every component in `app._index.tsx`, `app.scans.$id.tsx`, `app.settings.tsx` is a Polaris component (`Page`, `Card`, `IndexTable`, `Banner`, …) styled entirely by Polaris's own token system. The pre-auth login route (`app/app/routes/_index/route.tsx`) is the one place that opts out — it renders plain HTML styled by a CSS Module (`_index/styles.module.css`), with no Polaris import at all. Full walkthrough of why that split exists and what it costs: `06-route-scoped-design-system-boundary.md`.

**No design tokens defined in this repo.** Polaris supplies its own internal token system (spacing scale, color roles, type scale) consumed through component props (`gap="400"`, `variant="headingLg"`, `tone="critical"`) rather than raw CSS values — this app never reaches for a hex code or a `px` value inside the embedded routes. `_index/styles.module.css` is the only hand-rolled CSS in the repo, and it's still boilerplate from the Shopify Remix template (`styles.module.css:1-73`) — the placeholder copy in `_index/route.tsx:25-53` ("A short heading about [your app]") confirms it was never adapted after scaffolding. See lens 8, finding 5.

`not yet exercised`: dark mode/theming, CSS-in-JS, utility-first CSS (Tailwind or similar), container queries, a custom animation system, or any design-token layer of this app's own — every visual decision inside the embedded surface is Polaris's, by choice (see `06-route-scoped-design-system-boundary.md` for why that's the right call here).

## 7. Browser platform and build

**Web platform APIs actually touched: effectively none, directly.** No `localStorage`/`sessionStorage`, no `Worker`/`ServiceWorker`, no `IndexedDB`, no `WebSocket`/`EventSource`, no `MediaRecorder` anywhere in `app/app/**`. App Bridge (`@shopify/app-bridge-react`, used for `TitleBar` and `NavMenu`) manages the embedding iframe/`postMessage` handshake with Shopify admin internally, but this app's own code never touches `window.postMessage` or the iframe boundary directly — it's entirely behind App Bridge's React components.

**Build: Vite, via the Remix Vite plugin, producing three separate build artifacts for one deploy.** `vite.config.ts:53-65` configures the `remix()` Vite plugin with a set of `future` flags (`v3_fetcherPersist`, `v3_relativeSplatPath`, `v3_throwAbortReason`, `v3_lazyRouteDiscovery`, `v3_routeConfig` — opting into Remix's next-major behaviors early; `v3_singleFetch` explicitly left `false`) plus `tsconfigPaths()` for path-alias resolution. `build.assetsInlineLimit: 0` (`vite.config.ts:67-69`) turns off Vite's default "inline small assets as base64" behavior — every asset gets a real URL, which matters for an app served through Shopify's CDN/proxy layer where an inlined-then-cached data URI would behave differently than a normal cacheable asset. `optimizeDeps.include` (`vite.config.ts:70-72`) force-pre-bundles `@shopify/app-bridge-react` and `@shopify/polaris` in dev, since both ship many internal ESM entry points that would otherwise cause a cascade of dev-server re-optimization on first load.

The `build` script (`package.json:5`) chains three independent builds: `build:packages` (`tsc -b packages/catalog-checks`, compiling the pure engine package), `remix vite:build` (the actual Remix/Vite SSR + client bundle), and `build:worker` (`esbuild worker.ts --bundle --platform=node --format=esm --packages=external`, `package.json:7`) — a *second*, non-Vite bundle for the background worker process, which never touches the browser at all. Three artifacts, one Fly machine (`.aipe/study-system-design/06-single-machine-shared-volume.md`).

**HMR is network-topology-aware, not a fixed default** — `vite.config.ts:23-38` switches between a plain `ws://localhost:64999` dev HMR channel and a `wss://` channel through the tunnel's `FRONTEND_PORT` when running inside Shopify CLI's dev tunnel (`host !== "localhost"`), because the embedded app's dev preview loads through a public HTTPS tunnel, not `localhost` directly.

Cross-link: bundle-size *measurement* (actual KB shipped, FCP/LCP against it) belongs to `study-performance-engineering`; this lens only covers what's configured to produce the bundle.

## 8. Frontend red flags — ranked

1. **Unbounded poll with no backoff or stuck-scan UX.** `app.scans.$id.tsx:512-519` polls every 2.5s for as long as `summary.status` is non-terminal, with no cap on elapsed time and no "this is taking unusually long" state. If the worker process is down (or livelocked on a poison-pill scan — see `.aipe/study-system-design/01-single-worker-db-queue.md`), the merchant's browser polls forever with no visible signal that anything is wrong. Full mechanism in `01-loader-driven-progress-polling.md`.
2. **Derived-state-via-`useEffect` in the filter form.** `FilterBar`'s local `useState` + re-sync `useEffect` (`app.scans.$id.tsx:223-231`) is the classic "state that shadows a prop" smell — three fields of local state that exist only to make inputs feel responsive, kept in sync with the real source of truth (the URL) by an effect rather than derived directly. Low-risk here (the effect only fires on navigation, and the fields reset correctly), but it's the shape that gets genuinely buggy the moment a fourth filter or an async default value gets added. See `02-url-state-as-filter-source-of-truth.md` for the full tradeoff.
3. **No re-render containment on the findings table.** Every `IndexTable` row (`app.scans.$id.tsx:402-457`) is a fresh component instance recomputed on every parent re-render — including every 2.5s poll tick while a scan is running, though the table itself only mounts once the scan is `COMPLETED`, so this specifically bites when a merchant re-opens filters or paginates on a large (near the 5,000-variant / `MAX_PAGE_SIZE=200`-per-page) result set. Not a bug at today's scale; worth a `React.memo` or key-stable row extraction before result sets grow.
4. **Placeholder styling shipped to production.** `_index/route.tsx:25-53` and `_index/styles.module.css` are unmodified Shopify Remix template boilerplate ("A short heading about [your app]," three "Product feature" bullets) — this is the pre-auth landing route a merchant sees before installing, and it's dead scaffold copy, not a deliberate placeholder. Low severity (this route is bypassed entirely once a `shop` param is present — `_index/route.tsx:11-14` redirects straight to `/app`), but it's live, reachable code.
5. **Zero design-token customization surface.** Every visual decision inside the embedded routes is Polaris's default theme (see lens 6) — correct for an embedded admin app today, but it means there is currently no mechanism in this codebase to apply a brand accent, a dark variant, or any Shopify Polaris theming override if that's ever required; it would need to be built from scratch, not just switched on.

No finding above points to invented risk — every ranked item traces to a real file, a real line range, or a real absence already named in the lenses that precede it.
