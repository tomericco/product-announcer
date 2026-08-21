import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { aiVisibilitySettings, sources } from "../../../src/db/schema";
import {
  getAiVisibilitySettings,
  saveAiVisibilitySettings,
  ensureAiVisibilitySource,
  setAiVisibilityEnabled,
  DEFAULT_AI_VISIBILITY_SETTINGS,
} from "../../../src/lib/ai-visibility/settings";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Settings Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

const VALID = {
  cadence: "fortnightly",
  dayOfWeek: 3,
  engines: ["openai", "gemini"],
  samplesPerPrompt: 5,
  monthlyCapUsd: 45,
};

describe("getAiVisibilitySettings", () => {
  it("returns the defaults when the tenant has no row", async () => {
    const tenant = await seedTenant(TENANT);

    const settings = await getAiVisibilitySettings(tenant.id);

    expect(settings).toEqual(DEFAULT_AI_VISIBILITY_SETTINGS);
    expect(settings.engines).toEqual(["openai", "perplexity", "gemini", "anthropic"]);
    // The defaults must not be the shared object — a caller mutating the
    // returned engines array would poison every later read in the process.
    expect(settings.engines).not.toBe(DEFAULT_AI_VISIBILITY_SETTINGS.engines);
  });

  it("drops an engine id the row holds that we no longer support", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: tenant.id, engines: ["openai", "bing_copilot"] });

    const settings = await getAiVisibilitySettings(tenant.id);

    expect(settings.engines).toEqual(["openai"]);
  });

  it("falls back to a sane value for a cadence or sample count the row should not hold", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: tenant.id, cadence: "daily", samplesPerPrompt: 7, dayOfWeek: 9 });

    const settings = await getAiVisibilitySettings(tenant.id);

    expect(settings.cadence).toBe("weekly");
    expect(settings.samplesPerPrompt).toBe(3);
    expect(settings.dayOfWeek).toBe(1);
  });
});

describe("saveAiVisibilitySettings", () => {
  it("inserts on first save and updates on the second, without creating a second row", async () => {
    const tenant = await seedTenant(TENANT);

    const first = await saveAiVisibilitySettings(tenant.id, VALID);
    expect(first.ok).toBe(true);

    const second = await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 12 });
    expect(second.ok).toBe(true);

    const rows = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].monthlyCapUsd).toBe(12);
    expect(rows[0].engines).toEqual(["openai", "gemini"]);
  });

  it("never touches `enabled` — that switch lives on the company card", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, enabled: true });

    await saveAiVisibilitySettings(tenant.id, VALID);

    const [row] = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(row.enabled).toBe(true);
  });

  it("rejects each field it validates, naming the field", async () => {
    const tenant = await seedTenant(TENANT);

    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, cadence: "daily" })).toEqual({
      ok: false,
      error: "cadence",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek: 7 })).toEqual({
      ok: false,
      error: "dayOfWeek",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, samplesPerPrompt: 2 })).toEqual({
      ok: false,
      error: "samplesPerPrompt",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 0 })).toEqual({
      ok: false,
      error: "monthlyCapUsd",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 501 })).toEqual({
      ok: false,
      error: "monthlyCapUsd",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, engines: ["openai", "bing"] })).toEqual({
      ok: false,
      error: "engines",
    });
    // Empty is not a subset we accept: an enabled feature with zero engines
    // would silently measure nothing. "Stop running" is cadence "off".
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, engines: [] })).toEqual({
      ok: false,
      error: "engines",
    });
    expect(await saveAiVisibilitySettings(tenant.id, null)).toEqual({ ok: false, error: "cadence" });

    const rows = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("accepts a numeric string from a form field", async () => {
    const tenant = await seedTenant(TENANT);

    const result = await saveAiVisibilitySettings(tenant.id, {
      ...VALID,
      dayOfWeek: "3",
      samplesPerPrompt: "5",
      monthlyCapUsd: "45",
    });

    expect(result).toEqual({
      ok: true,
      settings: {
        enabled: false,
        cadence: "fortnightly",
        dayOfWeek: 3,
        engines: ["openai", "gemini"],
        samplesPerPrompt: 5,
        monthlyCapUsd: 45,
      },
    });
  });
});

describe("ensureAiVisibilitySource", () => {
  it("creates exactly one url-less source per tenant, however often it is called", async () => {
    const tenant = await seedTenant(TENANT);

    const first = await ensureAiVisibilitySource(tenant.id);
    const second = await ensureAiVisibilitySource(tenant.id);

    expect(second.id).toBe(first.id);
    expect(first.type).toBe("ai_visibility");
    expect(first.url).toBeNull();
    expect(first.label).toBe("AI visibility");

    const rows = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(rows).toHaveLength(1);
  });

  it("does not collide with the tenant's url-less news source", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(sources)
      .values({ tenantId: tenant.id, type: "news", url: null, label: "Industry news" });

    const source = await ensureAiVisibilitySource(tenant.id);

    expect(source.type).toBe("ai_visibility");
    const rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
  });
});

describe("setAiVisibilityEnabled", () => {
  it("turning it on creates the settings row and an active source", async () => {
    const tenant = await seedTenant(TENANT);

    await setAiVisibilityEnabled(tenant.id, true);

    expect((await getAiVisibilitySettings(tenant.id)).enabled).toBe(true);
    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("active");
  });

  it("turning it off disables the source but keeps it, and keeps the settings", async () => {
    const tenant = await seedTenant(TENANT);
    await saveAiVisibilitySettings(tenant.id, VALID);
    await setAiVisibilityEnabled(tenant.id, true);

    await setAiVisibilityEnabled(tenant.id, false);

    const settings = await getAiVisibilitySettings(tenant.id);
    expect(settings.enabled).toBe(false);
    expect(settings.engines).toEqual(["openai", "gemini"]);
    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("disabled");
  });

  it("re-enabling clears a stale error, disabling leaves it on screen", async () => {
    const tenant = await seedTenant(TENANT);
    await setAiVisibilityEnabled(tenant.id, true);
    await db
      .update(sources)
      .set({ status: "failing", lastError: "Paused — monthly cap reached" })
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));

    await setAiVisibilityEnabled(tenant.id, false);
    const [afterOff] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(afterOff.lastError).toBe("Paused — monthly cap reached");

    await setAiVisibilityEnabled(tenant.id, true);
    const [afterOn] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(afterOn.lastError).toBeNull();
    expect(afterOn.status).toBe("active");
  });
});
