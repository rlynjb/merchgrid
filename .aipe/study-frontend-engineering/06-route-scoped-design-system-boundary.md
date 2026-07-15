# 06 — Route-scoped design-system boundary

**Design-system boundary drawn at the route level (no mixing of styling systems within one route).** Project-specific pattern, built from two industry-standard building blocks — a component design system (Shopify Polaris) and CSS Modules — kept deliberately non-overlapping.

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Browser ────────────────────────────────────────────────────┐
│  pre-auth: _index/route.tsx  →  styles.module.css               │
│  embedded: app.tsx + children →  Polaris components + tokens     │
│  ★ THIS CONCEPT ★ — the split between them  ← we are here        │
└──────────────────────────┬──────────────────────────────────┘
                            │  which stylesheet loads
┌─ Remix route tree ─────────▼──────────────────────────────────┐
│  app.tsx links polarisStyles; _index/route.tsx imports its own  │
│  CSS Module — neither route imports the other's stylesheet      │
└────────────────────────────────────────────────────────────────┘
```

You've drawn a line before between "pages that live inside someone else's product chrome" (a Slack app panel, a browser extension popup, an iframe widget) and "pages that are entirely your own" (a marketing page, a public login screen) — and you already know those two contexts usually want different styling approaches. This repo draws exactly that line, and draws it at the route boundary, not inside a shared component.

## Structure pass

**Axis: trust/context — whose visual chrome does this route have to match?** Every route nested under `app.tsx` renders *inside* Shopify's own admin iframe, next to Shopify's own UI — it has to look and behave like it belongs there. The one route outside that layout (`_index/route.tsx`, the pre-auth entry point) renders as its own standalone page, answerable to nobody's design system but its own.

**Seam:** the `app.tsx` layout boundary itself. Everything nested under it links Polaris's stylesheet and uses only Polaris components; the one route outside it does neither. No route ever imports both.

```
The seam — which context, which styling system

axis traced = "whose visual chrome does this route answer to?"

┌─ inside app.tsx layout ──┐  seam: app.tsx (layout boundary)  ┌─ outside it: _index ──┐
│ Shopify admin's iframe     │ ══════════╪═══════════════════════► │ standalone page,       │
│ → Polaris, wholesale        │   (it flips)                       │ own CSS Module          │
└──────────────────────────────┘                                  └─────────────────────────┘
```

## How it works

You've picked between "use the design system the platform gives you" and "roll your own CSS" before — think of building inside a Chrome extension's options page (where a native look matters) versus building your own marketing site (where nothing constrains you). This repo isn't choosing one system for the whole app; it's choosing per route, based on which context that specific route lives in.

**The kernel: one stylesheet import at the layout, one CSS Module import at the one route outside it, and a redirect that makes sure you never see both.**

```
Styling-boundary kernel

  app.tsx  (layout)
    links: polarisStyles  ← @shopify/polaris/build/esm/styles.css
    every child route: Polaris components only, no raw CSS

  _index/route.tsx  (NOT nested under app.tsx)
    imports: styles.module.css  ← scoped, hashed class names
    plain <div>/<h1>/<form> — zero Polaris imports

  the redirect that keeps them from ever mixing:
    _index/route.tsx loader: if ?shop= present → redirect to /app
    (the admin-chrome route never gets rendered without going through
     the OAuth flow first, and the pre-auth route is bypassed entirely
     once a shop is known)
```

### The embedded side — Polaris, linked once, used everywhere under it

`app.tsx:6,10`:

```ts
// app.tsx:6,10
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
export const links = () => [{ rel: "stylesheet", href: polarisStyles }];
```

One `links()` export, at the layout that every embedded route nests under (`app._index.tsx`, `app.scans.$id.tsx`, `app.settings.tsx` all render inside `app.tsx`'s `<Outlet />`, `app.tsx:29`). None of those three route files imports any CSS of its own — every visual property (spacing via `gap="400"`, typography via `variant="headingLg"`, color via `tone="critical"`) comes from a Polaris component prop, never a class name or inline style. **What breaks if a route under this layout reached for a raw `style={{ margin: '8px' }}` instead of a Polaris `gap` prop:** it would still render, but it would silently drift from Polaris's own spacing scale the moment that scale changes version-to-version, and — more concretely — it would look visibly inconsistent sitting next to Shopify's own admin chrome, which is styled entirely by that same token scale. The discipline here isn't enforced by a linter; it's enforced by the fact that every component available in these three files (`Card`, `Text`, `BlockStack`, `IndexTable`, …) *is* a Polaris component, so there's rarely a raw HTML element to reach for in the first place.

### The pre-auth side — plain CSS Modules, scoped, no Polaris in sight

`_index/route.tsx:7,23-24` imports `styles.module.css` and applies it via `className={styles.index}` — ordinary CSS Modules, hashed class names, zero design-system dependency:

```css
/* _index/styles.module.css:1-9 */
.index {
  align-items: center;
  display: flex;
  justify-content: center;
  height: 100%;
  width: 100%;
  text-align: center;
  padding: 1rem;
}
```

This route never renders inside Shopify's admin iframe — it's the page a browser hits *before* OAuth has happened, when there's no admin chrome to match yet. There's no App Bridge, no `TitleBar`, no `NavMenu` here at all; pulling in Polaris's stylesheet for this one route would cost real bundle weight for zero visual benefit, since nothing about this page needs to resemble Shopify admin.

### The redirect that prevents the two from ever colliding

`_index/route.tsx:9-17`:

```ts
// _index/route.tsx:11-14
if (url.searchParams.get("shop")) {
  throw redirect(`/app?${url.searchParams.toString()}`);
}
```

The instant a `shop` param is present — meaning Shopify itself launched this URL, mid-install or mid-session — this route redirects straight into the embedded, Polaris-styled tree and never renders its own CSS-Module markup at all. **What this redirect actually protects:** without it, a merchant who somehow landed on `/` with a `shop` param (a stale bookmark, a misconfigured link) would see the un-styled placeholder scaffold page instead of the actual app — a broken-looking dead end rather than a redirect into the real product.

## Move 3 — the principle

Two styling systems can coexist in one codebase without ever fighting each other, as long as the boundary between them is drawn at a real structural seam (here, the layout route) rather than left to be a matter of component-by-component discipline. The moment a boundary like this gets fuzzy — a Polaris route reaching for a stray CSS Module class, or the pre-auth page importing one Polaris component "just for this one button" — you lose the property that made the split safe in the first place: that each route's visual language is fully predictable from which side of the boundary it's on.

## Primary diagram

```
Full recap — two styling systems, one seam

┌─ pre-auth: _index/route.tsx ───────────────────────────┐
│  no shop param → renders plain HTML + styles.module.css   │
│  shop param present → redirect(/app?...) — never renders   │
│  zero Polaris imports                                       │
└──────────────────────────────────────────────────────────┘

┌─ app.tsx (layout, links polarisStyles once) ───────────────┐
│  AppProvider isEmbeddedApp + NavMenu + Outlet                 │
│    ├─ app._index.tsx    — Polaris only, no CSS Module          │
│    ├─ app.scans.$id.tsx — Polaris only, no CSS Module          │
│    └─ app.settings.tsx  — Polaris only, no CSS Module          │
└────────────────────────────────────────────────────────────────┘

  no file in this repo imports both a CSS Module and Polaris
```

## Elaborate

This is the same call any embedded/platform-hosted app has to make — Slack app panels, VS Code extension webviews, Shopify apps generally — where "match the host platform's chrome" is close to mandatory for anything the user perceives as part of the host, and irrelevant for anything that isn't. Polaris exists specifically so Shopify apps don't have to hand-build that consistency; the cost accepted in exchange is zero customization surface (`audit.md` lens 8, finding 5) — there's no mechanism in this repo today to apply a brand accent or a dark variant inside the embedded routes, because every visual decision there is Polaris's default theme, by design.

`not yet exercised`: Polaris theming overrides (Polaris does support them), any shared visual layer that spans both the pre-auth and embedded routes (there currently is none — the two are visually unrelated on purpose), and dark mode in either context.

## Interview defense

**Q: Why does the pre-auth route use hand-rolled CSS instead of Polaris, when the rest of the app is fully Polaris?**
A: Because it doesn't render inside Shopify's admin iframe — it's the page a browser hits *before* OAuth, with no admin chrome to match. Pulling in Polaris's full stylesheet there would add bundle weight for a page that has no design-system constraint to satisfy; a small hand-rolled CSS Module is the appropriately-sized tool for a page that owns its own look entirely.

**Q: What actually prevents the two styling systems from ending up mixed on the same page?**
A: A real structural boundary, not just convention — the pre-auth route redirects into the Polaris-styled tree the instant it detects a `shop` param (`_index/route.tsx:11-14`), so it never renders its own markup once Shopify context exists; and every route nested under `app.tsx`'s layout only has Polaris components available to reach for, since that's the only stylesheet linked there.

**Q: What's the actual cost of standardizing this hard on Polaris?**
A: Zero customization surface today — if a brand requirement ever demanded a different accent color or a dark variant inside the embedded routes, there's no theming hook wired up yet; it would need to be built (Polaris does support theme overrides), not just flipped on. That's a reasonable gap for an admin tool that's supposed to look like Shopify admin, not a product with its own brand identity.

## See also

- `audit.md` → lens 6 (styling and design system), lens 8 finding 5.
- `.aipe/study-performance-engineering/` — the bundle-weight cost of linking Polaris's stylesheet, measured as a number.
