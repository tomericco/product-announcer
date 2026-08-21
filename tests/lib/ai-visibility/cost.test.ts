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
  capPausedMessage,
  isCapPausedError,
  CAP_PAUSED_PREFIX,
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
        status: "complete",
        costUsd: 2.5,
        startedAt: new Date("2026-03-02T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "manual",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        costUsd: 1.25,
        startedAt: new Date("2026-03-28T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        costUsd: 99,
        startedAt: new Date("2026-02-27T00:00:00.000Z"),
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        costUsd: 99,
        startedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const spend = await monthToDateSpendUsd(tenant.id, new Date("2026-03-30T12:00:00.000Z"));
    expect(spend).toBeCloseTo(3.75, 6);
  });

  it("rounds to cents, so a float4 sum never reaches the settings card raw", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilityRuns).values(
      [0.012, 0.012, 0.012].map((costUsd, i) => ({
        tenantId: tenant.id,
        trigger: "scheduled" as const,
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        costUsd,
        startedAt: new Date(`2026-03-0${i + 2}T00:00:00.000Z`),
      }))
    );

    // The unrounded sum of three float4 0.012s is 0.036000000312924385.
    expect(await monthToDateSpendUsd(tenant.id, new Date("2026-03-30T12:00:00.000Z"))).toBe(0.04);
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
      status: "complete",
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
      status: "complete",
      // 19.99, not 19.999: spend is rounded to cents on the way out, so a
      // tenth of a cent below the cap rounds UP to $20 and is `reached`.
      costUsd: 19.99,
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
      status: "complete",
      costUsd: 20,
      startedAt: new Date("2026-03-05T00:00:00.000Z"),
    });

    const state = await capExceeded(tenant.id, settings, new Date("2026-03-10T00:00:00.000Z"));
    expect(state.reached).toBe(true);
    expect(state.exceeded).toBe(true);
  });
});

/**
 * The suite pins `process.env.TZ` to Asia/Jerusalem (see vitest.setup.ts), which
 * is what makes these assertions mean anything: on a UTC machine a
 * `getMonth()`/`getFullYear()` implementation would pass every test above just
 * as well as the `getUTCMonth()` one we actually have. The cap is a calendar
 * month in UTC — the same window for every tenant, whatever timezone they are
 * in — so an instant that is already next month locally must still count
 * against this month's budget, and vice versa.
 */
describe("month boundaries are UTC, not the server's local zone", () => {
  // The premises, asserted rather than assumed: if the pinned zone ever moves,
  // these fail here instead of silently turning the tests below into no-ops.
  const lastInstantOfUtcFebruary = new Date("2026-02-28T23:00:00.000Z");
  const lastInstantOfUtcMarch = new Date("2026-03-31T23:00:00.000Z");

  it("is a different month locally than it is in UTC at these instants", () => {
    expect(lastInstantOfUtcFebruary.getUTCMonth()).toBe(1); // February, UTC
    expect(lastInstantOfUtcFebruary.getMonth()).toBe(2); // March, Asia/Jerusalem
    expect(lastInstantOfUtcMarch.getUTCMonth()).toBe(2); // March, UTC
    expect(lastInstantOfUtcMarch.getMonth()).toBe(3); // April, Asia/Jerusalem
  });

  it("snaps to the UTC month even when the local date says otherwise", () => {
    expect(monthStartUtc(lastInstantOfUtcFebruary).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(monthStartUtc(lastInstantOfUtcMarch).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(nextMonthStartUtc(lastInstantOfUtcFebruary).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("puts a run on the UTC side of the boundary it straddles", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilityRuns).values([
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        // Locally this is 1 March. In UTC it is still February, so it belongs
        // to February's budget — counting it against March would charge a
        // tenant twice for the same dollar in the two-hour overlap.
        costUsd: 5,
        startedAt: lastInstantOfUtcFebruary,
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        // Locally this is 1 April; in UTC it is the last hour of March, and
        // March is what the cap has to charge it to.
        costUsd: 7,
        startedAt: lastInstantOfUtcMarch,
      },
      {
        tenantId: tenant.id,
        trigger: "scheduled",
        engines: ["openai"],
        samplesPerPrompt: 3,
        status: "complete",
        // The inclusive lower bound, exactly.
        costUsd: 1,
        startedAt: new Date("2026-03-01T00:00:00.000Z"),
      },
    ]);

    const march = await monthToDateSpendUsd(tenant.id, new Date("2026-03-15T12:00:00.000Z"));
    expect(march).toBeCloseTo(8, 6);

    const february = await monthToDateSpendUsd(tenant.id, new Date("2026-02-15T12:00:00.000Z"));
    expect(february).toBeCloseTo(5, 6);
  });
});

describe("estimate edge cases the cap depends on", () => {
  it("clamps a negative count to zero rather than issuing a credit", () => {
    // A negative estimate would make `spent + estimate > cap` false for any
    // spend — the cap silently switching itself off, which is the one failure
    // this module must not have.
    expect(estimateRunCost({ promptCount: -5, engines: ["openai"], samplesPerPrompt: 3 })).toBe(0);
    expect(estimateRunCost({ promptCount: 5, engines: ["openai"], samplesPerPrompt: -3 })).toBe(0);
  });

  it("estimates zero, and stays under the cap, for a tenant with no active prompts", async () => {
    const tenant = await seedTenant(TENANT);
    await seedPrompts(tenant.id, [{ intent: "discovery", status: "proposed" }]);

    const state = await capExceeded(
      tenant.id,
      { engines: ["openai"], samplesPerPrompt: 3, monthlyCapUsd: 20 },
      new Date("2026-03-10T00:00:00.000Z")
    );

    expect(state.estimateUsd).toBe(0);
    expect(state.exceeded).toBe(false);
    expect(state.reached).toBe(false);
  });
});

describe("the cap-pause sentence", () => {
  it("writes the amounts to the cent, and recognises its own output", () => {
    const message = capPausedMessage(20, 20.5);

    expect(message).toBe(`${CAP_PAUSED_PREFIX} ($20.00 of $20.50).`);
    // The round trip is the point: `runSlice` and the cron sweep write this
    // string on the source, and `saveAiVisibilitySettings` has to be able to
    // tell it apart from a real failure when it decides whether raising the cap
    // should clear the red badge.
    expect(isCapPausedError(message)).toBe(true);
  });

  it("does not mistake an engine outage, an empty error or no error for a cap pause", () => {
    expect(isCapPausedError(null)).toBe(false);
    expect(isCapPausedError("")).toBe(false);
    expect(isCapPausedError("openai 429: rate limited")).toBe(false);
    // Same words, different sentence: only the prefix this module owns counts.
    expect(isCapPausedError("The monthly cap was reached")).toBe(false);
  });
});
