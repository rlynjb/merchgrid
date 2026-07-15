# Software design audit — MerchGrid: Catalog Audit

Applies the design primitives from John Ousterhout's *A Philosophy of
Software Design* to this specific repo: deep modules, information hiding,
complexity, layering, readability — grounded in real files, not abstract
description. Source book, recommended reading if you haven't: *A
Philosophy of Software Design* (Ousterhout). This guide teaches the ideas
in original words and never reproduces the book's prose; the value here is
the findings about this repo's own code.

## The through-line

Complexity is the enemy; deep modules are the weapon. Every finding in
this guide is either "here's a module that hides a real decision behind a
small interface" (praise, and a model to repeat) or "here's a place where
that discipline slipped" (a named fix, not a vague smell). Nothing here is
invented — every claim cites a real file and line range.

## Reading order

1. `00-overview.md` — the five-minute version: complexity hotspots, one
   verdict per primitive, the single highest-leverage fix, what's honestly
   `not yet exercised`.
2. `audit.md` — Pass 1, the full 8-lens walk (complexity, deep vs. shallow
   modules, information hiding, layers, pull-complexity-downward, errors,
   readability, the red-flags capstone).
3. `01-decimal-money-boundary.md` through `05-tenant-safe-error-collapsing.md`
   — Pass 2, five design moves this repo makes deliberately, each walked
   in full with the pattern's shape, the real code side by side, and an
   interview-defense drill.

## Two-pass shape

`audit.md` is fixed-shape — every repo studied with this generator gets
the same eight lenses, walked against that repo's own files. The five
numbered files are this repo's own: a different codebase would earn a
different set of pattern files entirely. The file list itself is a
learning artifact — scanning it (decimal money boundary, scan state
machine, encrypted session decorator, check registry, tenant-safe error
collapsing) tells you what's actually load-bearing in this app before you
open a single file.

## Where this sits relative to sibling guides

- `read-aposd` (not yet generated for this repo) would teach the book's
  primitives in the abstract; this guide applies them here instead —
  cross-reference it once it exists rather than re-deriving the general
  principle from scratch.
- `study-system-design` is the adjacent altitude — service boundaries,
  the three-layer engine/app/deploy split, request flows. This guide stays
  at the module/interface/complexity altitude on purpose; where a finding
  could live in either guide, the rule is altitude: module-level → here,
  service-level → system-design.
- `audit-software-design` is the action-shaped sibling — same eight
  lenses, but it produces refactor specs to act on rather than a teaching
  artifact. Run it when you're ready to fix what this guide found.

## Scope note

This audit covers the engine (`app/packages/catalog-checks`,
`app/packages/catalog-core`) and the scan/session service layers
(`app/app/services/scan/*`, `app/app/services/session/*`,
`app/app/services/shopify/catalog-reader.server.ts`), plus the models and
routes that call into them. It does not re-derive Shopify/Remix/Prisma
framework internals — those are given context, not audited design.
