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
    const [repoA] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/a", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [repoB] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/b", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    return { tenant, repoA, repoB };
  }

  it("getPendingChangeItems returns pending items across all of the tenant's repos", async () => {
    const { tenant, repoA, repoB } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "excluded", prNumber: 2, prTitle: "x" },
    ]);

    const pending = await getPendingChangeItems(tenant.id);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.prTitle).sort()).toEqual(["a", "b"]);
  });

  it("claimBatchAndCreateUpdate creates one cross-repo Update (repoId null) and marks items batched", async () => {
    const { tenant, repoA, repoB } = await seed();
    const inserted = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: inserted.map((i) => i.id),
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).not.toBeNull();
    expect(update!.repoId).toBeNull();
    expect(update!.sourceItems.sort()).toEqual(inserted.map((i) => i.id).sort());

    const reloaded = await db.select().from(changeItems).where(eq(changeItems.tenantId, tenant.id));
    expect(reloaded.every((r) => r.status === "batched" && r.updateId === update!.id)).toBe(true);
  });

  it("only claims items still pending (race simulation)", async () => {
    const { tenant, repoA } = await seed();
    const [stillPending, alreadyBatched] = await db
      .insert(changeItems)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "batched", prNumber: 2, prTitle: "b" },
      ])
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [stillPending.id, alreadyBatched.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update!.sourceItems).toEqual([stillPending.id]);
  });

  it("returns null and creates no Update when none of the ids are still pending", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "batched", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(allUpdates).toHaveLength(0);
  });
});
