# 01 — Encrypted session storage at rest

**Envelope encryption / encryption at rest (AES-256-GCM, authenticated encryption).** Industry standard — project-specific implementation (`EncryptedSessionStorage`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Trust boundary — OAuth (shopify.server.ts) ───────────────────────┐
│  afterAuth → sessionStorage.storeSession(session)                   │
└──────────────────────────┬──────────────────────────────────────────┘
                            │
┌─ Service layer — services/session/ ─▼──────────────────────────────┐
│  EncryptedSessionStorage   ★ THIS CONCEPT ★                         │
│  encrypt on write, decrypt on read, AES-256-GCM                     │
└──────────────────────────┬──────────────────────────────────────────┘
                            │
┌─ Storage layer — SQLite (Fly volume, shared with backups/snapshots)─┐
│  Session.accessToken / .refreshToken → ciphertext only               │
└───────────────────────────────────────────────────────────────────────┘
```

Shopify hands this app one offline access token per installed shop. That token is a live credential: whoever holds it can call the Admin GraphQL API as that shop, indefinitely, until the merchant uninstalls. It is the single highest-value secret this app stores anywhere — higher than `SHOPIFY_API_SECRET`, which is one value shared across every install; the access token is per-shop and directly usable. `EncryptedSessionStorage` (`app/app/services/session/encrypted-session-storage.server.ts`) is the control that decides what a copy of the database — a stolen backup, a leaked volume snapshot, a container someone got read access to — actually hands an attacker.

## Structure pass

**Axis: trust — what can someone with raw database access see?** Trace it across the boundary the decorator sits on:

```
Trust flips at the storage-decorator seam

axis traced = "what does raw DB access reveal?"

┌─ above the seam (in-process) ─┐  seam: SessionStorage  ┌─ below (SQLite row) ─┐
│ plaintext access token          │ ═══════╪═════════════► │ ciphertext only        │
│ (needed for live Admin API use) │   (it flips here)       │ enc:v1:iv:tag:cipher   │
└──────────────────────────────────┘                          └────────────────────────┘
```

**Seam:** the `SessionStorage` interface Shopify's SDK expects (`storeSession`/`loadSession`/`deleteSession`/`deleteSessions`/`findSessionsByShop`). `EncryptedSessionStorage` implements that exact interface and wraps `PrismaSessionStorage` rather than replacing it — the SDK, and every caller of `sessionStorage`, never has to know encryption exists. That's also what makes this a genuine security seam and not just an implementation detail: you can unit-test the crypto in total isolation from Prisma (see `app/test/token-crypto.test.ts`), and you could substitute a different at-rest control (KMS-backed envelope keys, a different cipher) without touching `shopify.server.ts` or any route.

**Who is the adversary here, concretely:** not a live network attacker hitting an API endpoint — this control does nothing against someone who has already compromised the running process (they'd see plaintext in memory regardless). The adversary this defends against is *at-rest* access: `fly volumes` snapshots, a misconfigured backup destination, disk-level access to the Fly host, or a copy of the SQLite file taken for debugging and forgotten somewhere. Without this control, any of those hand over a live, usable access token per shop. With it, they hand over ciphertext that's useless without `SESSION_ENCRYPTION_KEY`, which lives only in Fly's secret store — never in the database, never in `fly.toml`, never in git.

## How it works

Think of it like a locked evidence bag around something that still has to be usable the moment it's taken back out. `PrismaSessionStorage` is the drawer where the SDK expects to find the token; `EncryptedSessionStorage` doesn't move the drawer, it seals what goes into it and unseals what comes back out, transparently to everyone who only ever opens the drawer through the one interface.

### The kernel — isolate it

```
Encryption-decorator kernel

  storeSession(session)
       │
  clone session (never mutate the caller's live in-memory object)
       │
  encrypt accessToken + refreshToken  (AES-256-GCM, fresh random IV per write)
       │
  inner.storeSession(encryptedCopy) ──► DB write: ciphertext only

  loadSession(id)
       │
  inner.loadSession(id) ──► DB read: may be ciphertext OR legacy plaintext
       │
  decrypt accessToken + refreshToken  (passthrough if not the enc:v1: envelope)
       │
  return session (plaintext, in-memory only, never re-persisted plaintext)
```

**What breaks if you drop the clone step:** `storeSession`'s caller keeps using the same in-memory `session` object right after this call returns — often to make a live Admin API call with the plaintext token in the very same request. Encrypt in place and that follow-up call authenticates with ciphertext and fails. The fix is a prototype-preserving shallow clone, not a mutation:

```ts
// encrypted-session-storage.server.ts:42-45
const copy: Session = Object.assign(
  Object.create(Object.getPrototypeOf(session)),
  session,
);
```

**What breaks if you drop the per-write random IV:** AES-GCM with a *reused* IV under the same key is a real cryptographic break — an attacker who ever sees two ciphertexts encrypted with the same key+IV can recover the XOR of the two plaintexts, and GCM's authentication guarantee collapses entirely (forgeable tags). `token-crypto.server.ts:60` draws a fresh `randomBytes(IV_LENGTH_BYTES)` (12 bytes, the size GCM is designed for) on every single call to `encryptToken`, so no two writes — even of the identical token — ever share nonce material.

**What breaks if you use plain AES-CBC instead of AES-GCM:** GCM is *authenticated* encryption — `cipher.getAuthTag()` (`token-crypto.server.ts:66`) produces a tag that `decipher.setAuthTag(authTag)` (`token-crypto.server.ts:103`) verifies before returning any plaintext. If the ciphertext or tag has been tampered with (bit-flipped, truncated, spliced from another row), `decipher.final()` throws instead of silently returning corrupted-but-decrypted bytes. A non-authenticated mode gives you confidentiality with no integrity check — an attacker with write access to the DB could flip ciphertext bits and get *some* plaintext back, just wrong. GCM refuses.

```ts
// token-crypto.server.ts:50-75 — encryptToken
export function encryptToken(plaintext: string, keyHex: string): string {
  if (isEncrypted(plaintext)) {
    throw new Error(/* refuse to double-wrap an already-encrypted value */);
  }
  const key = keyBufferFromHex(keyHex);       // validated 32-byte key
  const iv = randomBytes(IV_LENGTH_BYTES);     // fresh 12-byte IV, every call
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();         // GCM integrity tag

  return ["enc", CURRENT_VERSION, iv.toString("base64"),
          authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}
```

**The versioned envelope format is a deliberate trust decision, not decoration.** `enc:v1:<iv>:<authTag>:<ciphertext>` (`token-crypto.server.ts:7`) lets `decryptToken` (`token-crypto.server.ts:77-112`) distinguish three cases at read time: our own encrypted envelope (decrypt normally), an unrecognized-but-`enc:`-prefixed value (fail loudly — `Unsupported encrypted token version` — rather than silently mishandling a future format), or a bare legacy plaintext token with no `enc:` prefix (pass through unchanged). That third case is the accepted risk: it exists because the production database already held a plaintext offline access token from before encryption shipped, and there was no way to retroactively encrypt it without breaking that live install. The tradeoff, owned plainly: legacy plaintext sessions stay readable-as-plaintext-in-the-DB until the next `storeSession` call re-encrypts them (a token refresh or reinstall) — a real gap between "encryption shipped" and "every row is actually encrypted," accepted because the alternative (forcing every existing merchant to reinstall on deploy day) was strictly worse.

**Fail-fast key validation, and why it matters for this specific control.** `assertValidKey` (`token-crypto.server.ts:33-39`) requires exactly 64 hex characters (32 bytes for AES-256) and is called from `EncryptedSessionStorage`'s constructor (`encrypted-session-storage.server.ts:31`) — meaning a misconfigured `SESSION_ENCRYPTION_KEY` throws at process boot, caught by Fly's health check before any traffic is routed, rather than deep inside an OAuth callback the first time a real merchant reinstalls. A security control that fails silently on misconfiguration is worse than no control at all — it gives you false confidence that encryption is active when it never ran.

## Primary diagram

```
Encrypted session storage — full request-to-disk path

┌─ OAuth callback (shopify.server.ts:34-42) ────────────────────────┐
│  afterAuth({ session }) → ensureShop → sessionStorage.storeSession │
└──────────────────────────┬───────────────────────────────────────┬┘
                            │ session (plaintext accessToken)       │ same object,
                            ▼                                       │ used again
┌─ EncryptedSessionStorage.storeSession (line 34) ──────────────────┤ in-request
│  clone session (line 42-45)                                       │ for a live
│  encryptToken(accessToken, keyHex)  ── AES-256-GCM, fresh IV ──────┤ Admin API
│  encryptToken(refreshToken, keyHex) if present                     │ call
└──────────────────────────┬─────────────────────────────────────────┘
                            │ encrypted copy: "enc:v1:<iv>:<tag>:<ct>"
                            ▼
┌─ PrismaSessionStorage (inner) ─────────────────────────────────────┐
│  writes Session.accessToken / .refreshToken as opaque strings       │
└──────────────────────────┬──────────────────────────────────────────┘
                            ▼
┌─ SQLite row on the Fly volume ──────────────────────────────────────┐
│  accessToken = "enc:v1:AbC...==:XyZ...==:9fD...=="  (ciphertext)    │
│  → a stolen backup/snapshot of this row is cryptographically inert  │
│    without SESSION_ENCRYPTION_KEY (Fly secret only, never in DB)    │
└───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Envelope encryption — wrap the payload's own encryption key or ciphertext format around the plaintext so the storage layer only ever sees an opaque blob — is the standard shape for "encrypt sensitive columns without changing what talks to the table." The versioned-prefix trick (`enc:v1:`) is a smaller, common pattern from the same family as content-type sniffing or magic-number file headers: put a self-describing tag on the data so a reader can tell what it's looking at without external metadata. The backward-compatible passthrough here is the same idea applied to a migration problem — a strangler-fig approach to rolling out encryption on an already-populated table, encrypting opportunistically on next-write instead of requiring a blocking backfill migration.

Read `app/test/token-crypto.test.ts` and `app/test/encrypted-session-storage.test.ts` for the edge cases exercised: double-encryption guard, malformed envelope, wrong key length, and the passthrough behavior for legacy plaintext.

## Interview defense

**Q: Why AES-256-GCM specifically, and not AES-CBC with a separate HMAC?**
A: GCM gives you authenticated encryption in one primitive — confidentiality and integrity together, with one call to `getAuthTag()`/`setAuthTag()` instead of composing two separate primitives (encrypt-then-MAC) where the composition itself is a common source of real-world bugs (MAC-then-encrypt vulnerabilities, timing side-channels in manual tag comparison). One correct primitive beats two primitives you have to compose correctly.
```
AES-CBC + separate HMAC          AES-GCM
┌──────────┐  ┌──────────┐      ┌─────────────────┐
│  cipher  │→│   HMAC    │      │ cipher + auth tag │
└──────────┘  └──────────┘      │  (one call)       │
  2 primitives to compose        └─────────────────┘
  correctly, in the right order   1 primitive, order
                                   built in
```

**Q: What's the actual blast radius if `SESSION_ENCRYPTION_KEY` leaks?**
A: Total — anyone with the key and a copy of the `Session` table can decrypt every shop's access token. There is no rotation path (`DEPLOY.md:91-96` documents this as a hard constraint), so remediation is "rotate the key and every merchant reinstalls," not "rotate the key transparently." Naming that as the actual cost, not softening it, is the honest answer.

**Q: Why does `decryptToken` silently pass through non-`enc:`-prefixed values instead of throwing?**
A: Because the production database already had a plaintext session before this control shipped, and throwing there would have broken a live install the moment encryption was turned on. It's a deliberate, temporary trust gap — closed opportunistically on next write, not immediately — and the tradeoff is named in the code comment, not hidden.

## See also

- `02-per-shop-tenant-isolation.md` — the next boundary after the token itself: even with the token decrypted correctly, which shop's rows can this session read?
- `.aipe/study-system-design/04-encrypted-token-at-rest.md` — the same two files from the dependency-injection/decorator-pattern angle rather than the attacker angle.
- `audit.md` → lens 4 (secrets and configuration) and lens 8 (the stale-DEPLOY.md red flag).
