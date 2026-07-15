import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  isEncrypted,
} from "../app/services/session/token-crypto.server";

const KEY = "a".repeat(64); // 32 bytes hex
const OTHER_KEY = "b".repeat(64);

describe("token-crypto", () => {
  it("round-trips a plaintext token through encrypt then decrypt", () => {
    const plaintext = "shpat_abc123super-secret-token";
    const encrypted = encryptToken(plaintext, KEY);
    expect(decryptToken(encrypted, KEY)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext (random IV), but both decrypt correctly", () => {
    const plaintext = "shpat_same-token-twice";
    const encryptedA = encryptToken(plaintext, KEY);
    const encryptedB = encryptToken(plaintext, KEY);

    expect(encryptedA).not.toBe(encryptedB);
    expect(decryptToken(encryptedA, KEY)).toBe(plaintext);
    expect(decryptToken(encryptedB, KEY)).toBe(plaintext);
  });

  it("returns legacy plaintext unchanged when it has no encryption marker", () => {
    const legacyPlaintext = "shpat_legacy-plaintext-token-in-db";
    expect(decryptToken(legacyPlaintext, KEY)).toBe(legacyPlaintext);
  });

  it("identifies encrypted vs plaintext values via isEncrypted", () => {
    const encrypted = encryptToken("some-token", KEY);
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted("shpat_plain")).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });

  it("throws when the ciphertext or auth tag has been tampered with", () => {
    const encrypted = encryptToken("shpat_tamper-me", KEY);
    const parts = encrypted.split(":");
    // parts: ["enc", "v1", ivB64, authTagB64, ciphertextB64]
    const tamperedCiphertextB64 = Buffer.from("tamperedtamperedtampered").toString(
      "base64",
    );
    const tampered = [
      parts[0],
      parts[1],
      parts[2],
      parts[3],
      tamperedCiphertextB64,
    ].join(":");

    expect(() => decryptToken(tampered, KEY)).toThrow();
  });

  it("throws when decrypting with the wrong key", () => {
    const encrypted = encryptToken("shpat_wrong-key-test", KEY);
    expect(() => decryptToken(encrypted, OTHER_KEY)).toThrow();
  });

  it("throws when an encrypted value has the wrong number of parts", () => {
    expect(() => decryptToken("enc:v1:onlytwoparts", KEY)).toThrow(/malformed/i);
  });

  it("throws on an unknown encrypted format version", () => {
    expect(() => decryptToken("enc:v2:a:b:c", KEY)).toThrow(/version/i);
  });

  it("throws when asked to encrypt an already-encrypted value", () => {
    const encrypted = encryptToken("shpat_no-double-wrap", KEY);
    expect(() => encryptToken(encrypted, KEY)).toThrow(/double encryption/i);
  });

  it("throws a clear error when the key is not 64 hex chars", () => {
    expect(() => encryptToken("token", "tooshort")).toThrow(/64 hex/i);
    expect(() => encryptToken("token", "z".repeat(64))).toThrow(/64 hex/i); // not valid hex
    expect(() => decryptToken(encryptToken("token", KEY), "tooshort")).toThrow(
      /64 hex/i,
    );
  });
});
