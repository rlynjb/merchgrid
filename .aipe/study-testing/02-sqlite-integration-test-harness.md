# Real-database integration testing (isolated test harness)

### Industry names: integration test / test database isolation / fixture teardown-per-test — Language-agnostic

## Zoom out, then zoom in

```
  Zoom out — where this concept lives

  ┌─ Test process ────────────────────────────────────────────────┐
  │  vitest run                                                     │
  │       │ setupFiles: ["./test/setup.ts"]                          │
  ┌───────▼─────────────────────────────────────────────────────┐  │
  │  ★ test/setup.ts ★  — runs BEFORE any test file imports        │  │ ← we are here
  │  Prisma, points DATABASE_URL at file:./test.sqlite,             │  │
  │  runs migrations, wipes 5 tables before every `it`               │  │
  └───────┬───────────────────────────────────────────────────────┘  │
          │ every app/test/*.test.ts imports the SAME db.server        │
  ┌───────▼─────────────────────────────────────────────────────┐  │
  │  Real Prisma Client → real test.sqlite file (not dev.sqlite)   │  │
  └────────────────────────────────────────────────────────────────┘  │
                                                                       │
  ┌──────────────────────────────────────────────────────────────────┘
  │  app/vitest.config.ts:25  fileParallelism: false — one file at a time,
  │  so no two test files' migrations/writes race on the same DB file.
  └────────────────────────────────────────────────────────────────────
```

Most of this repo's "integration" tests aren't integration tests against a
mock — `scan-runner.test.ts`, `scan-api.test.ts`, `worker-core.test.ts`,
`models.test.ts`, and seven other files all call the real `@prisma/client`
against a real SQLite file on disk. The interesting engineering isn't that
choice itself — it's the two guardrails that make "real DB in every test"
safe instead of a flaky-test generator.

## Structure pass

**Layers:** process env var (`DATABASE_URL`) → migration run → per-test
table wipe → the test body's own `prisma.x.create(...)` calls.

**Axis: who owns the database state, and for how long?** Trace it top to
bottom:

```
  "who owns this row, and until when?"

  process:        DATABASE_URL fixed to test.sqlite         — for the whole run
  file (module):  Prisma migrations applied once             — for the whole run
  beforeEach:      5 domain tables DELETEd                    — for ONE test
  the test body:   creates exactly the rows it needs           — for ONE test
```

Each level owns state for a shorter window than the one above it. That's
the property that makes 132 tests across 15 files safe to run against one
shared file without a single test polluting another.

**Seam:** the `beforeEach` in `test/setup.ts:29-33` is the seam between
"real database, real constraints, real cascade deletes" (worth having, e.g.
to catch a Prisma schema mistake no mock would catch) and "every test
starts from zero" (a property mocks give you for free, and this harness has
to earn manually).

## How it works

### Move 1 — the mental model

You've done this with a real backend and a test suite that hits a real DB
before — the standard move is "wipe the tables before each test so state
never leaks between them." The one thing that's easy to get wrong at that
point is *when* the DB gets pointed at, relative to when the ORM's client
gets constructed — get that ordering wrong and your "test" database is
actually your dev database.

```
  The ordering that makes this safe

  1. set process.env.DATABASE_URL = test.sqlite   ← BEFORE anything imports
  2. run `prisma migrate deploy` against it            @prisma/client
  3. THEN dynamically `await import("@prisma/client")`
  4. beforeEach: DELETE 5 tables
```

### Move 2 — the walkthrough

**Step 1 — the env var is set before any Prisma import, on purpose.**

```typescript
// test/setup.ts:5-8
const testDatabaseUrl = "file:./test.sqlite";
process.env.DATABASE_URL = testDatabaseUrl;
```

The comment right above this line (`test/setup.ts:5-6`) spells out why the
ordering matters: *"Point Prisma at a dedicated test database BEFORE any
module imports `@prisma/client`."* Prisma's generated client reads
`DATABASE_URL` from the environment the moment it's constructed — if any
test file's top-level `import prisma from "../app/db.server"` ran before
this line executed, that client would be wired to whatever `.env` says
(the real dev database). Vitest's `setupFiles` option
(`app/vitest.config.ts:18`) is what guarantees this file runs first, before
any test file's own imports resolve.

**Step 2 — migrations run synchronously, in-process, against that URL.**

```typescript
// test/setup.ts:12-16
execSync("npx prisma migrate deploy", {
  cwd: appRoot,
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdio: "inherit",
});
```

This is a real schema migration, not a hand-rolled `CREATE TABLE`. If the
Prisma schema (`prisma/schema.prisma`) has drifted from the migration
history, this step fails loudly *before any test runs* — a design property
that also happens to keep the test DB's schema honest with production's.

**Step 3 — the Prisma client is imported dynamically, after the env var is
set.**

```typescript
// test/setup.ts:18-19
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
```

A top-level `import` would be hoisted and evaluated before line 8 ever
ran — the dynamic `await import(...)` is what lets this file guarantee the
ordering from Step 1 actually holds.

**Step 4 — every test starts from five empty tables, in dependency order.**

```typescript
// test/setup.ts:21-33
const DOMAIN_TABLES = ["Finding", "ScanArtifact", "Scan", "ShopSettings", "Shop"];

beforeEach(async () => {
  for (const table of DOMAIN_TABLES) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}";`);
  }
});
```

The list order is child-to-parent (`Finding`/`ScanArtifact` before `Scan`
before `ShopSettings`/`Shop`) — matching the foreign-key dependency graph so
the `DELETE`s never violate a constraint mid-wipe. Every test in the app
layer gets a clean slate without a single test file having to remember to
clean up after itself.

**Step 5 — one shared file means concurrent test files must not race.**

```typescript
// app/vitest.config.ts:23-25
// Avoid concurrent `prisma migrate deploy` / sqlite writers racing
// against the same test database file.
fileParallelism: false,
```

SQLite is a single file with file-level locking; Vitest's default is to run
test files in parallel worker processes. Without this line, two test files
racing to migrate or write the same `test.sqlite` file would be exactly the
kind of flakiness lens 4 of `audit.md` looked for and found none of — this
setting is *why* that lens came back clean, not an accident.

### Move 3 — the principle

The generalizable move: when integration tests hit a real, stateful
dependency (a database, in this case) instead of a mock, the engineering
work shifts from "write assertions" to "guarantee isolation" — pointing the
dependency at a dedicated instance before anything else touches it,
resetting state on a boundary smaller than the whole test run, and serializing
whatever can't safely run concurrently. Skipping any one of those three
gets you either cross-test pollution or a suite that occasionally corrupts
its own dev data.

## Primary diagram

```
  The isolation stack, end to end

  ┌─ vitest.config.ts ──────────────────────────────────────────┐
  │ setupFiles: ["./test/setup.ts"]   fileParallelism: false      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ runs first, serialized across files
  ┌─ test/setup.ts (module load, once) ─────────────────────────▼┐
  │ 1. DATABASE_URL = file:./test.sqlite                           │
  │ 2. execSync("prisma migrate deploy")                           │
  │ 3. dynamic import("@prisma/client") → prisma                   │
  └───────────────────────────┬───────────────────────────────────┘
                              │ registers
  ┌─ beforeEach (per test) ────▼──────────────────────────────────┐
  │ DELETE Finding, ScanArtifact, Scan, ShopSettings, Shop          │
  │ (child → parent order, respects FKs)                            │
  └───────────────────────────┬───────────────────────────────────┘
                              │
  ┌─ test body ────────────────▼──────────────────────────────────┐
  │ prisma.shop.create(...) / prisma.scan.create(...) / assertions │
  │ — real constraints, real cascades, zero mocking                │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the "real dependency, disposable instance" school of integration
testing — the alternative being an in-memory fake ORM or a mocked query
builder. The tradeoff bought here: tests catch real schema/constraint bugs
(a cascade-delete misconfiguration, a unique-index violation) that no fake
Prisma client would ever surface, at the cost of every test file needing
Node's `child_process` to shell out to the Prisma CLI once at startup —
slower than an in-memory fake, but the repo only pays that cost once per
test *run*, not once per test. The cost that *is* paid per test is the
five-table `DELETE`, which is cheap relative to what it buys.

A subtlety worth naming: `fileParallelism: false` trades test-suite wall-
clock time for correctness. On a larger test suite this would eventually
become the bottleneck worth revisiting (e.g. by giving each parallel worker
its own SQLite file), but at 132 tests it's the right tradeoff today —
correctness first, and the suite still runs fast enough that reaching for
per-worker database files would be solving a problem this repo doesn't have
yet.

## Interview defense

**Q: Why does the `DATABASE_URL` assignment happen at the very top of
`setup.ts`, before anything else?**
Because Prisma's generated client reads that env var at construction time,
and Vitest's `setupFiles` guarantees this file's top-level code runs before
any test file's own `import prisma from ...` resolves. Get the ordering
backwards and your "test" database silently becomes whatever `.env` points
at — the dev database.

```
  wrong order:  import prisma  →  set DATABASE_URL   (too late, client already wired)
  right order:  set DATABASE_URL  →  import prisma    (test/setup.ts's actual order)
```

**Q: What's `fileParallelism: false` actually protecting against?**
SQLite is one file with file-level locks; Vitest defaults to running test
files across parallel worker processes. Two workers concurrently running
`prisma migrate deploy` or writing to the same `test.sqlite` file is a real
race, and it's exactly the kind of flakiness source lens 4 of the audit
looked for. This setting is why that lens found none.

**Q: Why delete tables in `Finding, ScanArtifact, Scan, ShopSettings, Shop`
order instead of, say, alphabetical?**
Because that's child-to-parent in the foreign-key graph — `Finding` and
`ScanArtifact` reference `Scan`, which references `Shop`/`ShopSettings`.
Deleting in the wrong order would throw a foreign-key constraint violation
on the very first `beforeEach`.

## See also

- `audit.md` lens 4 (determinism, isolation, flakiness) — this file is the
  mechanism behind that lens's clean verdict.
- `03-fake-admin-graphql-seam.md` — the complementary choice: fake the
  external Shopify boundary, but keep the database real.
- `04-tenant-isolation-authz-tests.md` — every test in that file relies on
  this harness's clean-slate guarantee to seed exactly the shops it needs.
