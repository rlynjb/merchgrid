import type { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import {
  assertValidKey,
  decryptToken,
  encryptToken,
} from "./token-crypto.server";

/**
 * Decorates a `SessionStorage` implementation (in practice, the Prisma
 * session storage) so that `accessToken` / `refreshToken` are encrypted
 * (AES-256-GCM, see token-crypto.server.ts) before they reach the
 * underlying storage, and transparently decrypted on the way back out.
 *
 * Backward compatible by design: `decryptToken` returns any value without
 * the `enc:v1:` marker unchanged, so pre-existing plaintext sessions
 * (written before encryption was enabled) keep loading correctly. They
 * get encrypted the next time they're written via `storeSession`.
 */
export class EncryptedSessionStorage implements SessionStorage {
  constructor(
    private readonly inner: SessionStorage,
    private readonly keyHex: string,
  ) {
    // Validate the key eagerly so a misconfigured SESSION_ENCRYPTION_KEY
    // (wrong length / non-hex) throws at process startup — caught by the
    // Fly health check on deploy — instead of surfacing much later from
    // deep in the OAuth path on the first storeSession (token refresh /
    // reinstall), while legacy plaintext loads would keep working and
    // mask the problem.
    assertValidKey(keyHex);
  }

  async storeSession(session: Session): Promise<boolean> {
    // Clone before mutating: the caller keeps using `session` in-request
    // with its plaintext token (e.g. to make an Admin API call right
    // after this call), so we must never encrypt it in place. A
    // prototype-preserving shallow clone copies every own property
    // (including any the Session class doesn't explicitly enumerate)
    // without the lossy round-trip of toPropertyArray/fromPropertyArray
    // (which coerces/drops fields such as booleans and dates).
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

  async loadSession(id: string): Promise<Session | undefined> {
    const session = await this.inner.loadSession(id);
    if (!session) return undefined;
    return this.decryptInPlace(session);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.inner.deleteSession(id);
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    return this.inner.deleteSessions(ids);
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.inner.findSessionsByShop(shop);
    return sessions.map((session) => this.decryptInPlace(session));
  }

  /**
   * The session objects returned here come freshly built from the DB row
   * by the inner storage on this call, so mutating them in place is safe
   * (no in-request caller holds a reference to them yet).
   */
  private decryptInPlace(session: Session): Session {
    if (session.accessToken) {
      session.accessToken = decryptToken(session.accessToken, this.keyHex);
    }
    if (session.refreshToken) {
      session.refreshToken = decryptToken(session.refreshToken, this.keyHex);
    }
    return session;
  }
}
