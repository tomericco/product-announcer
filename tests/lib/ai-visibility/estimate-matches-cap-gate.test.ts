import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../../src/db";
import { aiVisibilityPrompts } from "../../../src/db/schema";
import { capExceeded } from "../../../src/lib/ai-visibility/cost";
import { plannedCallsForPrompts } from "../../../src/lib/ai-visibility/planned-calls";
import { MAX_ACTIVE_PROMPTS, runnablePrompts } from "../../../src/lib/ai-visibility/prompts";
import { engineCost } from "../../../src/lib/ai-visibility/engines";
import { ENGINE_IDS, type EngineId } from "../../../src/lib/ai-visibility/types";
import { monthlyEstimateUsd } from "../../../src/app/(dashboard)/settings/ai-visibility-form";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

/**
 * The /settings card's "≈ $X/month at current settings" is the design's
 * central trust cue, and `capExceeded` is the gate that actually pauses a run.
 * A trust cue that disagrees with the gate it describes is worse than no
 * number — so this file runs both over the same tenant and asserts they agree,
 * rather than pinning the form's arithmetic against a second copy of itself.
 *
 * The brand-check rule is the specific place they drifted: `capExceeded`
 * charges a `brand_check` prompt exactly one sample whatever the samples
 * setting says, and an estimate that charged all of them at three read high.
 *
 * The second is `MAX_ACTIVE_PROMPTS`. A run asks at most that many prompts, so
 * both sides price at most that many: the gate LIMITs its own read, and the
 * pages hand the form a `runnablePrompts` slice. These fixtures therefore stay
 * at or under the cap except where the test is about overshooting it.
 */
const TENANT = "AI Visibility Estimate Gate Test Tenant";

/** Weekly runs per month, the same average the form uses. */
const WEEKLY_RUNS_PER_MONTH = 52 / 12;

const COST_PER_CALL = Object.fromEntries(
  ENGINE_IDS.map((engine) => [engine, engineCost(engine)])
) as Record<EngineId, number>;

afterEach(async () => {
  await dropTenant(TENANT);
});

async function seedPrompts(tenantId: string, specs: { intent: string; status?: string }[]) {
  let index = 0;
  for (const spec of specs) {
    await db.insert(aiVisibilityPrompts).values({
      tenantId,
      text: `estimate gate prompt ${index++}`,
      intent: spec.intent,
      origin: "generated",
      status: spec.status ?? "active",
    });
  }
}

/** What one weekly run costs according to the form's monthly figure. */
function formPerRunUsd(a: {
  promptCount: number;
  brandCheckCount: number;
  engines: EngineId[];
  samplesPerPrompt: number;
}): number {
  return (
    monthlyEstimateUsd({
      ...a,
      cadence: "weekly",
      costPerCall: COST_PER_CALL,
    }) / WEEKLY_RUNS_PER_MONTH
  );
}

describe("the settings estimate and the cap gate agree", () => {
  it("charges brand-check prompts one sample on both sides", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [
      ...Array.from({ length: 3 }, () => ({ intent: "discovery" })),
      { intent: "brand_check" },
      { intent: "brand_check" },
    ]);
    const settings = {
      engines: ["openai", "gemini"],
      samplesPerPrompt: 3,
      monthlyCapUsd: 20,
    };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(
      formPerRunUsd({
        promptCount: 5,
        brandCheckCount: 2,
        engines: settings.engines as EngineId[],
        samplesPerPrompt: 3,
      })
    ).toBeCloseTo(gate.estimateUsd, 8);
  });

  it("agrees for a prompt set with no brand checks at all", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, Array.from({ length: 5 }, () => ({ intent: "comparison" })));
    const settings = { engines: [...ENGINE_IDS], samplesPerPrompt: 5, monthlyCapUsd: 200 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(
      formPerRunUsd({
        promptCount: 5,
        brandCheckCount: 0,
        engines: [...ENGINE_IDS],
        samplesPerPrompt: 5,
      })
    ).toBeCloseTo(gate.estimateUsd, 8);
  });

  it("agrees when every prompt is a brand check, where the samples setting drops out entirely", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, Array.from({ length: 5 }, () => ({ intent: "brand_check" })));
    const settings = { engines: ["anthropic"], samplesPerPrompt: 5, monthlyCapUsd: 20 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(
      formPerRunUsd({
        promptCount: 5,
        brandCheckCount: 5,
        engines: ["anthropic"],
        samplesPerPrompt: 5,
      })
    ).toBeCloseTo(gate.estimateUsd, 8);
    // Five calls, not twenty-five — the samples setting must not touch them.
    expect(gate.estimateUsd).toBeCloseTo(5 * engineCost("anthropic"), 8);
  });

  it("counts only ACTIVE prompts, exactly as the gate does", async () => {
    // Proposals, paused and rejected prompts plan no calls. An estimate that
    // counted them would talk a tenant out of a run they can afford.
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [
      { intent: "discovery" },
      { intent: "discovery", status: "paused" },
      { intent: "discovery", status: "proposed" },
      { intent: "brand_check", status: "rejected" },
    ]);
    const settings = { engines: ["openai"], samplesPerPrompt: 3, monthlyCapUsd: 20 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(
      formPerRunUsd({
        promptCount: 1,
        brandCheckCount: 0,
        engines: ["openai"],
        samplesPerPrompt: 3,
      })
    ).toBeCloseTo(gate.estimateUsd, 8);
  });

  it("counts the same calls the gate charges for, from the prompt list the pages hold", async () => {
    // The third copy of this formula. Both Run-now buttons quote a CALL count
    // beside the gate's dollar figure, and they used to derive it by hand —
    // `prompts × engines × samples` plus a brand-check correction, written out
    // twice. A flat product reads high, and it reads high on the control that
    // spends money.
    const tenant = await seedTenant(TENANT);
    const specs = [
      ...Array.from({ length: 3 }, () => ({ intent: "discovery" })),
      { intent: "brand_check" },
      { intent: "brand_check" },
    ];
    await seedPrompts(tenant.id, specs);
    const settings = { engines: ["openai", "gemini"], samplesPerPrompt: 3, monthlyCapUsd: 20 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));
    const calls = plannedCallsForPrompts(specs, {
      engineCount: settings.engines.length,
      samplesPerPrompt: settings.samplesPerPrompt,
    });

    // 3 × 3 + 2 × 1 = 11 per engine, 22 across two. A flat product says 30.
    expect(calls).toBe(22);
    // And the gate priced exactly those calls: both engines here cost the same
    // per call in the fixture only if that holds, so assert per-engine instead.
    expect(gate.estimateUsd).toBeCloseTo(11 * (engineCost("openai") + engineCost("gemini")), 8);
  });

  it("prices only the prompts a run will ask, for a tenant seeded over the cap", async () => {
    // Lowering `MAX_ACTIVE_PROMPTS` deactivates nothing, so this tenant is a
    // real one: 8 active rows, of which `planRun` asks the first 5. A gate
    // still pricing all 8 would pause a tenant for spend that never happens,
    // and the form beside it would quote a number the run never spends.
    const tenant = await seedTenant(TENANT);
    const specs = Array.from({ length: 8 }, () => ({ intent: "discovery" }));
    await seedPrompts(tenant.id, specs);
    const settings = { engines: ["openai"], samplesPerPrompt: 3, monthlyCapUsd: 200 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(gate.estimateUsd).toBeCloseTo(MAX_ACTIVE_PROMPTS * 3 * engineCost("openai"), 8);
    // The pages feed the form the same slice, so the two still agree.
    const runnable = runnablePrompts(specs);
    expect(
      formPerRunUsd({
        promptCount: runnable.length,
        brandCheckCount: 0,
        engines: ["openai"],
        samplesPerPrompt: 3,
      })
    ).toBeCloseTo(gate.estimateUsd, 8);
  });

  it("agrees at zero prompts, where both must say zero rather than NaN", async () => {
    const tenant = await seedTenant(TENANT);
    const settings = { engines: [...ENGINE_IDS], samplesPerPrompt: 3, monthlyCapUsd: 20 };

    const gate = await capExceeded(tenant.id, settings, new Date("2026-08-17T00:00:00Z"));

    expect(gate.estimateUsd).toBe(0);
    expect(
      formPerRunUsd({ promptCount: 0, brandCheckCount: 0, engines: [...ENGINE_IDS], samplesPerPrompt: 3 })
    ).toBe(0);
  });
});
