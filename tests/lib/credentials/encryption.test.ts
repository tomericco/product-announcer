import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret } from "../../../src/lib/credentials/encryption";

const KEY = "a".repeat(64); // 32 bytes hex

describe("credentials/encryption", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = original;
  });

  it("round-trips a secret", () => {
    const parts = encryptSecret("wf-token-123");
    expect(decryptSecret(parts)).toBe("wf-token-123");
  });

  it("does not store the plaintext in the ciphertext", () => {
    const parts = encryptSecret("wf-token-123");
    expect(parts.ciphertext).not.toContain("wf-token-123");
  });

  it("produces a different iv per call", () => {
    expect(encryptSecret("same").iv).not.toBe(encryptSecret("same").iv);
  });

  it("throws when the ciphertext has been tampered with", () => {
    const parts = encryptSecret("wf-token-123");
    const flipped = parts.ciphertext.startsWith("a") ? "b" : "a";
    const tampered = { ...parts, ciphertext: flipped + parts.ciphertext.slice(1) };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("throws when the key is not 32 bytes", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "abcd";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
