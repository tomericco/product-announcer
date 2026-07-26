import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { verifyNotionSignature, parseVerificationHandshake } from "../../../../src/lib/integrations/notion/notion-webhook";

const TOKEN = "verif-token-abc";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", TOKEN).update(body).digest("hex");
}

describe("notion webhook signature", () => {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = TOKEN;
  });
  afterAll(() => {
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = original;
  });

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionSignature(body + "x", sign(body))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyNotionSignature("{}", null)).toBe(false);
  });

  it("detects a verification handshake payload", () => {
    expect(parseVerificationHandshake(JSON.stringify({ verification_token: "vt-123" }))).toBe("vt-123");
  });

  it("returns null for a normal event payload", () => {
    expect(parseVerificationHandshake(JSON.stringify({ type: "page.properties_updated" }))).toBeNull();
  });
});
