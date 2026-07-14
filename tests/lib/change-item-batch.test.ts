import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates } from "../../src/db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "../../src/lib/change-item-batch";

describe("change-item-batch", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Batch Test Tenant"));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: "Batch Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    return { tenant, repo };
  }

  it("getPendingChangeItems returns only pending items for the repo", async () => {
    const { tenant, repo } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "excluded", prNumber: 2, prTitle: "b" },
    ]);

    const pending = await getPendingChangeItems(repo.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].prTitle).toBe("a");
  });

  it("claimBatchAndCreateUpdate creates an Update and marks the items batched", async () => {
    const { tenant, repo } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).not.toBeNull();
    expect(update!.sourceItems).toEqual([item.id]);

    const [reloaded] = await db.select().from(changeItems).where(eq(changeItems.id, item.id));
    expect(reloaded.status).toBe("batched");
    expect(reloaded.updateId).toBe(update!.id);
  });

  it("only claims items still pending, excluding ones already batched (race simulation)", async () => {
    const { tenant, repo } = await seed();
    const [stillPending, alreadyBatched] = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "batched", prNumber: 2, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [stillPending.id, alreadyBatched.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update!.sourceItems).toEqual([stillPending.id]);
  });

  it("returns null and creates no Update when none of the ids are still pending", async () => {
    const { tenant, repo } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "batched", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      repoId: repo.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(allUpdates).toHaveLength(0);
  });
});
