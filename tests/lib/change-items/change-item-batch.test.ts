import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems, updates } from "../../../src/db/schema";
import {
  getPendingChangeItems,
  getBatchableChangeItems,
  getTrackedChangeItems,
  claimBatchAndCreateUpdate,
  batchCategories,
} from "../../../src/lib/change-items/change-item-batch";

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

  it("getBatchableChangeItems excludes non-facing items but keeps facing and un-enriched (null)", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "facing", userFacing: true },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 2, prTitle: "non-facing", userFacing: false },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 3, prTitle: "unenriched" }, // userFacing null
    ]);

    const batchable = await getBatchableChangeItems(tenant.id);
    expect(batchable.map((p) => p.prTitle).sort()).toEqual(["facing", "unenriched"]);

    const all = await getPendingChangeItems(tenant.id);
    expect(all.map((p) => p.prTitle).sort()).toEqual(["facing", "non-facing", "unenriched"]);
  });

  it("getTrackedChangeItems returns pending and ignored items, excluding batched/excluded", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "pending", commitSha: "p1", commitMessage: "p" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "ignored", ignoredReason: "merge_commit", commitSha: "i1", commitMessage: "m" },
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "commit", status: "excluded", commitSha: "x1", commitMessage: "x" },
    ]);
    const tracked = await getTrackedChangeItems(tenant.id);
    expect(tracked.map((t) => t.commitSha).sort()).toEqual(["i1", "p1"]);
    // generation still excludes ignored:
    const batchable = await getBatchableChangeItems(tenant.id);
    expect(batchable.map((b) => b.commitSha)).toEqual(["p1"]);
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
      draft: { title: "T", body: "B" },
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
      draft: { title: "T", body: "B" },
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
      draft: { title: "T", body: "B" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(allUpdates).toHaveLength(0);
  });

  it("claimBatchAndCreateUpdate persists the review outcome when provided", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B" },
      review: { status: "failed", issues: ["too salesy"] },
    });

    expect(update!.reviewStatus).toBe("failed");
    expect(update!.reviewIssues).toEqual(["too salesy"]);
    expect(update!.reviewedAt).toBeInstanceOf(Date);
  });
});

describe("batchCategories", () => {
  it("returns the distinct non-null suggested categories in first-seen order", () => {
    const items = [
      { suggestedCategory: "new" },
      { suggestedCategory: null },
      { suggestedCategory: "improved" },
      { suggestedCategory: "new" },
    ];
    expect(batchCategories(items)).toEqual(["new", "improved"]);
  });

  it("returns an empty array when there are no categories", () => {
    expect(batchCategories([])).toEqual([]);
    expect(batchCategories([{ suggestedCategory: null }])).toEqual([]);
  });
});
