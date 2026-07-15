# syntax note: this image runs as a SINGLE Fly.io machine that serves BOTH
# the Remix web app and the catalog-audit background worker (see
# start-production.js and fly.toml). There is no separate worker image.
FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies first so this layer is cached across source-only
# changes. `npm ci --omit=dev` still ends up installing the build tooling
# (vite, typescript, esbuild) this project needs for `npm run build`,
# because @remix-run/dev is a runtime `dependency` and vite/typescript are
# its (optional) peerDependencies — npm's lockfile-driven install pulls
# those in on the production tree regardless of --omit=dev. This has been
# verified locally against this repo's package-lock.json.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Now bring in the rest of the source (workspace packages, prisma schema
# and migrations, app code, worker.ts). The @merchgrid/* symlinks npm ci
# created above point at ./packages/*, which only now start resolving to
# real files.
COPY . .

# Generate the Prisma client during the image build (needs prisma/schema.prisma,
# not a live database connection). `prisma migrate deploy` is deliberately
# NOT run here — this build stage has no volume attached, so any migration
# applied now would not persist. Migrations run at container start instead,
# on the one machine that has /data mounted (see start-production.js).
RUN npx prisma generate

# Builds, in order: the @merchgrid/catalog-checks (+ catalog-core, via
# project references) workspace packages, the Remix client+server bundles,
# and an esbuild bundle of worker.ts to build/worker.js (the worker runs
# compiled in production — no `tsx`/ts-node at runtime).
RUN npm run build

# The SQLite database lives on a Fly volume mounted at /data at runtime
# (see `[mounts]` in fly.toml and `DATABASE_URL` in `[env]`) — never bake a
# database file into the image. Deliberately no Dockerfile `VOLUME`
# instruction here: Fly's `[mounts]` block is what actually attaches the
# volume to /data on the running machine, and a plain-Docker VOLUME
# declaration on top of that is redundant.

# Single entrypoint/supervisor: runs `prisma migrate deploy`, then starts
# the web server and the worker as sibling processes on this one machine.
# If either process dies, the supervisor exits non-zero so Fly restarts
# the whole machine. Do NOT replace this with Fly's `[processes]` block —
# that would split web/worker across separate machines that can't share
# this machine's SQLite volume.
CMD ["npm", "run", "start:production"]
