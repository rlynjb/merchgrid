# 05 — Resource route as a download endpoint

**Resource route (a route with no UI, only a `loader`) used as a native browser download.** Framework-specific mechanism (Remix's resource-route convention), standing in for the more common client-side "fetch a blob, construct an object URL" download pattern.

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Browser ────────────────────────────────────────────────────┐
│  <Button url="/api/scans/:id/export" external>Export CSV</Button>│
│  a plain link — no onClick, no fetch, no JS at all              │
└──────────────────────────┬──────────────────────────────────┘
                            │  full browser navigation (GET)
┌─ Remix resource route ─────▼──────────────────────────────────┐
│  api.scans.$id.export.tsx   ★ THIS CONCEPT ★  ← we are here     │
│  loader only — no default export, nothing to render              │
└──────────────────────────┬──────────────────────────────────┘
                            │  reads + formats
┌─ Service layer ─────────────▼──────────────────────────────────┐
│  getAllFindingsForExport → buildFindingsCsv                     │
└────────────────────────────────────────────────────────────────┘
```

You've written the "fetch a blob, `URL.createObjectURL`, create a hidden `<a>`, click it" dance to trigger a download from JavaScript before. This route skips all of it — it's a plain link to a URL that happens to return a file instead of HTML, and the browser's own native download handling (driven by one response header) does the rest.

## Structure pass

**Axis: control — who decides this is a "download" rather than a page?** Not the browser, and not any client JavaScript — the *server response* decides, via a single header. Everything upstream of that header (the `<Button url=... external>`) is a completely ordinary link; nothing about it says "this triggers a download" until the response comes back.

**Seam:** `Content-Disposition: attachment; filename="..."` (`api.scans.$id.export.tsx:61-66`). That header is the entire contract between this route and the browser's download behavior — remove it, and the exact same CSV bytes would just render inline as plain text in the tab instead of downloading.

```
The seam — one header decides "render" vs. "download"

axis traced = "does the browser show this or save it?"

┌─ without Content-Disposition ─┐  seam: response header  ┌─ with Content-Disposition ─┐
│ text/csv renders inline         │ ══════╪════════════════► │ browser downloads it,       │
│ as plain text in the tab         │  (it flips)             │ named per filename=          │
└────────────────────────────────────┘                       └────────────────────────────────┘
```

## How it works

**The kernel: a loader with no component, a Response with download headers.**

```
Resource-route kernel

  GET /api/scans/:id/export
        │
        ▼
  authenticate + authorize (identical shape to every other loader)
        │
        ▼
  getAllFindingsForExport(shop, scanId)   ← throws if not owned / not COMPLETED
        │
        ▼
  buildFindingsCsv(findings, meta, checkNames)   ← pure, engine-side formatting
        │
        ▼
  new Response(csv, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="..."`,
  })
        │
        ▼
  browser: no component to mount — it downloads the response body
```

### No default export — the part that makes this a "resource route"

`api.scans.$id.export.tsx` (67 lines total) exports only a `loader` — no `export default function`. In Remix's file-based routing, a route file with no default component is a **resource route**: it still gets a URL and still runs its `loader`/`action`, but there's nothing for React to render, because nothing ever will. This is the same file shape as `api.scans.tsx` and `api.scans.$id.tsx` (the JSON API surface from `03-remix-loader-action-data-flow.md`) — the pattern this repo reaches for any time a route's whole job is "return a non-HTML response," whether that's JSON or a file.

### Authorization and readiness gating happen before formatting, in a specific order

`api.scans.$id.export.tsx:33-48`:

```ts
// api.scans.$id.export.tsx:35-48
try {
  ({ summary, findings } = await getAllFindingsForExport(
    session.shop,
    scanId,
  ));
} catch (error) {
  if (error instanceof ScanNotFoundError) {
    throw new Response("Not found", { status: 404 });
  }
  if (error instanceof ScanNotCompletedError) {
    throw new Response("Scan is not complete", { status: 409 });
  }
  throw error;
}
```

`getAllFindingsForExport` itself checks ownership *before* checking completion status (`scan-api.server.ts:286-304`) — a wrong-shop request gets the same generic 404 a nonexistent scan would, and only an owned-but-unfinished scan reveals the more specific "not complete" 409. **What breaks if the order were reversed** (completion checked before ownership): a request for someone *else's* in-progress scan would get a 409 instead of a 404 — which confirms, to an attacker probing scan IDs, that the scan exists and simply hasn't finished. Checking ownership first means every unauthorized request gets exactly the same response, regardless of what state the scan it's probing is actually in.

### The download itself — headers, not client script

`api.scans.$id.export.tsx:50-66`:

```ts
// api.scans.$id.export.tsx:57-66
const safeShop = session.shop.replace(/\./g, "-");
const datePart = scannedAt.slice(0, 10);
const filename = `merchgrid-catalog-audit-findings-${safeShop}-${datePart}.csv`;

return new Response(csv, {
  headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  },
});
```

Two things worth naming: the filename is sanitized (`shopDomain`'s dots replaced with dashes) *before* going into a header value the browser will treat as a literal filename — a domain like `my-shop.myshopify.com` becomes `my-shop-myshopify-com` so the saved file doesn't end up with an unexpected extension boundary. And `attachment` (rather than `inline`) is what actually triggers the save-to-disk behavior; `Content-Type: text/csv` alone would still let the browser choose to render it as text.

### Reached by a plain link, not a fetch

`app.scans.$id.tsx:582-586`:

```tsx
// app.scans.$id.tsx:582-586
<InlineStack align="end">
  <Button url={`/api/scans/${summary.id}/export`} external>
    Export CSV
  </Button>
</InlineStack>
```

Polaris's `Button` with a `url` prop renders a plain `<a href=...>` under the hood, and `external` marks it as a full navigation (not a client-side Remix route transition). Clicking it is a completely ordinary browser navigation to a URL that happens to come back with `Content-Disposition: attachment` — which is precisely why there's no client-side `fetch` + blob + object-URL dance anywhere in this codebase for the export feature. **What you'd give up by fetching the CSV client-side instead:** you'd have to handle the blob, construct an object URL, create and click a hidden anchor, and revoke the object URL afterward — four extra client-side steps this route makes unnecessary by letting the server-set header do the entire job.

## Primary diagram

```
Full recap — CSV export end to end

┌─ browser ────────────────────────────────────────┐
│  <Button url="/api/scans/:id/export" external>      │
│  → plain link click → full navigation, GET           │
└──────────────────────┬────────────────────────────┘
                        ▼
┌─ api.scans.$id.export.tsx (resource route, no component) ─┐
│  authenticate.admin → getAllFindingsForExport                │
│    ownership checked BEFORE completion (anti-enumeration)     │
│  → buildFindingsCsv (pure, engine-side)                       │
│  → new Response(csv, { Content-Disposition: attachment })     │
└──────────────────────┬──────────────────────────────────────┘
                        ▼
┌─ browser ────────────────────────────────────────┐
│  no React component ever mounts for this URL —      │
│  the header alone tells the browser to save the file │
└────────────────────────────────────────────────────┘
```

## Elaborate

This is the standard "server sets the download intent" pattern — the same one a plain `<a href="/download.pdf" download>` uses, just generated dynamically instead of pointing at a static file. It's a better fit than the client-fetch-and-blob approach any time the file can be produced by a single request/response with no client-side post-processing: no progress bar needed for a file this small, no in-browser transformation of the data before saving. The tradeoff it accepts: because it's a real navigation (not a `fetch`), there's no way to show an in-page loading spinner while the CSV is being generated — a slow export (a very large findings set) just leaves the browser's own "loading" affordance as the only feedback, with no custom UI possible during the wait.

`not yet exercised`: streaming the CSV response for very large finding sets (today `buildFindingsCsv` builds the whole string in memory before returning it — fine at the current `catalogVariantLimit` scale, first thing to revisit if that limit grows by an order of magnitude); any client-side progress indicator during generation.

## Interview defense

**Q: How does clicking a plain link trigger a file download instead of navigating to a new page?**
A: The browser doesn't decide that — the server does, via `Content-Disposition: attachment; filename="..."` on the response. Without that header, the exact same CSV bytes would just render as plain text in the tab; with it, the browser saves the response to disk instead of displaying it. No client JavaScript is involved at all.

**Q: Why is ownership checked before the "scan complete" check, rather than the other way around?**
A: To avoid leaking information through the error response. If completion were checked first, a request for another shop's in-progress scan would return a distinct "not complete" 409 — confirming to the requester that the scan exists. Checking ownership first collapses "doesn't exist" and "exists but isn't yours" into the same generic 404, so probing scan IDs teaches an attacker nothing.

**Q: What would you need to change to support exporting a truly massive findings set?**
A: `buildFindingsCsv` currently materializes the entire CSV as one in-memory string before the `Response` is constructed. For a dataset large enough to matter, you'd want to stream it — Remix supports returning a `ReadableStream` as a response body, writing rows incrementally instead of building one giant string first. The resource-route shape (authenticate → authorize → produce a `Response`) wouldn't need to change; only how the body gets produced.

## See also

- `03-remix-loader-action-data-flow.md` — the same loader mechanism, applied here with no component at all.
- `.aipe/study-security/` — the anti-enumeration ordering (ownership before completion) as a trust-boundary concern in its own right.
- `audit.md` → lens 4 (data-fetching and cache).
