// Shared AES-256-GCM helpers for the connector module (token vault +
// org-level config store). Everything encrypts under the same key:
// BRAIN_CONNECTOR_TOKEN_KEY (base64 of 32 bytes), read from env and held
// OUTSIDE the database — a leaked DB row is useless on its own.
//
// These helpers are private to src/connectors/ — deliberately NOT re-exported
// from index.ts, so nothing outside the module can touch the key or raw
// ciphertext plumbing.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

export function vaultKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const b64 = env.BRAIN_CONNECTOR_TOKEN_KEY;
  if (!b64) {
    throw new Error("BRAIN_CONNECTOR_TOKEN_KEY is not set — the connector vault is unavailable.");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("BRAIN_CONNECTOR_TOKEN_KEY must be base64 of exactly 32 bytes (AES-256).");
  }
  return key;
}

interface Encrypted {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
}

// The full 128-bit GCM tag is required — reject a truncated (weaker) tag.
const AUTH_TAG_LENGTH = 16;

// `aad` binds a ciphertext to its logical slot (e.g. "connector_secrets:acct:msgraph").
// GCM verifies it on decrypt, so a row's blob spliced into a DIFFERENT row or
// table fails authentication instead of decrypting cleanly — closes the
// DB-writer splice/confused-blob gap. Callers pass a stable context string.
export function encrypt(key: Buffer, plaintext: string, aad: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(
  key: Buffer,
  ciphertext: string,
  iv: string,
  authTag: string,
  aad: string,
): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"), {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return pt.toString("utf8");
}
