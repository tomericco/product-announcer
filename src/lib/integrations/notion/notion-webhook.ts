import { createHmac, timingSafeEqual } from "node:crypto";

// NOTE: Task 0 must confirm the real X-Notion-Signature format against a live
// delivery. This implements the documented scheme: HMAC-SHA256 of the raw body
// keyed by the verification token, header value "sha256=<hex>". If Task 0 finds
// the header is bare hex (no "sha256=" prefix), drop the prefix handling below.
export function verifyNotionSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const token = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  if (!token) throw new Error("NOTION_WEBHOOK_VERIFICATION_TOKEN is not set");

  const expected = "sha256=" + createHmac("sha256", token).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return timingSafeEqual(a, b);
}

export function parseVerificationHandshake(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { verification_token?: unknown };
    return typeof parsed.verification_token === "string" ? parsed.verification_token : null;
  } catch {
    return null;
  }
}
