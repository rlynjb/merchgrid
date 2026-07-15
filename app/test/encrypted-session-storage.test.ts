import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { beforeEach, describe, expect, it } from "vitest";
import { EncryptedSessionStorage } from "../app/services/session/encrypted-session-storage.server";
import { isEncrypted } from "../app/services/session/token-crypto.server";

const KEY = "c".repeat(64);

/** In-memory fake standing in for PrismaSessionStorage. */
class FakeInnerStorage implements SessionStorage {
  public sessions = new Map<string, Session>();

  async storeSession(session: Session): Promise<boolean> {
    this.sessions.set(session.id, session);
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async deleteSession(id: string): Promise<boolean> {
    this.sessions.delete(id);
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    for (const id of ids) this.sessions.delete(id);
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) => s.shop === shop);
  }
}

function makeSession(overrides: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  return new Session({
    id: "offline_test-shop.myshopify.com",
    shop: "test-shop.myshopify.com",
    state: "state123",
    isOnline: false,
    accessToken: "shpat_plaintext-access-token",
    ...overrides,
  });
}

describe("EncryptedSessionStorage", () => {
  let inner: FakeInnerStorage;
  let storage: EncryptedSessionStorage;

  beforeEach(() => {
    inner = new FakeInnerStorage();
    storage = new EncryptedSessionStorage(inner, KEY);
  });

  it("throws at construction when the key is malformed (fail fast at startup)", () => {
    expect(() => new EncryptedSessionStorage(inner, "tooshort")).toThrow(
      /64 hex/i,
    );
  });

  it("stores an encrypted accessToken in the inner storage", async () => {
    const session = makeSession();
    await storage.storeSession(session);

    const stored = inner.sessions.get(session.id)!;
    expect(isEncrypted(stored.accessToken!)).toBe(true);
  });

  it("does not mutate the caller's session object (still plaintext after store)", async () => {
    const session = makeSession();
    await storage.storeSession(session);

    expect(session.accessToken).toBe("shpat_plaintext-access-token");
  });

  it("loadSession returns a session with the accessToken decrypted back to plaintext", async () => {
    const session = makeSession();
    await storage.storeSession(session);

    const loaded = await storage.loadSession(session.id);
    expect(loaded).toBeDefined();
    expect(loaded!.accessToken).toBe("shpat_plaintext-access-token");
  });

  it("loads a legacy plaintext session (written before encryption existed) unchanged", async () => {
    const legacySession = makeSession({
      id: "legacy-session",
      accessToken: "shpat_legacy-unencrypted-token",
    });
    // Directly seed the inner store, bypassing our storeSession, to
    // simulate a pre-existing row from before encryption was enabled.
    await inner.storeSession(legacySession);

    const loaded = await storage.loadSession("legacy-session");
    expect(loaded).toBeDefined();
    expect(loaded!.accessToken).toBe("shpat_legacy-unencrypted-token");
  });

  it("returns undefined from loadSession when the inner storage has nothing", async () => {
    const loaded = await storage.loadSession("does-not-exist");
    expect(loaded).toBeUndefined();
  });

  it("encrypts and decrypts refreshToken when present", async () => {
    const session = makeSession({
      id: "with-refresh",
      refreshToken: "shrt_plaintext-refresh-token",
    });
    await storage.storeSession(session);

    const stored = inner.sessions.get(session.id)!;
    expect(isEncrypted(stored.refreshToken!)).toBe(true);
    expect(session.refreshToken).toBe("shrt_plaintext-refresh-token"); // caller's copy untouched

    const loaded = await storage.loadSession("with-refresh");
    expect(loaded!.refreshToken).toBe("shrt_plaintext-refresh-token");
  });

  it("skips refreshToken handling when it is absent", async () => {
    const session = makeSession({ id: "no-refresh" });
    expect(session.refreshToken).toBeUndefined();

    await storage.storeSession(session);
    const loaded = await storage.loadSession("no-refresh");
    expect(loaded!.refreshToken).toBeUndefined();
  });

  it("findSessionsByShop decrypts tokens for all matching sessions", async () => {
    const a = makeSession({ id: "a", shop: "shop-a.myshopify.com" });
    const b = makeSession({
      id: "b",
      shop: "shop-a.myshopify.com",
      accessToken: "shpat_second-token",
    });
    await storage.storeSession(a);
    await storage.storeSession(b);

    const results = await storage.findSessionsByShop("shop-a.myshopify.com");
    expect(results).toHaveLength(2);
    const tokens = results.map((s) => s.accessToken).sort();
    expect(tokens).toEqual(
      ["shpat_plaintext-access-token", "shpat_second-token"].sort(),
    );
  });

  it("delegates deleteSession and deleteSessions unchanged", async () => {
    const session = makeSession();
    await storage.storeSession(session);

    expect(await storage.deleteSession(session.id)).toBe(true);
    expect(inner.sessions.has(session.id)).toBe(false);

    const s2 = makeSession({ id: "s2" });
    const s3 = makeSession({ id: "s3" });
    await storage.storeSession(s2);
    await storage.storeSession(s3);
    expect(await storage.deleteSessions(["s2", "s3"])).toBe(true);
    expect(inner.sessions.size).toBe(0);
  });
});
