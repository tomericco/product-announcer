import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";
import { runBatchForRepo } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";

describe("runBatchForRepo", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Run Batch Test Tenant"));
    vi.mocked(generateObject).mockReset();
  });

  it("creates an Update from the pending batch and marks the items batched", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id,
      repoId: repo.id,
      sourceType: "pr",
      status: "pending",
      prNumber: 1,
      prTitle: "Add dark mode",
    });

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Dark mode", body: "You can now enable dark mode.", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(repo.id);
    await runBatchForRepo(repo.id, tenant.id, pending);

    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(1);
    expect(createdUpdates[0].title).toBe("Dark mode");

    const remainingPending = await getPendingChangeItems(repo.id);
    expect(remainingPending).toHaveLength(0);
  });

  it("does nothing when there are no pending items", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();

    await runBatchForRepo(repo.id, tenant.id, []);

    expect(generateObject).not.toHaveBeenCalled();
    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(0);
  });

  it("leaves items pending (no Update) when generation fails twice", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Run Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id,
      repoId: repo.id,
      sourceType: "pr",
      status: "pending",
      prNumber: 1,
      prTitle: "Flaky",
    });

    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const pending = await getPendingChangeItems(repo.id);
    await runBatchForRepo(repo.id, tenant.id, pending);

    expect(generateObject).toHaveBeenCalledTimes(2); // one retry
    const stillPending = await getPendingChangeItems(repo.id);
    expect(stillPending).toHaveLength(1);
  });
});
