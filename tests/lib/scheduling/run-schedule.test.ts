import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));
vi.mock("../../../src/lib/ai/review-draft", () => ({ reviewAndReconcile: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeItems, updates, scheduleConfigs, brandProfiles } from "../../../src/db/schema";
import { runBatchForWorkspace, runSchedulerTick, applyPostRunScheduleChoice } from "../../../src/lib/scheduling/run-schedule";
import { getPendingChangeItems } from "../../../src/lib/change-items/change-item-batch";
import { advanceNextScheduledAt } from "../../../src/lib/scheduling/scheduler-decision";
import { reviewAndReconcile } from "../../../src/lib/ai/review-draft";

const TENANT = "Run Batch Test Tenant";

describe("run-schedule (workspace-level)", () => {
  beforeEach(() => {
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "passed", issues: [] }));
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    vi.mocked(generateObject).mockReset();
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
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

  it("runBatchForWorkspace makes one cross-repo Update from all pending and marks them batched", async () => {
    const { tenant, repoA, repoB } = await seed();
    await db.insert(changeItems).values([
      { tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" },
      { tenantId: tenant.id, repoId: repoB.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "b" },
    ]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Combined", body: "Two repos.", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, pending);

    expect(created).toBe(true);
    const createdUpdates = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(createdUpdates).toHaveLength(1);
    expect(createdUpdates[0].repoId).toBeNull();
    expect(await getPendingChangeItems(tenant.id)).toHaveLength(0);
  });

  it("runBatchForWorkspace does nothing on empty pending", async () => {
    const { tenant } = await seed();
    const created = await runBatchForWorkspace(tenant.id, []);
    expect(created).toBe(false);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("leaves items pending when generation fails twice", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "flaky",
    });
    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const pending = await getPendingChangeItems(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, pending);

    expect(created).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(2);
    expect(await getPendingChangeItems(tenant.id)).toHaveLength(1);
  });

  it("runSchedulerTick fires the workspace config, creates one Update, advances nextScheduledAt on cadence", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    const past = new Date("2026-07-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: null, nextScheduledAt: past });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(updates).where(eq(updates.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(advanceNextScheduledAt(past, "weekly"));
  });

  it("runSchedulerTick does NOT advance nextScheduledAt on a threshold-reason fire", async () => {
    const { tenant, repoA } = await seed();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    const future = new Date("2026-08-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: 1, nextScheduledAt: future });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(updates).where(eq(updates.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(future);
  });

  it("selects matching seeded examples and injects them into the generation prompt", async () => {
    const { tenant, repoA } = await seed();
    // Brand profile whose industry + system persona match the seeded devtools/developer examples.
    await db.insert(brandProfiles).values({
      tenantId: tenant.id,
      industry: "Developer Tools",
      userPersonas: [{ type: "system", key: "developer" }],
    });
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("mirror their structure");
    expect(system).toContain("Ship webhooks with the new Events API"); // seeded devtools-developer-new title
  });

  it("applyPostRunScheduleChoice('skip') advances the workspace schedule from its current value", async () => {
    const { tenant } = await seed();
    const anchor = new Date("2026-07-10T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", nextScheduledAt: anchor });

    await applyPostRunScheduleChoice(tenant.id, "skip");

    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(advanceNextScheduledAt(anchor, "weekly"));
  });
});
