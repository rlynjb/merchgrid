# 04 — Encrypted token at rest

**Envelope encryption (AES-256-GCM) via the decorator pattern.** Industry standard pattern — project-specific implementation (`EncryptedSessionStorage`).

## Zoom out, then zoom in

```
Zoom out — where this concept lives

┌─ Service layer — OAuth (shopify.server.ts) ───────────────────┐
│  afterAuth → sessionStorage.storeSession(session)               │
└──────────────────────────┬────────────────────────────────────┘
                            │
┌─ Service layer — session/ ─▼───────────────────────────────────┐
│  EncryptedSessionStorage   ★ THIS CONCEPT ★  ← we are here      │
│  (wraps PrismaSessionStorage; encrypt on write, decrypt on read)│
└──────────────────────────┬────────────────────────────────────┘
                            │
┌─ Storage layer ────────────▼────────────────────────────────────┐
│  SQLite: Session.accessToken / .refreshToken (ciphertext only)   │
└────────────────────────────────────────────────────────────────┘
```

Shopify hands this app an offline access token per shop during OAuth — the single most sensitive value in the whole system, because holding it means being able to read that merchant's catalog indefinitely. `shopify.server.ts` doesn't store it directly; it wraps the storage Shopify's SDK expects with something that encrypts before the write and decrypts after the read, transparently.

## Structure pass

**Axis: trust — what can someone with raw database access see?** Without this layer: anyone with a copy of the SQLite file (a stolen backup, a misconfigured volume snapshot, an insider with filesystem access) has a live, usable Shopify access token for every installed shop. With it: they have ciphertext they can't use without a key that lives only in Fly's secrets, not in the database.

**Seam:** the `SessionStorage` interface itself is the seam — `EncryptedSessionStorage` implements the exact same interface as `PrismaSessionStorage` and wraps it, rather than replacing it. Shopify's SDK, and everything calling `sessionStorage`, never knows encryption is happening at all.

```
Trust flips at the storage-decorator boundary

axis traced = "what does raw DB access reveal?"

┌─ above the decorator ──┐  seam: SessionStorage  ┌─ below (Prisma/SQLite) ─┐
│ plaintext access token   │ ═══════╪═════════════► │ ciphertext only         │
│ (in-request use is fine) │  (it flips)              │ (enc:v1:iv:tag:cipher)  │
└───────────────────────────┘                          └─────────────────────────┘
```

## How it works

Think of a wall socket: anything with the right plug — a lamp, a toaster, a phone charger — works without the socket caring what's plugged in. `PrismaSessionStorage` is the socket Shopify's SDK expects (`storeSession`/`loadSession`/`deleteSession`/…). `EncryptedSessionStorage` doesn't replace the socket; it's an adapter you plug in *between* the SDK and the real socket, transforming the current on the way through.

### The kernel — isolate it

```
Encryption decorator kernel

  storeSession(session)
       │
  clone session (never mutate the caller's live object)
       │
  encrypt accessToken + refreshToken (AES-256-GCM, random IV per write)
       │
  inner.storeSession(encryptedCopy) ──► DB write, ciphertext only

  loadSession(id)
       │
  inner.loadSession(id) ──► DB read, may be ciphertext or legacy plaintext
       │
  decrypt accessToken + refreshToken (passthrough if not our envelope format)
       │
  return session (plaintext, in-memory only)
```

**What breaks if you skipped the clone:** the doc comment names this exactly — the caller of `storeSession` keeps using the same in-memory `session` object right after, often to make an Admin API call with the plaintext token. Encrypt in place and that in-request call would try to authenticate with ciphertext.

```ts
// encrypted-session-storage.server.ts:34-45
async storeSession(session: Session): Promise<boolean> {
  // Clone before mutating: the caller keeps using `session` in-request
  // with its plaintext token (e.g. to make an Admin API call right
  // after this call), so we must never encrypt it in place.
  const copy: Session = Object.assign(
    Object.create(Object.getPrototypeOf(session)),
    session,
  );
  if (copy.accessToken) copy.accessToken = encryptToken(copy.accessToken, this.keyHex);
  if (copy.refreshToken) copy.refreshToken = encryptToken(copy.refreshToken, this.keyHex);
  return this.inner.storeSession(copy);
}
```

Note the clone is a prototype-preserving `Object.assign`, not Shopify's own `toPropertyArray`/`fromPropertyArray` round-trip — the comment explains why: that round-trip "coerces/drops fields such as booleans and dates," which would corrupt the `Session` object for a token swap that's supposed to be invisible to every other caller.

### The envelope format — self-describing ciphertext

`token-crypto.server.ts:1-25` defines the wire format: `enc:v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>`. Every value written carries its own version tag and IV — nothing about decryption depends on external state beyond the key itself.

```ts
// token-crypto.server.ts:50-75
export function encryptToken(plaintext: string, keyHex: string): string {
  if (isEncrypted(plaintext)) {
    throw new Error("encryptToken received an already-encrypted value (double encryption).");
  }
  const key = keyBufferFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH_BYTES);              // fresh IV every call
  const cipher = createCipheriv(ALGORITHM, key, iv);     // aes-256-gcm
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();                   // GCM auth tag: tamper-evidence
  return ["enc", CURRENT_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}
```

**What breaks if the IV were reused across writes:** AES-GCM's security guarantee depends on never reusing an IV with the same key — reuse leaks the XOR of two plaintexts and can break the authentication tag entirely. `randomBytes(IV_LENGTH_BYTES)` generating a fresh 12-byte IV per call is the specific line that guarantee rests on.

### The backward-compatibility passthrough — the load-bearing part most people would skip

```ts
// token-crypto.server.ts:77-83
export function decryptToken(value: string, keyHex: string): string {
  if (!isEncrypted(value)) {
    // Legacy plaintext (pre-existing sessions written before encryption
    // was enabled, or encryption disabled entirely). Pass through as-is.
    return value;
  }
  // ...
}
```

This one `if` is what makes turning encryption *on* for an already-live production database safe. Without it, enabling `SESSION_ENCRYPTION_KEY` on a database that already has plaintext Shopify tokens (`shpat_...`) from before this feature existed would make every existing install's session unreadable the instant decryption ran against it — every merchant would be forced to reinstall. The passthrough means: old rows keep working as plaintext until the next write re-encrypts them, and encryption can be turned on with zero migration step.

### Fail-fast key validation

```ts
// encrypted-session-storage.server.ts:24-32
constructor(private readonly inner: SessionStorage, private readonly keyHex: string) {
  // Validate the key eagerly so a misconfigured SESSION_ENCRYPTION_KEY
  // (wrong length / non-hex) throws at process startup — caught by the
  // Fly health check on deploy — instead of surfacing much later from
  // deep in the OAuth path on the first storeSession...
  assertValidKey(keyHex);
}
```

`assertValidKey` (`token-crypto.server.ts:33-39`) requires exactly 64 hex characters (32 bytes, AES-256). **What breaks without eager validation:** a bad key would pass silently at boot and only surface the first time a real merchant completes OAuth — in production, hours or days after a bad deploy, not at deploy time when Fly's health check would catch it.

## Move 2.5 — current state vs. future state

```
Phase A (SESSION_ENCRYPTION_KEY unset — local dev/tests)      Phase B (production)
──────────────────────────────────────────────────────────    ──────────────────────
plain PrismaSessionStorage, no wrapper                         EncryptedSessionStorage
tokens stored plaintext (fine — not a real merchant's data)     wraps PrismaSessionStorage
                                                                 tokens ciphertext at rest

  what does NOT have to change: the Session table schema, Shopify SDK's
  SessionStorage interface, every caller of `sessionStorage` (shopify.server.ts:59).
```

The constraint from context.md that pins this permanently to Phase B once live: **`SESSION_ENCRYPTION_KEY` must never rotate** once tokens are encrypted with it — rotation would orphan every stored token (they'd become undecryptable) and force every installed merchant to reinstall to get a fresh OAuth token. That's the cost of this design that has no cheap mitigation; it's an accepted, named tradeoff, not an oversight.

## Move 3 — the principle

A decorator that adds a security property (encryption) to an existing interface is only as good as its backward-compatibility story. The interesting engineering here isn't the AES-GCM call — that's a standard library function — it's the passthrough that lets you turn the property on for a system that's already running, with already-existing data, without a migration and without breaking a single live install.

## Primary diagram

```
Full recap — write path and read path

  storeSession(session)                       loadSession(id)
        │                                            │
  clone (never mutate caller's copy)          inner.loadSession(id)
        │                                            │
  encrypt accessToken/refreshToken             decryptInPlace:
  (fresh IV, aes-256-gcm)                        isEncrypted? decrypt : passthrough
        │                                            │
  inner.storeSession(copy) ──► DB                return plaintext session
       (ciphertext only)                          (used in-request only)
```

## Elaborate

This is envelope encryption applied at the application layer rather than relying on disk/volume-level encryption alone — the standard reasoning: disk encryption protects against someone stealing the physical volume, but doesn't protect against someone with legitimate DB read access (a support engineer, a misconfigured backup export, a SQL injection elsewhere in the stack) seeing a live token in plaintext. Application-layer envelope encryption narrows that blast radius to "you also need the key," which lives in Fly secrets, not the database.

`not yet exercised`: key rotation (deliberately never done, per the must-not-change constraint — the design accepts "no rotation" as permanent, not "not yet built"); a KMS-backed key instead of a raw env var (the current key is a 64-hex-char secret set via `fly secrets set`, not pulled from AWS KMS/GCP KMS).

## Interview defense

**Q: Why decrypt on read and re-encrypt on every write instead of encrypting once at rest permanently?**
A: Because the underlying token itself can change (Shopify issues a new offline token on reinstall, or refreshes it) — every `storeSession` call is a fresh write of whatever token Shopify's SDK currently holds, so encryption has to happen at every write, not once.

**Q: What made it safe to turn this on for an already-live production database?**
A: The passthrough in `decryptToken` — any value without the `enc:v1:` prefix is returned unchanged, so pre-existing plaintext sessions keep loading. No migration step, no downtime, no forced reinstall. Existing rows get encrypted lazily, on their next write.

**Q: What's the single constraint this design can never violate?**
A: The key must never rotate once used. Diagram: draw the write path above and note every ciphertext row is only decryptable with the exact key `SESSION_ENCRYPTION_KEY` held at write time — rotate the key and every prior row becomes permanently unreadable, i.e. every merchant loses their stored token and must reinstall.

## See also

- `05-shop-scoped-authorization.md` — the authorization layer that sits above this one (encryption protects the token at rest; authorization controls who can trigger its use).
- `audit.md` → lens 5 (storage/durability boundaries).
