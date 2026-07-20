import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

// Read the key per-call rather than at module load: tests swap it between
// cases, and a module-level read would freeze the first value.
function getKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptSecret(parts: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(parts.iv, "hex"));
  decipher.setAuthTag(Buffer.from(parts.authTag, "hex"));
  // GCM verifies the auth tag on final(); tampering throws here rather than
  // returning garbage. Deliberately not caught — a decrypt failure must be loud.
  return Buffer.concat([decipher.update(Buffer.from(parts.ciphertext, "hex")), decipher.final()]).toString("utf8");
}
