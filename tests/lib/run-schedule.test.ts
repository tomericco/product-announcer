import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates, scheduleConfigs } from "../../src/db/schema";
import { runBatchForRepo, runSchedulerTick } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";
import { advanceNextScheduledAt } from "../../src/lib/scheduler-decision";

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

describe("runSchedulerTick", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Run Batch Test Tenant"));
    vi.mocked(generateObject).mockReset();
  });

  it("advances nextScheduledAt by one cadence interval when a cadence-due tick creates an Update", async () => {
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

    const now = new Date("2026-07-14T12:00:00Z");
    const originalNextScheduledAt = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day in the past
    const [config] = await db
      .insert(scheduleConfigs)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        cadence: "weekly",
        threshold: null,
        nextScheduledAt: originalNextScheduledAt,
      })
      .returning();

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Dark mode", body: "You can now enable dark mode.", category: "new" },
    } as never);

    await runSchedulerTick(now, db);

    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(1);

    const [reloaded] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.id, config.id));
    expect(reloaded.nextScheduledAt?.getTime()).toBe(advanceNextScheduledAt(originalNextScheduledAt, "weekly").getTime());
    expect(reloaded.lastRunAt).not.toBeNull();
  });

  it("does not advance nextScheduledAt when the run is triggered by threshold, not cadence", async () => {
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

    const now = new Date("2026-07-14T12:00:00Z");
    const originalNextScheduledAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 1 day in the future
    const [config] = await db
      .insert(scheduleConfigs)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        cadence: "weekly",
        threshold: 1,
        nextScheduledAt: originalNextScheduledAt,
      })
      .returning();

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Dark mode", body: "You can now enable dark mode.", category: "new" },
    } as never);

    await runSchedulerTick(now, db);

    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(1);

    const [reloaded] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.id, config.id));
    expect(reloaded.nextScheduledAt?.getTime()).toBe(originalNextScheduledAt.getTime());
  });

  it("does not advance nextScheduledAt and leaves the item pending when generation fails twice", async () => {
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

    const now = new Date("2026-07-14T12:00:00Z");
    const originalNextScheduledAt = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day in the past
    const [config] = await db
      .insert(scheduleConfigs)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        cadence: "weekly",
        threshold: null,
        nextScheduledAt: originalNextScheduledAt,
      })
      .returning();

    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    await runSchedulerTick(now, db);

    const createdUpdates = await db.select().from(updates).where(eq(updates.repoId, repo.id));
    expect(createdUpdates).toHaveLength(0);

    const stillPending = await getPendingChangeItems(repo.id, db);
    expect(stillPending).toHaveLength(1);

    const [reloaded] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.id, config.id));
    expect(reloaded.nextScheduledAt?.getTime()).toBe(originalNextScheduledAt.getTime());
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
