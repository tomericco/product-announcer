import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/review-draft", () => ({ reviewAndReconcile: vi.fn() }));
// Stand in for "something in the auto-publish block blew up after the draft was
// already saved" — the real risk is a DB failure in that window.
vi.mock("../../../src/lib/publishing/dispatch", () => ({
  dispatchAllDestinations: vi.fn(),
}));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, releases, webhookConfigs } from "../../../src/db/schema";
import { runBatchForWorkspace } from "../../../src/lib/scheduling/run-schedule";
import { getPendingChangeItems } from "../../../src/lib/change-events/change-item-batch";
import { reviewAndReconcile } from "../../../src/lib/ai/review-draft";
import { dispatchAllDestinations } from "../../../src/lib/publishing/dispatch";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const NAME = "Auto Publish Failure Test Tenant";

const encryptedSecret = () => {
  const p = encryptSecret("s");
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};

describe("runBatchForWorkspace when auto-publish fails after the draft is saved", () => {
  beforeEach(() => {
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({
      finalDraft: draft,
      status: "passed",
      issues: [],
    }));
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B" },
    } as never);
  });

  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
    vi.mocked(generateObject).mockReset();
    vi.mocked(dispatchAllDestinations).mockReset();
  });

  it("still reports success: the draft exists, so it must not be reported as a failure", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME, autoPublish: true }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    await db.insert(changeEvents).values({
      tenantId: tenant.id, repoId: repo.id, type: "pull_request", provider: "github", externalId: "acme/x#1", status: "pending", prNumber: 1, prTitle: "a",
    });
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    vi.mocked(dispatchAllDestinations).mockRejectedValue(new Error("webhook exploded"));

    const events: DraftProgressEvent[] = [];
    const pending = await getPendingChangeItems(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, pending, db, (e) => events.push(e));

    // The draft was saved before auto-publish ran, so this is a success.
    expect(created).toBe(true);

    // Exactly one terminal event, and it must be `done` — not `error`, which
    // would tell the user the draft failed while it actually exists (and its
    // change items are already consumed, so retrying finds nothing pending).
    const terminal = events.filter((e) => e.type === "done" || e.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("done");

    const rows = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(terminal[0]).toEqual({ type: "done", updateId: rows[0].id });
  });
});
