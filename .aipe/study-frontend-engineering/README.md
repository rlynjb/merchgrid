# Study — Frontend Engineering: MerchGrid: Catalog Audit

A per-repo frontend-engineering guide for the MerchGrid: Catalog Audit codebase — a read-only embedded Shopify admin app built on Remix (Vite), Shopify Polaris, and App Bridge, that audits a merchant's product catalog with 10 deterministic checks (no LLM/AI) and never mutates the store.

## Reading order

1. **`00-overview.md`** — the frontend in one diagram: rendering mode, state ownership, the network seam, and the three highest-leverage patterns. Read this first, even if you only read one file.
2. **`audit.md`** — the 8-lens walk (rendering/reactivity, state architecture, component architecture, data-fetching/cache, routing/navigation, styling/design system, browser platform/build, red flags). Read this second — it's the map of what's here and cross-links to the deep-dive files below.
3. **`01`–`06`** — the discovered patterns, each a full concept file (mental model → mechanism → this repo's code → interview defense):
   - `01-loader-driven-progress-polling.md` — `useRevalidator` + `setInterval` giving the scan-results route live progress with no push channel
   - `02-url-state-as-filter-source-of-truth.md` — severity/check/search/page filters living in the URL, not client memory
   - `03-remix-loader-action-data-flow.md` — the loader/action seam as the entire data layer, and the redirect-vs-in-place-banner split across two mutating routes
   - `04-scan-state-machine-driving-ui-branching.md` — a server-owned `ScanStatus` enum picking which of three views renders, no client-derived status
   - `05-resource-route-csv-download.md` — the CSV export as a Remix resource route reached by a plain link, not a fetch+blob
   - `06-route-scoped-design-system-boundary.md` — Polaris owning every embedded route, a CSS Module owning exactly one pre-auth route

## Cross-links to neighboring guides

This guide owns the framework-and-platform layer only — rendering, state shape, components, the data-fetch seam, routing, styling, platform APIs, and the build. For mechanism-level depth or system-level architecture, go to:

- **`.aipe/study-system-design/`** — where scan state and findings actually live server-side, the queue, the atomic pipeline, shop-scoped authorization. This guide's `04-scan-state-machine-driving-ui-branching.md` covers only how the *client* renders off that state; the state machine's ownership and transaction guarantees live there.
- **`.aipe/study-software-design/`** — module depth and interface design (Ousterhout's lens); this guide's component-architecture lens (`audit.md` → lens 3) names *where* boundaries sit, not whether each one is well-abstracted.
- **`.aipe/study-performance-engineering/`** — FCP/LCP/TTI and bundle-size measurement as numbers; this guide's browser-platform-and-build lens (`audit.md` → lens 7) covers what's configured to produce the bundle, not how fast it loads.
- **`.aipe/study-security/`** — trust boundaries, session-token handling, XSS/CSP; this guide only notes that App Bridge handles the iframe/`postMessage` boundary internally.
- **`.aipe/study-runtime-systems/`** — the Node event loop and timer scheduling underneath both the worker's poll loop and the browser's `setInterval` in `01-loader-driven-progress-polling.md`.
- **`.aipe/study-networking/`** — HTTP semantics of the loader/action request-response cycle referenced throughout `03-remix-loader-action-data-flow.md`.
