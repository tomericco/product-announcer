import { verify } from "@octokit/webhooks-methods";

export async function verifyGithubSignature(
  payload: string,
  signatureHeader: string | null
): Promise<boolean> {
  if (!signatureHeader) return false;

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is not set");
  }

  return verify(secret, payload, signatureHeader);
}

/**
 * Reads the push time out of a push event's `repository.pushed_at`.
 *
 * GitHub is inconsistent about this field: on push events it's a Unix timestamp
 * in *seconds*, while most other events send an ISO 8601 string. Both are
 * accepted here. Returns null for anything unparseable so the caller can fall
 * back to receipt time rather than storing an Invalid Date.
 */
export function parsePushedAt(value: unknown): Date | null {
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
