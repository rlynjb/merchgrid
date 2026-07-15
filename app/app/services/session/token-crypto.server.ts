import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-layer encryption for Shopify session tokens (access token,
 * refresh token) so the database never holds them in plaintext.
 *
 * Format: `enc:v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>`
 *
 * `decryptToken` treats any value WITHOUT this prefix as legacy plaintext
 * and returns it unchanged. This is intentional: the production database
 * already has an existing install whose offline access token was written
 * before encryption existed. Without this passthrough, enabling encryption
 * would make that session unreadable and break the live install.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const ENCRYPTED_PREFIX = "enc:v1:";

function keyBufferFromHex(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "Invalid session encryption key: expected 64 hex characters (32 bytes) for AES-256-GCM.",
    );
  }
  return Buffer.from(keyHex, "hex");
}

export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyBufferFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "enc",
    "v1",
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptToken(value: string, keyHex: string): string {
  if (!isEncrypted(value)) {
    // Legacy plaintext (pre-existing sessions written before encryption
    // was enabled, or encryption disabled entirely). Pass through as-is.
    return value;
  }

  // keyHex is validated even for the passthrough-skip case above being
  // bypassed here, so a bad key always surfaces clearly on real use.
  const key = keyBufferFromHex(keyHex);

  const parts = value.split(":");
  if (parts.length !== 5) {
    throw new Error(
      "Malformed encrypted token value: expected 'enc:v1:<iv>:<authTag>:<ciphertext>'.",
    );
  }
  const [, version, ivB64, authTagB64, ciphertextB64] = parts;
  if (version !== "v1") {
    throw new Error(`Unsupported encrypted token version: ${version}`);
  }

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}
