import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sign } from "@octokit/webhooks-methods";
import { verifyGithubSignature } from "../../src/lib/github-webhook";

describe("verifyGithubSignature", () => {
  const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";
  });

  afterAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
  });

  it("accepts a correctly signed payload", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const signature = await sign("test-webhook-secret", payload);

    expect(await verifyGithubSignature(payload, signature)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", async () => {
    const payload = JSON.stringify({ hello: "world" });
    const signature = await sign("wrong-secret", payload);

    expect(await verifyGithubSignature(payload, signature)).toBe(false);
  });

  it("rejects a missing signature header", async () => {
    const payload = JSON.stringify({ hello: "world" });

    expect(await verifyGithubSignature(payload, null)).toBe(false);
  });
});
