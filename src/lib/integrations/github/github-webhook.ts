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
