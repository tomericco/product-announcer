import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import { planRun } from "../../../src/lib/ai-visibility/run";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Run Test Tenant";

/** A clock that never moves. Enough for planning; D3 uses an advancing one. */
const frozen = (iso: string) => () => new Date(iso);

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedSettings(
  tenantId: string,
  overrides: Partial<typeof aiVisibilitySettings.$inferInsert> = {}
) {
  await db.insert(aiVisibilitySettings).values({
    tenantId,
    enabled: true,
    engines: ["openai", "perplexity"],
    samplesPerPrompt: 3,
    monthlyCapUsd: 20,
    ...overrides,
  });
}

async function seedPrompt(
  tenantId: string,
  overrides: Partial<typeof aiVisibilityPrompts.$inferInsert> = {}
) {
  const [prompt] = await db
    .insert(aiVisibilityPrompts)
    .values({
      tenantId,
      text: overrides.text ?? `best tool for teams ${Math.random()}`,
      intent: "discovery",
      origin: "generated",
      status: "active",
      ...overrides,
    })
    .returning();
  return prompt;
}

describe("planRun", () => {
  it("refuses when the feature is disabled", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { enabled: false });
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "disabled" });
    expect(await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.tenantId, tenant.id))).toHaveLength(0);
  });

  it("refuses when there is no active prompt", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id, { status: "proposed" });

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "no_prompts" });
  });

  it("refuses when a run is already in flight and names it", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);
    const [inFlight] = await db
      .insert(aiVisibilityRuns)
      .values({ tenantId: tenant.id, trigger: "scheduled", engines: ["openai"], samplesPerPrompt: 3, status: "running" })
      .returning();

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result).toEqual({ ok: false, reason: "run_in_flight", runId: inFlight.id });
  });

  it("refuses when the monthly cap would be crossed", async () => {
    const tenant = await seedTenant(TENANT);
    // MIN_MONTHLY_CAP_USD is 1 and `getAiVisibilitySettings` clamps to it, so a
    // sub-cent cap cannot be seeded. The month's spend is what puts this run
    // over instead — which is the gate as it actually fires in production.
    await seedSettings(tenant.id, { monthlyCapUsd: 1 });
    await seedPrompt(tenant.id);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai", "perplexity"],
      samplesPerPrompt: 3,
      status: "complete",
      costUsd: 0.95,
      startedAt: new Date("2026-03-01T09:00:00Z"),
    });

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("cap_reached");
  });

  it("inserts a pending run and one pending sample per prompt x engine x sample", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    const a = await seedPrompt(tenant.id, { text: "best issue tracker for startups" });
    const b = await seedPrompt(tenant.id, { text: "what is Versional", intent: "brand_check", branded: true });

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, result.runId));
    expect(run.status).toBe("pending");
    expect(run.trigger).toBe("scheduled");
    expect(run.engines.sort()).toEqual(["openai", "perplexity"]);
    expect(run.samplesPerPrompt).toBe(3);
    // 1 discovery prompt x 2 engines x 3 samples + 1 brand_check x 2 engines x 1 sample
    expect(run.plannedCalls).toBe(8);
    expect(result.plannedCalls).toBe(8);

    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(samples).toHaveLength(8);
    expect(samples.every((s) => s.status === "pending")).toBe(true);
    expect(samples.every((s) => s.tenantId === tenant.id)).toBe(true);

    const brandCheck = samples.filter((s) => s.promptId === b.id);
    expect(brandCheck).toHaveLength(2);
    expect(brandCheck.map((s) => s.sampleIndex).sort()).toEqual([0, 0]);

    const discovery = samples.filter((s) => s.promptId === a.id && s.engine === "openai");
    expect(discovery.map((s) => s.sampleIndex).sort()).toEqual([0, 1, 2]);
  });

  it("plans only the engines the tenant enabled", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id, { engines: ["openai"] });
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const samples = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, result.runId));
    expect(new Set(samples.map((s) => s.engine))).toEqual(new Set(["openai"]));
  });

  it("attaches the tenant's ai_visibility source to the run", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);

    const result = await planRun(tenant.id, { trigger: "scheduled", now: frozen("2026-03-02T09:00:00Z") });
    if (!result.ok) throw new Error("unreachable");

    const [run] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, result.runId));
    expect(run.sourceId).not.toBeNull();
  });

  it("does not treat a completed run as in flight", async () => {
    const tenant = await seedTenant(TENANT);
    await seedSettings(tenant.id);
    await seedPrompt(tenant.id);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "complete",
    });

    const result = await planRun(tenant.id, { trigger: "manual", now: frozen("2026-03-02T09:00:00Z") });
    expect(result.ok).toBe(true);
  });
});
