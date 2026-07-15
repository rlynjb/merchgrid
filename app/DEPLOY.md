# Deploying MerchGrid: Catalog Audit to Fly.io

This is a runbook for a **single always-on Fly.io machine** that runs both
the Remix web app and the catalog-audit background worker, backed by a
SQLite database on a Fly volume. There is no separate worker machine, no
Postgres, and no Fly `release_command` — migrations run at container boot
on the same machine that has the volume attached (see `start-production.js`
and the comments in `fly.toml`).

Follow these steps in order. Run all `fly` commands from the `app/`
directory unless noted otherwise.

## 0. Prerequisites

1. Create a Fly.io account at https://fly.io if you don't have one.
2. Install `flyctl`: https://fly.io/docs/flyctl/install/
3. Authenticate:
   ```
   fly auth login
   ```

## 1. Get Shopify API credentials

1. Go to the [Shopify Partner Dashboard](https://partners.shopify.com/) →
   your organization → **Apps** → **merchgrid-catalog-audit** (the app
   whose `client_id` is in `shopify.app.toml`).
2. Open **App setup** / **Client credentials** and copy:
   - **Client ID** → this is `SHOPIFY_API_KEY`
   - **Client secret** → this is `SHOPIFY_API_SECRET`

Keep these handy for step 4 below. Do not commit them anywhere.

## 2. Create the Fly app (no deploy yet)

From `app/`, since `fly.toml` already exists in this repo:

```
fly apps create merchgrid-catalog-audit
```

(If that name is taken, either rename the `app = "..."` line in `fly.toml`
to something unique, or ask Fly to pick a name and update `fly.toml` to
match.)

Then uncomment and set `primary_region` in `fly.toml` to a region near you
or your dev store, e.g.:

```toml
primary_region = "iad"
```

(See `fly platform regions` for the list of valid codes.)

## 3. Create the volume

The SQLite database lives on a persistent volume mounted at `/data`
(`DATABASE_URL = "file:/data/prod.sqlite"` is already set in `fly.toml`).
Create the volume **in the same region** you set above:

```
fly volumes create data --size 1 --region <region>
```

1 GB is a reasonable starting size for SQLite; you can grow it later
with `fly volumes extend` if needed. Do not skip this — without it,
`fly deploy` will still start a machine, but nothing will persist across
restarts and the app will effectively be writing to ephemeral storage.

## 4. Set secrets

Set everything that must not live in `fly.toml` (which is committed to
git) as a Fly secret instead:

```
fly secrets set \
  SHOPIFY_API_KEY="<client id from step 1>" \
  SHOPIFY_API_SECRET="<client secret from step 1>" \
  SCOPES="read_products,read_inventory" \
  SHOPIFY_APP_URL="https://merchgrid-catalog-audit.fly.dev" \
  SESSION_SECRET="$(openssl rand -hex 32)"
```

Replace `merchgrid-catalog-audit.fly.dev` with your actual `<app>.fly.dev`
hostname if you renamed the app in step 2 (or set up a custom domain
later). Do **not** also set `DATABASE_URL` as a secret — it's already in
`fly.toml`'s `[env]` block, and setting it again as a secret would just be
redundant (secrets don't override `[env]` in a meaningful way here; keep
the DB path in one place).

## 5. Point Shopify at the production URL

Update `app/shopify.app.toml` in this repo:

```toml
application_url = "https://merchgrid-catalog-audit.fly.dev"

[auth]
redirect_urls = [ "https://merchgrid-catalog-audit.fly.dev/api/auth" ]
```

(Match whatever hostname you actually used in step 4.) Then push these
URLs — and the webhook subscriptions already declared in
`shopify.app.toml` — to Shopify's servers:

```
cd app && shopify app deploy
```

This is a **Shopify CLI** deploy (updates app config/URLs/webhooks on
Shopify's side); it is separate from `fly deploy` in the next step, which
ships the actual container.

## 6. Deploy

```
fly deploy
```

This builds the image from `app/Dockerfile`, which:
- installs dependencies and runs `npm run build` (builds the workspace
  packages, the Remix client/server bundles, and `build/worker.js`, an
  esbuild bundle of `worker.ts`),
- runs `prisma generate` at build time,
- and on container start runs `npm run start:production`, which applies
  `prisma migrate deploy` against `/data/prod.sqlite` and then starts the
  web server and the worker as sibling processes.

Watch it come up:

```
fly logs
fly status
```

You should see, in order: `prisma migrate deploy` output (migrations
applying against `/data/prod.sqlite`), `[supervisor] starting web: ...`,
`[supervisor] starting worker: ...`, `[worker] scan worker starting`, and
`remix-serve` printing its listening URL. The `/healthz` route
(`fly.toml`'s `[[http_service.checks]]`) should go green in `fly status`.

## 7. Install and verify end-to-end

1. Install the app on your development store using the production URL
   (via the Partner Dashboard, or the install link Shopify CLI printed
   after `shopify app deploy`).
2. Open the app, trigger a catalog scan.
3. Watch `fly logs` — you should see the worker's poll loop pick the scan
   up (`claimAndRunNext` running it) and the scan complete in the UI.
   Because this is a single machine, the same machine that served the HTTP
   request also ran the worker that processed the scan — there is no
   separate worker process/machine to check.

## Known caveats to carry forward

- **SQLite-on-a-volume durability is single-node.** There's no
  replication — if the volume is lost, the data is lost. Fly volumes do
  have their own snapshot mechanism, but for real backup/restore
  guarantees, consider adding
  [Litestream](https://litestream.io/) (continuous SQLite replication to
  object storage) as a later hardening step. Not implemented here.
- **Shopify access tokens are stored unencrypted at the application
  layer.** The `Session` table (via `PrismaSessionStorage`) holds each
  shop's offline access token in plain text in the SQLite file. Fly
  volumes are encrypted at rest at the infrastructure layer, which covers
  "someone steals the physical disk," but does not cover
  "someone gets read access to the running container or a volume
  snapshot." Encrypting tokens at the application layer (e.g. envelope
  encryption before writing to `Session.accessToken`) is a real future
  hardening item — intentionally not implemented in this change.
- **`app/shopify.server.ts` has a pre-existing `tsc --noEmit` error**
  (a `PrismaSessionStorage` / `SessionStorage` type mismatch between two
  different nested copies of `@shopify/shopify-api` pulled in by
  `@shopify/shopify-app-session-storage-prisma` vs
  `@shopify/shopify-app-remix`). This is a type-only mismatch — it does
  not affect `remix vite:build`, the compiled JS output, or runtime
  behavior, and was already present before this deploy work. It's called
  out here so it isn't mistaken for something this change broke.
- **This Dockerfile/fly.toml have not been run through an actual
  `docker build` or `fly deploy`** in the environment this change was
  prepared in (no Docker daemon, no Fly account/CLI available here). Only
  local, non-container checks were possible — see the accompanying report
  for exactly what was and wasn't verified. Your first `fly deploy` is the
  first real test of: the Docker image actually building on Fly's
  builders, the volume mounting at `/data`, `prisma migrate deploy`
  succeeding against a fresh SQLite file at boot, and the worker staying
  up alongside the web server on the shared machine.
