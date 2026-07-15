# Encrypted session storage decorator (`EncryptedSessionStorage`)

### Decorator pattern — Industry standard

## Zoom out, then zoom in

```
  Zoom out — where the decorator lives

  ┌─ App layer ───────────────────────────────────────────────┐
  │  every Remix route  →  authenticate.admin(request)          │
  └─────────────────────────┬───────────────────────────────┘
                            │  reads/writes sessions through
  ┌─ Config layer (shopify.server.ts) ─────────────────────────┐
  │  shopifyApp({ sessionStorage: configuredSessionStorage })   │
  │           ★ THIS CONCEPT is chosen here, once ★              │
  └─────────────────────────┬───────────────────────────────┘
                            │  wraps
  ┌─ Storage layer ─────────▼───────────────────────────────────┐
  │  EncryptedSessionStorage  →  PrismaSessionStorage  →  Session│
  │  table (accessToken/refreshToken columns)                    │
  └────────────────────────────────────────────────────────────┘
```

Shopify's offline access tokens have to live somewhere durable
(`PrismaSessionStorage`), but the product spec says they can never sit in
the database in plaintext. `EncryptedSessionStorage` sits between the
Shopify SDK and the real storage, encrypting on the way in and decrypting
on the way out — and nothing else in the app has to know it's there.

## Structure pass

**Axis: who knows the token is encrypted?**

```
  One system, one axis: "does this code know encryption exists?"

  every Remix route            →  NO   (calls authenticate.admin only)
  shopify.server.ts             →  YES  (the one place that decides)
  EncryptedSessionStorage        →  YES  (does the encrypt/decrypt)
  PrismaSessionStorage           →  NO   (stores whatever string it's given)

  the axis flips exactly at the decorator boundary — nowhere else
```

**Seam — the `SessionStorage` interface itself.**
`EncryptedSessionStorage implements SessionStorage`
(`encrypted-session-storage.server.ts:20-24`) and holds an `inner:
SessionStorage` — it could wrap `PrismaSessionStorage` or any other
implementation of that interface without changing a line of its own logic.
This is ports-and-adapters vocabulary applied to a decorator: the **port**
is `SessionStorage`, `PrismaSessionStorage` is the **adapter** actually
touching the database, and `EncryptedSessionStorage` is a second adapter
that happens to hold the first one inside it rather than the database
directly. The **client** (every Remix route, via `authenticate.admin`)
depends only on the port and never sees either adapter.

**The choice of which adapter is live lives in exactly one place:**

```typescript
// app/app/shopify.server.ts:17-23
const prismaSessionStorage = new PrismaSessionStorage(prisma);
const configuredSessionStorage = process.env.SESSION_ENCRYPTION_KEY
  ? new EncryptedSessionStorage(prismaSessionStorage, process.env.SESSION_ENCRYPTION_KEY)
  : prismaSessionStorage;
```
A **factory-shaped conditional** — no class called `Factory`, but the
role is identical: this is the only code in the repo that names both
concrete types, so every other file can depend on `SessionStorage` (the
port) without ever knowing which one it got.

## How it works

### Move 1 — the mental model

You've wrapped a `fetch()` call with a logging layer before — same shape:
the wrapper implements the exact interface the thing it wraps implements,
forwards most calls untouched, and intercepts only the ones it cares
about. Here, four of `SessionStorage`'s methods are pure forwards
(`deleteSession`, `deleteSessions`, lines 63-69) and two are where the
real work happens (`storeSession`, `loadSession`/`findSessionsByShop`).

```
  The kernel — intercept exactly two seams, forward everything else

  storeSession(session)  ──► encrypt tokens ──► inner.storeSession(copy)
  loadSession(id)         ──► inner.loadSession(id) ──► decrypt tokens
  deleteSession(id)       ──► inner.deleteSession(id)         (untouched)
  deleteSessions(ids)     ──► inner.deleteSessions(ids)       (untouched)
```

### Move 2 — the walkthrough

**Encrypting on write — the clone-before-mutate detail is the load-bearing
part.**

```typescript
// app/app/services/session/encrypted-session-storage.server.ts:34-55
async storeSession(session: Session): Promise<boolean> {
  const copy: Session = Object.assign(
    Object.create(Object.getPrototypeOf(session)),
    session,
  );
  if (copy.accessToken) {
    copy.accessToken = encryptToken(copy.accessToken, this.keyHex);
  }
  if (copy.refreshToken) {
    copy.refreshToken = encryptToken(copy.refreshToken, this.keyHex);
  }
  return this.inner.storeSession(copy);
}
```
The comment above this method (lines 35-40) names exactly why it clones
instead of mutating in place: "the caller keeps using `session` in-request
with its plaintext token (e.g. to make an Admin API call right after this
call)." If `storeSession` encrypted `session.accessToken` directly, the
very next line of caller code that tries to use that same session object
to call the Shopify Admin API would send `enc:v1:...` as a bearer token
instead of the real one — a bug that would only show up in production,
under a request that stores then immediately reuses the session, which is
exactly the OAuth callback path. The prototype-preserving
`Object.assign(Object.create(...), session)` clone (not
`toPropertyArray`/`fromPropertyArray`, per the comment) matters too: a
lossy round-trip through that pair "coerces/drops fields such as booleans
and dates" — a plain `{...session}` spread or JSON round-trip would risk
the same loss.

**Decrypting on read, with an explicit backward-compatibility contract.**

```typescript
// app/app/services/session/token-crypto.server.ts:77-83
export function decryptToken(value: string, keyHex: string): string {
  if (!isEncrypted(value)) {
    // Legacy plaintext ... Pass through as-is.
    return value;
  }
  ...
}
```
`decryptToken` checks for the `enc:v1:` marker
(`isEncrypted`, line 46-48) and returns anything without it unchanged.
The doc comment at the top of the file (lines 9-14) states the reason
directly: "the production database already has an existing install whose
offline access token was written before encryption existed... enabling
encryption would make that session unreadable and break the live install."
This is the seam that makes the decorator safe to turn on for an app with
existing users — old plaintext rows keep working, and get encrypted the
next time `storeSession` runs for that session (a lazy migration, not a
backfill script).

**Fail fast on a bad key, at the layer boundary, not deep inside a
request.**

```typescript
// app/app/services/session/encrypted-session-storage.server.ts:25-32
constructor(private readonly inner: SessionStorage, private readonly keyHex: string) {
  assertValidKey(keyHex);
}
```
The comment (lines 25-31) explains the choice: validating in the
constructor means a misconfigured `SESSION_ENCRYPTION_KEY` throws "at
process startup — caught by the Fly health check on deploy — instead of
surfacing much later from deep in the OAuth path on the first
`storeSession`." This is pulling a failure as early as possible in the
request lifecycle — a version of lens 5's "pull complexity downward,"
applied to *when* an error surfaces rather than *where* logic lives.

## Primary diagram

```
  The decorator boundary, end to end

  Remix route                    shopify.server.ts             storage
  ───────────                    ──────────────────             ───────
  authenticate.admin(req) ──────► sessionStorage (the port)
                                        │
                                 SESSION_ENCRYPTION_KEY set?
                                   ┌────┴────┐
                                  yes         no
                                   │           │
                                   ▼           ▼
                         EncryptedSessionStorage   PrismaSessionStorage
                          (encrypts/decrypts)        (plaintext)
                                   │
                                   ▼
                          PrismaSessionStorage ──────► Session table
                          (inner, always Prisma)      (accessToken column:
                                                        enc:v1:... or plain)
```

## Elaborate

The decorator pattern's classic use case is adding a cross-cutting concern
(logging, caching, encryption) to an existing interface without changing
its implementers or its callers. What makes this instance interview-grade
rather than textbook is the backward-compatibility contract: most
tutorial decorators assume a clean slate, but this one had to be safe to
flip on for a database that already had live, unencrypted rows in it. The
generalizable lesson: a decorator that changes a stored format needs an
explicit story for data written before the decorator existed — here,
"detect the marker, pass through unmarked values, re-encrypt lazily on
next write" — or turning it on becomes a migration, not a config change.

## Interview defense

**Q: "What would you lose if you deleted this class and called
`PrismaSessionStorage` directly everywhere?"**
A: Every offline access token and refresh token in the database would
be plaintext — the concrete capability lost is at-rest encryption for the
one thing in this app's database that's actually a live credential
(re-usable to call the Shopify Admin API on the merchant's behalf).
Everything else the app stores (findings, settings) is our own data;
tokens are somebody else's keys.

**Q: "Why does `storeSession` clone the session instead of mutating it?"**
A: Because the caller (Shopify's OAuth flow) keeps using the same
in-memory `session` object right after calling `storeSession`, typically
to make an authenticated call with the just-issued token. Mutate in place
and that next call sends the encrypted string as if it were the real
bearer token.

**Q: "What's the weakest part of this design?"**
A: `SESSION_ENCRYPTION_KEY` must never rotate once tokens are encrypted
with it (documented in `.aipe/project/context.md` → Must-not-change) —
rotating it would make every existing encrypted session undecryptable,
forcing every merchant to reinstall. There's no key-versioning scheme
beyond the `v1` tag in the envelope format
(`token-crypto.server.ts:24-25`), so a future key rotation would need a
new format version and a re-encryption pass, not just a config change.
That's a reasonable place to stop for a first version — but it's the spot
I'd flag before this app scales past its current single-key era.

## See also

- `audit.md` lens 3 (information hiding) — names this as the codebase's
  best-hidden decision.
- `app/app/services/session/token-crypto.server.ts` — the AES-256-GCM
  implementation this decorator calls.
- `test/encrypted-session-storage.test.ts`, `test/token-crypto.test.ts` —
  the coverage for both halves.
