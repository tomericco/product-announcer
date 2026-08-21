import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { aiVisibilityPrompts, aiVisibilityRuns } from "../../../src/db/schema";
import { engineCost } from "../../../src/lib/ai-visibility/engines";
import {
  estimateRunCost,
  monthStartUtc,
  nextMonthStartUtc,
  monthToDateSpendUsd,
  capExceeded,
} from "../../../src/lib/ai-visibility/cost";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Cost Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedPrompts(tenantId: string, specs: { intent: string; status?: string }[]) {
  let i = 0;
  for (const spec of specs) {
    await db.insert(aiVisibilityPrompts).values({
      tenantId,
      text: `prompt ${i++}`,
      intent: spec.intent,
      origin: "generated",
      status: spec.status ?? "active",
    });
  }
}

describe("estimateRunCost", () => {
  it("multiplies prompts by engines by samples, per engine cost", () => {
    const engines = ["openai", "perplexity"] as const;
    const expected = 4 * 3 * (engineCost("openai") + engineCost("perplexity"));
    expect(estimateRunCost({ promptCount: 4, engines: [...engines], samplesPerPrompt: 3 })).toBeCloseTo(expected, 8);
  });

  it("is zero when there is nothing to run", () => {
    expect(estimateRunCost({ promptCount: 0, engines: ["openai"], samplesPerPrompt: 3 })).toBe(0);
    expect(estimateRunCost({ promptCount: 10, engines: [], samplesPerPrompt: 3 })).toBe(0);
  });

  it("ignores engine ids it does not recognise rather than charging NaN", () => {
    expect(
      estimateRunCost({ promptCount: 1, engines: ["openai", "not-an-engine" as never], samplesPerPrompt: 1 })
    ).toBeCloseTo(engineCost("openai"), 8);
  });
});

describe("month boundaries", () => {
  it("snaps to the first instant of the UTC month and the next one", () => {
    const now = new Date("2026-03-17T22:45:00.000Z");
    expect(monthStartUtc(now).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(nextMonthStartUtc(now).toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("rolls the year over in December", () => {
    const now = new Date("2026-12-31T23:59:59.000Z");
    expect(nextMonthStartUtc(now).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("monthToDateSpendUsd", () => {
  it("sums this calendar month's runs and ignores neighbouring months", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilityRuns).values([
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        costUsd: 2.5,
        startedAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "manual",
        engines: ["openai"],
        samplesPerPrompt: 3,
        costUsd: 1.25,
        startedAt: new Date("2026-03-28T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        costUsd: 99,
        startedAt: new Date("2026-02-27T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        costUsd: 99,
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const spend = await monthToDateSpendUsd(tenant.id, new Date("2026-03-30T12:00:00.000Z"));
    expect(spend).toBeCloseTo(3.75, 6);
  });

  it("is zero, never NaN, for a tenant with no runs", async () => {
    const tenant = await seedTenant(TENANT);
    expect(await monthToDateSpendUsd(tenant.id, new Date("2026-03-30T12:00:00.000Z"))).toBe(0);
  });
});

describe("capExceeded", () => {
  const settings = { engines: ["openai"], samplesPerPrompt: 3, monthlyCapUsd: 20 };

  it("charges brand_check prompts one sample, not samplesPerPrompt", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [{ intent: "discovery" }, { intent: "brand_check" }]);

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    // one discovery prompt at 3 samples + one brand_check prompt at 1 sample
    expect(state.estimateUsd).toBeCloseTo(4 * engineCost("openai"), 8);
  });

  it("counts only active prompts", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [
      { intent: "discovery" },
      { intent: "discovery", status: "proposed" },
      { intent: "discovery", status: "paused" },
      { intent: "discovery", status: "rejected" },
    ]);

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    expect(state.estimateUsd).toBeCloseTo(3 * engineCost("openai"), 8);
  });

  it("is not exceeded when spend plus the next run fits under the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [{ intent: "discovery" }]);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      costUsd: 1,
      startedAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    expect(state.spentUsd).toBeCloseTo(1, 6);
    expect(state.capUsd).toBe(20);
    expect(state.exceeded).toBe(false);
    expect(state.reached).toBe(false);
  });

  it("is exceeded, but not reached, when the next run would cross the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [{ intent: "discovery" }]);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      costUsd: 19.999,
      startedAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    expect(state.exceeded).toBe(true);
    expect(state.reached).toBe(false);
  });

  it("is reached once spend alone is at the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [{ intent: "discovery" }]);
    await db.insert(aiVisibilityRuns).values({
      tenantId: tenant.id,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      costUsd: 20,
      startedAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    expect(state.reached).toBe(true);
    expect(state.exceeded).toBe(true);
  });
});
