import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, releases } from "../../../src/db/schema";
import {
  getPendingChangeItems,
  getBatchableChangeItems,
  getTrackedChangeItems,
  claimBatchAndCreateUpdate,
  releaseBatchForUpdate,
  batchCategories,
} from "../../../src/lib/change-events/change-item-batch";

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
    await db.insert(changeEvents).values([
      { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repoB.id, type: "pull_request", provider: "github", externalId: "acme/b#1", status: "pending", prNumber: 1, prTitle: "b" },
      { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#2", status: "excluded", prNumber: 2, prTitle: "x" },
    ]);

    const pending = await getPendingChangeItems(tenant.id);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.prTitle).sort()).toEqual(["a", "b"]);
  });

  it("getBatchableChangeItems excludes non-facing items but keeps facing and un-enriched (null)", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeEvents).values([
      { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "facing", userFacing: true },
      { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#2", status: "pending", prNumber: 2, prTitle: "non-facing", userFacing: false },
      { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#3", status: "pending", prNumber: 3, prTitle: "unenriched" }, // userFacing null
    ]);

    const batchable = await getBatchableChangeItems(tenant.id);
    expect(batchable.map((p) => p.prTitle).sort()).toEqual(["facing", "unenriched"]);

    const all = await getPendingChangeItems(tenant.id);
    expect(all.map((p) => p.prTitle).sort()).toEqual(["facing", "non-facing", "unenriched"]);
  });

  it("getTrackedChangeItems returns pending and ignored items, excluding batched/excluded", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeEvents).values([
      { tenantId: tenant.id, repoId: repoA.id, type: "commit", provider: "github", externalId: "p1", status: "pending", commitSha: "p1", commitMessage: "p" },
      { tenantId: tenant.id, repoId: repoA.id, type: "commit", provider: "github", externalId: "i1", status: "ignored", filterReason: "merge_commit", commitSha: "i1", commitMessage: "m" },
      { tenantId: tenant.id, repoId: repoA.id, type: "commit", provider: "github", externalId: "x1", status: "excluded", commitSha: "x1", commitMessage: "x" },
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
      .insert(changeEvents)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoB.id, type: "pull_request", provider: "github", externalId: "acme/b#1", status: "pending", prNumber: 1, prTitle: "b" },
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

    const reloaded = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tenant.id));
    expect(reloaded.every((r) => r.status === "batched" && r.updateId === update!.id)).toBe(true);
  });

  it("only claims items still pending (race simulation)", async () => {
    const { tenant, repoA } = await seed();
    const [stillPending, alreadyBatched] = await db
      .insert(changeEvents)
      .values([
        { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" },
        { tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#2", status: "batched", prNumber: 2, prTitle: "b" },
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
      .insert(changeEvents)
      .values({ tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "batched", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B" },
    });

    expect(update).toBeNull();
    const allUpdates = await db.select().from(releases).where(eq(releases.tenantId, tenant.id));
    expect(allUpdates).toHaveLength(0);
  });

  it("claimBatchAndCreateUpdate persists the review outcome when provided", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeEvents)
      .values({ tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" })
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

  it("releaseBatchForUpdate returns the update's items to pending and clears updateId", async () => {
    const { tenant, repoA } = await seed();
    const [mine] = await db
      .insert(changeEvents)
      .values({ tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();
    const [other] = await db
      .insert(changeEvents)
      .values({ tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#2", status: "pending", prNumber: 2, prTitle: "b" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [mine.id],
      draft: { title: "T", body: "B" },
    });

    const released = await releaseBatchForUpdate(update!.id);
    expect(released).toBe(1);

    const [releasedItem] = await db.select().from(changeEvents).where(eq(changeEvents.id, mine.id));
    expect(releasedItem.status).toBe("pending");
    expect(releasedItem.updateId).toBeNull();

    // An unrelated pending item must not be touched.
    const [untouched] = await db.select().from(changeEvents).where(eq(changeEvents.id, other.id));
    expect(untouched.status).toBe("pending");

    // The released items are visible on the Pending page again — the whole
    // point of releasing them rather than leaving them stranded in `batched`.
    const tracked = await getTrackedChangeItems(tenant.id);
    expect(tracked.map((t) => t.prTitle).sort()).toEqual(["a", "b"]);
  });

  it("an update can be deleted once its batch is released (the FK otherwise rejects it)", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeEvents)
      .values({ tenantId: tenant.id, repoId: repoA.id, type: "pull_request", provider: "github", externalId: "acme/a#1", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B" },
    });

    // Deleting while the item still points at the update violates the FK.
    await expect(db.delete(releases).where(eq(releases.id, update!.id))).rejects.toThrow();

    await releaseBatchForUpdate(update!.id);
    await db.delete(releases).where(eq(releases.id, update!.id));

    const remaining = await db.select().from(releases).where(eq(releases.id, update!.id));
    expect(remaining).toHaveLength(0);
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
