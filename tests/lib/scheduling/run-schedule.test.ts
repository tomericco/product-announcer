import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));
vi.mock("../../../src/lib/ai/review-draft", () => ({ reviewAndReconcile: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, contentPieces, scheduleConfigs, companyProfiles, llmUsage } from "../../../src/db/schema";
import { runBatchForWorkspace, runSchedulerTick } from "../../../src/lib/scheduling/run-schedule";
import { getOpenAtomicUpdates } from "../../../src/lib/change-events/release-claim";
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
    return { tenant };
  }

  async function seedAtomicUpdates(tenantId: string, titles: string[]) {
    const out = [];
    for (const title of titles) {
      const [row] = await db.insert(atomicUpdates).values({ tenantId, title, summary: `Summary for ${title}` }).returning();
      out.push(row);
    }
    return out;
  }

  it("runBatchForWorkspace makes one release from all open atomic updates and links them via contentPieceId", async () => {
    const { tenant } = await seed();
    const [a1, a2] = await seedAtomicUpdates(tenant.id, ["A", "B"]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "Combined", body: "Two changes.", category: "new" },
    } as never);

    const open = await getOpenAtomicUpdates(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, open);

    expect(created).toBe(true);
    const createdReleases = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(createdReleases).toHaveLength(1);
    const release = createdReleases[0];
    // Nothing publishes: the release stays a draft awaiting review.
    expect(release.status).toBe("draft");
    expect(release.publishedAt).toBeNull();

    const linked = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.tenantId, tenant.id));
    expect(linked.map((a) => a.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(linked.every((a) => a.contentPieceId === release.id)).toBe(true);
    // Open-until-publish: the release is still a draft, so its atomic updates
    // stay `open` (with contentPieceId set) rather than flipping to `released` —
    // that only happens when the release is published.
    expect(linked.every((a) => a.status === "open")).toBe(true);
    // getOpenAtomicUpdates is the compose candidate set: it excludes AUs
    // already linked to a (draft) release via contentPieceId, even though they're
    // still status='open'.
    expect(await getOpenAtomicUpdates(tenant.id)).toHaveLength(0);
  });

  it("runBatchForWorkspace does nothing on empty input", async () => {
    const { tenant } = await seed();
    const created = await runBatchForWorkspace(tenant.id, []);
    expect(created).toBe(false);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("leaves atomic updates open when generation fails twice", async () => {
    const { tenant } = await seed();
    const [a1] = await seedAtomicUpdates(tenant.id, ["Flaky"]);
    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const open = await getOpenAtomicUpdates(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, open);

    expect(created).toBe(false);
    expect(generateObject).toHaveBeenCalledTimes(2);
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.status).toBe("open");
    expect(after.contentPieceId).toBeNull();
  });

  it("runSchedulerTick fires the workspace config, creates one release, advances nextScheduledAt on cadence", async () => {
    const { tenant } = await seed();
    await seedAtomicUpdates(tenant.id, ["A"]);
    const past = new Date("2026-07-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: null, nextScheduledAt: past });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(advanceNextScheduledAt(past, "weekly"));
  });

  it("runSchedulerTick does NOT advance nextScheduledAt on a threshold-reason fire", async () => {
    const { tenant } = await seed();
    await seedAtomicUpdates(tenant.id, ["A"]);
    const future = new Date("2026-08-01T00:00:00Z");
    await db.insert(scheduleConfigs).values({ tenantId: tenant.id, cadence: "weekly", threshold: 1, thresholdEnabled: true, nextScheduledAt: future });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    await runSchedulerTick(new Date("2026-07-14T00:00:00Z"));

    expect(await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id))).toHaveLength(1);
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, tenant.id));
    expect(config.nextScheduledAt).toEqual(future);
  });

  it("selects matching seeded examples and injects them into the generation prompt", async () => {
    const { tenant } = await seed();
    // Brand profile whose industry + system persona match the seeded devtools/developer examples.
    await db.insert(companyProfiles).values({
      tenantId: tenant.id,
      industry: "Developer Tools",
      userPersonas: [{ type: "system", key: "developer" }],
    });
    await seedAtomicUpdates(tenant.id, ["A"]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    const open = await getOpenAtomicUpdates(tenant.id);
    await runBatchForWorkspace(tenant.id, open);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("mirror their structure");
    expect(system).toContain("Ship webhooks with the new Events API"); // seeded devtools-developer-new title
  });

  it("runBatchForWorkspace emits ordered progress events and a done event on success", async () => {
    const { tenant } = await seed();
    await seedAtomicUpdates(tenant.id, ["A"]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    const events: import("../../../src/lib/scheduling/draft-progress").DraftProgressEvent[] = [];
    const open = await getOpenAtomicUpdates(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, open, db, (e) => events.push(e));

    expect(created).toBe(true);
    // step start/done pairs in order, then a terminal done with the update id
    const steps = events.filter((e) => e.type === "step");
    expect(steps.map((e) => `${(e as { key: string }).key}:${(e as { status: string }).status}`)).toEqual([
      "preparing:start", "preparing:done",
      "generating:start", "generating:done",
      "reviewing:start", "reviewing:done",
      "saving:start", "saving:done",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    const [row] = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(done).toEqual({ type: "done", updateId: row.id });
  });

  it("records token usage for the generation call", async () => {
    const { tenant } = await seed();
    await seedAtomicUpdates(tenant.id, ["A"]);
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B" },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    } as never);

    const open = await getOpenAtomicUpdates(tenant.id);
    await runBatchForWorkspace(tenant.id, open);

    const rows = await db.select().from(llmUsage).where(eq(llmUsage.tenantId, tenant.id));
    const generation = rows.find((r) => r.operation === "generation");
    expect(generation).toBeTruthy();
    expect(generation!.inputTokens).toBe(100);
    expect(generation!.outputTokens).toBe(20);
  });

  it("runBatchForWorkspace emits an error event (not done) when generation fails twice", async () => {
    const { tenant } = await seed();
    await seedAtomicUpdates(tenant.id, ["Flaky"]);
    vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

    const events: import("../../../src/lib/scheduling/draft-progress").DraftProgressEvent[] = [];
    const open = await getOpenAtomicUpdates(tenant.id);
    const created = await runBatchForWorkspace(tenant.id, open, db, (e) => events.push(e));

    expect(created).toBe(false);
    expect(events.some((e) => e.type === "done")).toBe(false);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeTruthy();
    expect((err as { message: string }).message).toContain("model unavailable");
  });
});
