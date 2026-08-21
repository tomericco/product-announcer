import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { aiVisibilityRuns, aiVisibilitySettings, sources } from "../../../src/db/schema";
import {
  getAiVisibilitySettings,
  getAiVisibilitySettingsForTenants,
  saveAiVisibilitySettings,
  ensureAiVisibilitySource,
  setAiVisibilityEnabled,
  DEFAULT_AI_VISIBILITY_SETTINGS,
  MIN_MONTHLY_CAP_USD,
  MAX_MONTHLY_CAP_USD,
} from "../../../src/lib/ai-visibility/settings";
import { capPausedMessage } from "../../../src/lib/ai-visibility/cost";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Settings Test Tenant";
/**
 * The isolation cases need a second workspace. Named off the first so the two
 * stay unique to this file — `dropTenant` deletes by name against a shared
 * Postgres, so a generic "Other Tenant" would collide with another file.
 */
const OTHER_TENANT = "AI Visibility Settings Test Tenant (Other)";

afterEach(async () => {
  await dropTenant(TENANT);
  await dropTenant(OTHER_TENANT);
});

async function aiVisibilitySource(tenantId: string) {
  return db
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "ai_visibility")));
}

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

  it("falls back to every supported engine when filtering leaves none", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: tenant.id, engines: ["bing_copilot"] });

    // `saveAiVisibilitySettings` refuses to write an empty list, so the read
    // must not invent one either.
    expect((await getAiVisibilitySettings(tenant.id)).engines).toEqual([
      "openai",
      "perplexity",
      "gemini",
      "anthropic",
    ]);
  });

  it("round-trips a cap with cents, and clamps one out of range", async () => {
    const tenant = await seedTenant(TENANT);
    await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 20.1 });

    // float4 stores this approximately, but Postgres prints the shortest
    // decimal that round-trips, so it comes back exact. The `roundUsd` on the
    // read path is there for the float4 ARITHMETIC in the cost gate (see
    // `money.ts`); on a stored scalar like this one it is a no-op, and this
    // case exists to pin that the read does not mangle a legitimate cap.
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(20.1);

    await db
      .update(aiVisibilitySettings)
      .set({ monthlyCapUsd: 9999 })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(500);
  });

  it("rounds a sub-cent cap on the way in, so the saved value equals the value read back", async () => {
    const tenant = await seedTenant(TENANT);

    // The write path validates the cap but used to store it unrounded while
    // the read path rounded it, so the settings card showed 20.999 right after
    // saving and 21 on the next load. Both sides must agree.
    const saved = await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 20.999 });
    expect(saved.ok).toBe(true);

    const read = await getAiVisibilitySettings(tenant.id);
    expect(read.monthlyCapUsd).toBe(21);
    if (saved.ok) expect(saved.settings.monthlyCapUsd).toBe(read.monthlyCapUsd);
  });

  it("dedupes engine ids on read, so a hand-written row cannot double an engine's calls", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: tenant.id, engines: ["openai", "openai", "gemini"] });

    // planRun fans out over this array; a duplicate would plan that engine twice.
    expect((await getAiVisibilitySettings(tenant.id)).engines).toEqual(["openai", "gemini"]);
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

  it("falls back for a negative dayOfWeek, not only an over-large one", async () => {
    const tenant = await seedTenant(TENANT);
    // The read clamps at both ends of 0..6. Only the upper end was pinned, so
    // a `row.dayOfWeek >= 0` that got dropped would have gone unnoticed.
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, dayOfWeek: -1 });

    expect((await getAiVisibilitySettings(tenant.id)).dayOfWeek).toBe(1);
  });

  it("keeps the legal edges of dayOfWeek — Sunday and Saturday are not fallbacks", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, dayOfWeek: 0 });
    expect((await getAiVisibilitySettings(tenant.id)).dayOfWeek).toBe(0);

    await db
      .update(aiVisibilitySettings)
      .set({ dayOfWeek: 6 })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect((await getAiVisibilitySettings(tenant.id)).dayOfWeek).toBe(6);
  });

  it("clamps a cap below the floor as well as one above the ceiling", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, monthlyCapUsd: 0 });

    // A zero cap would pause every run the moment the first sample cost
    // anything; the floor is what stops a hand-edited row doing that silently.
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(MIN_MONTHLY_CAP_USD);
  });

  it("passes the legal cap edges through untouched", async () => {
    const tenant = await seedTenant(TENANT);
    await db
      .insert(aiVisibilitySettings)
      .values({ tenantId: tenant.id, monthlyCapUsd: MIN_MONTHLY_CAP_USD });
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(MIN_MONTHLY_CAP_USD);

    await db
      .update(aiVisibilitySettings)
      .set({ monthlyCapUsd: MAX_MONTHLY_CAP_USD })
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(MAX_MONTHLY_CAP_USD);
  });

  it("reads `enabled` back off the row rather than assuming the default", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, enabled: true });

    expect((await getAiVisibilitySettings(tenant.id)).enabled).toBe(true);
  });

  it("keeps a cadence of `off`, which is a setting and not a bad value", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({ tenantId: tenant.id, cadence: "off" });

    expect((await getAiVisibilitySettings(tenant.id)).cadence).toBe("off");
  });

  it("answers for one tenant without seeing the other's row", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    await saveAiVisibilitySettings(tenant.id, VALID);

    // The neighbour saved nothing, so it must still get the untouched defaults.
    expect(await getAiVisibilitySettings(other.id)).toEqual(DEFAULT_AI_VISIBILITY_SETTINGS);
    expect((await getAiVisibilitySettings(tenant.id)).engines).toEqual(["openai", "gemini"]);
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

  it("accepts both ends of dayOfWeek", async () => {
    const tenant = await seedTenant(TENANT);

    // 0 is Sunday and 6 is Saturday: both legal, and both the values an
    // off-by-one in the range check would reject.
    for (const dayOfWeek of [0, 6]) {
      const result = await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek });
      expect(result.ok).toBe(true);
      expect(result.ok && result.settings.dayOfWeek).toBe(dayOfWeek);
    }
  });

  it("accepts every sample count the spec offers", async () => {
    const tenant = await seedTenant(TENANT);

    for (const samplesPerPrompt of [1, 3, 5]) {
      const result = await saveAiVisibilitySettings(tenant.id, { ...VALID, samplesPerPrompt });
      expect(result.ok).toBe(true);
      expect(result.ok && result.settings.samplesPerPrompt).toBe(samplesPerPrompt);
    }
  });

  it("accepts a cap sitting exactly on the floor and on the ceiling", async () => {
    const tenant = await seedTenant(TENANT);

    // The bounds are inclusive — $1 and $500 are offered in the UI, so an
    // exclusive comparison would reject the two values a user is most likely
    // to pick from the ends of the range.
    for (const monthlyCapUsd of [MIN_MONTHLY_CAP_USD, MAX_MONTHLY_CAP_USD]) {
      const result = await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, settings: expect.objectContaining({ monthlyCapUsd }) })
      );
    }
  });

  it("accepts every cadence, including `off`", async () => {
    const tenant = await seedTenant(TENANT);

    for (const cadence of ["weekly", "fortnightly", "off"]) {
      const result = await saveAiVisibilitySettings(tenant.id, { ...VALID, cadence });
      expect(result.ok).toBe(true);
      expect(result.ok && result.settings.cadence).toBe(cadence);
    }
  });

  it("accepts one engine and accepts all four", async () => {
    const tenant = await seedTenant(TENANT);

    const one = await saveAiVisibilitySettings(tenant.id, { ...VALID, engines: ["perplexity"] });
    expect(one.ok && one.settings.engines).toEqual(["perplexity"]);

    const all = await saveAiVisibilitySettings(tenant.id, {
      ...VALID,
      engines: ["openai", "perplexity", "gemini", "anthropic"],
    });
    expect(all.ok && all.settings.engines).toEqual(["openai", "perplexity", "gemini", "anthropic"]);
  });

  it("collapses a repeated engine id rather than planning the call twice", async () => {
    const tenant = await seedTenant(TENANT);

    // A checkbox group that double-submits would otherwise double this
    // tenant's call count — and their bill — for that engine.
    const result = await saveAiVisibilitySettings(tenant.id, {
      ...VALID,
      engines: ["openai", "openai", "gemini"],
    });

    expect(result.ok && result.settings.engines).toEqual(["openai", "gemini"]);
    const [row] = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(row.engines).toEqual(["openai", "gemini"]);
  });

  it("rejects the shapes a form can produce that are not merely out of range", async () => {
    const tenant = await seedTenant(TENANT);

    // Missing keys — the whole point of taking `unknown`.
    expect(await saveAiVisibilitySettings(tenant.id, {})).toEqual({ ok: false, error: "cadence" });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek: undefined })).toEqual({
      ok: false,
      error: "dayOfWeek",
    });
    // A number where a cadence string belongs.
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, cadence: 1 })).toEqual({
      ok: false,
      error: "cadence",
    });
    // Fractional days have no meaning against `Date#getUTCDay()`.
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek: 3.5 })).toEqual({
      ok: false,
      error: "dayOfWeek",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek: -1 })).toEqual({
      ok: false,
      error: "dayOfWeek",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, dayOfWeek: "" })).toEqual({
      ok: false,
      error: "dayOfWeek",
    });
    // A single id rather than a list: `"openai".includes` would pass a naive check.
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, engines: "openai" })).toEqual({
      ok: false,
      error: "engines",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, engines: [0] })).toEqual({
      ok: false,
      error: "engines",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, samplesPerPrompt: null })).toEqual({
      ok: false,
      error: "samplesPerPrompt",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: "twenty" })).toEqual({
      ok: false,
      error: "monthlyCapUsd",
    });
    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: Number.NaN })).toEqual({
      ok: false,
      error: "monthlyCapUsd",
    });

    // Not one of them wrote a row.
    const rows = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("leaves a rejected save with the row it already had", async () => {
    const tenant = await seedTenant(TENANT);
    await saveAiVisibilitySettings(tenant.id, VALID);

    expect(await saveAiVisibilitySettings(tenant.id, { ...VALID, cadence: "daily" })).toEqual({
      ok: false,
      error: "cadence",
    });

    // A validation failure must not be a partial write: the surviving row is
    // the last good one, not a half-applied version of the rejected form.
    expect(await getAiVisibilitySettings(tenant.id)).toEqual({
      enabled: false,
      cadence: "fortnightly",
      dayOfWeek: 3,
      engines: ["openai", "gemini"],
      samplesPerPrompt: 5,
      monthlyCapUsd: 45,
    });
  });

  it("writes one tenant's settings without disturbing the other's", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);

    await saveAiVisibilitySettings(tenant.id, VALID);
    await saveAiVisibilitySettings(other.id, {
      ...VALID,
      cadence: "weekly",
      engines: ["anthropic"],
      monthlyCapUsd: 7,
    });

    expect((await getAiVisibilitySettings(tenant.id)).engines).toEqual(["openai", "gemini"]);
    expect((await getAiVisibilitySettings(tenant.id)).monthlyCapUsd).toBe(45);
    expect((await getAiVisibilitySettings(other.id)).engines).toEqual(["anthropic"]);
    expect((await getAiVisibilitySettings(other.id)).monthlyCapUsd).toBe(7);
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

  it("applies the overrides on the insert half of the upsert", async () => {
    const tenant = await seedTenant(TENANT);

    const source = await ensureAiVisibilitySource(tenant.id, db, {
      status: "failing",
      lastError: "OpenAI returned 429",
    });

    // The row did not exist, so these can only have come from the INSERT — the
    // whole point of taking overrides rather than making callers update after.
    expect(source.status).toBe("failing");
    expect(source.lastError).toBe("OpenAI returned 429");
  });

  it("applies the overrides on the conflict half too, on the same row", async () => {
    const tenant = await seedTenant(TENANT);
    const first = await ensureAiVisibilitySource(tenant.id);

    const second = await ensureAiVisibilitySource(tenant.id, db, {
      status: "failing",
      lastError: "Perplexity timed out",
    });

    expect(second.id).toBe(first.id);
    expect(second.status).toBe("failing");
    expect(second.lastError).toBe("Perplexity timed out");
  });

  it("leaves an existing row's health alone when called with no overrides", async () => {
    const tenant = await seedTenant(TENANT);
    await ensureAiVisibilitySource(tenant.id, db, { status: "failing", lastError: "Gemini 500" });

    // A plain `ensure` is "make sure the row is there", not "reset it": a run
    // that calls this on its way past must not erase the last failure the
    // operator is looking at.
    const again = await ensureAiVisibilitySource(tenant.id);

    expect(again.status).toBe("failing");
    expect(again.lastError).toBe("Gemini 500");
  });

  it("gives each tenant its own source row", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);

    const mine = await ensureAiVisibilitySource(tenant.id, db, { status: "failing" });
    const theirs = await ensureAiVisibilitySource(other.id);

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.status).toBe("active");
    expect((await aiVisibilitySource(tenant.id))[0].status).toBe("failing");
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

  it("creates the source already carrying its status, without a follow-up update", async () => {
    const tenant = await seedTenant(TENANT);

    // The row has never existed, so `disabled` can only have come from the
    // INSERT half of the upsert — proof the status is not a second statement.
    await setAiVisibilityEnabled(tenant.id, false);

    const [source] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.tenantId, tenant.id), eq(sources.type, "ai_visibility")));
    expect(source.status).toBe("disabled");
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

  it("survives on → off → on with one settings row, one source, and the settings intact", async () => {
    const tenant = await seedTenant(TENANT);
    await saveAiVisibilitySettings(tenant.id, VALID);

    await setAiVisibilityEnabled(tenant.id, true);
    await setAiVisibilityEnabled(tenant.id, false);
    await setAiVisibilityEnabled(tenant.id, true);

    // Both halves of "is this feature on" agree, and neither upsert has
    // accumulated a duplicate along the way.
    const settingsRows = await db
      .select()
      .from(aiVisibilitySettings)
      .where(eq(aiVisibilitySettings.tenantId, tenant.id));
    expect(settingsRows).toHaveLength(1);
    const sourceRows = await aiVisibilitySource(tenant.id);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].status).toBe("active");

    // Toggling is not a reset: the cadence, engines, samples and cap the
    // settings card wrote are all still what they were.
    expect(await getAiVisibilitySettings(tenant.id)).toEqual({
      enabled: true,
      cadence: "fortnightly",
      dayOfWeek: 3,
      engines: ["openai", "gemini"],
      samplesPerPrompt: 5,
      monthlyCapUsd: 45,
    });
  });

  it("toggles one tenant without touching the other's switch or badge", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER_TENANT);
    await setAiVisibilityEnabled(tenant.id, true);
    await setAiVisibilityEnabled(other.id, true);

    await setAiVisibilityEnabled(tenant.id, false);

    expect((await getAiVisibilitySettings(tenant.id)).enabled).toBe(false);
    expect((await aiVisibilitySource(tenant.id))[0].status).toBe("disabled");
    expect((await getAiVisibilitySettings(other.id)).enabled).toBe(true);
    expect((await aiVisibilitySource(other.id))[0].status).toBe("active");
  });
});

describe("getAiVisibilitySettingsForTenants", () => {
  it("reads many tenants in one query, and gives a tenant with no row the defaults", async () => {
    const withRow = await seedTenant(TENANT);
    const withoutRow = await seedTenant(OTHER_TENANT);
    await saveAiVisibilitySettings(withRow.id, VALID);

    const byTenant = await getAiVisibilitySettingsForTenants([withRow.id, withoutRow.id, withRow.id]);

    // Present, not absent: "no row" is a real state (the feature is off), and a
    // caller that had to distinguish a missing key from it would get it wrong.
    expect(byTenant.get(withoutRow.id)).toEqual(DEFAULT_AI_VISIBILITY_SETTINGS);
    expect(byTenant.get(withRow.id)).toEqual({
      enabled: false,
      cadence: "fortnightly",
      dayOfWeek: 3,
      engines: ["openai", "gemini"],
      samplesPerPrompt: 5,
      monthlyCapUsd: 45,
    });
  });

  it("agrees with the single-tenant read, coercions included", async () => {
    const tenant = await seedTenant(TENANT);
    // A hand-written row: an engine this build does not know, and a cadence
    // nobody can save. The batch read must coerce them exactly as the
    // single-tenant read does, or the sweep gates on a different reading of the
    // row than the settings card renders.
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      cadence: "hourly",
      dayOfWeek: 9,
      engines: ["bing"],
      samplesPerPrompt: 4,
      monthlyCapUsd: 20,
    });

    const byTenant = await getAiVisibilitySettingsForTenants([tenant.id]);

    expect(byTenant.get(tenant.id)).toEqual(await getAiVisibilitySettings(tenant.id));
  });

  it("does not query at all for an empty list", async () => {
    expect(await getAiVisibilitySettingsForTenants([])).toEqual(new Map());
  });
});

describe("saveAiVisibilitySettings and the cap pause", () => {
  const NOW = new Date("2026-03-10T09:00:00Z");
  const clock = () => NOW;

  async function seedCapPausedSource(tenantId: string, lastError: string) {
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        type: "ai_visibility",
        label: "AI visibility",
        status: "failing",
        lastError,
      })
      .returning();
    return source;
  }

  /** A finished run of a given cost, inside the month `NOW` falls in. */
  async function seedSpend(tenantId: string, sourceId: string, costUsd: number) {
    await db.insert(aiVisibilityRuns).values({
      tenantId,
      sourceId,
      trigger: "scheduled",
      engines: ["openai"],
      samplesPerPrompt: 3,
      status: "complete",
      startedAt: new Date("2026-03-04T09:00:00Z"),
      costUsd,
    });
  }

  it("clears the red badge when the new cap is above what the month has spent", async () => {
    const tenant = await seedTenant(TENANT);
    const source = await seedCapPausedSource(tenant.id, capPausedMessage(20, 20));
    await seedSpend(tenant.id, source.id, 20);

    await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 50 }, db, clock);

    const [row] = await aiVisibilitySource(tenant.id);
    expect(row.status).toBe("active");
    expect(row.lastError).toBeNull();
  });

  it("leaves the badge red when the new cap is still under the month's spend", async () => {
    const tenant = await seedTenant(TENANT);
    const source = await seedCapPausedSource(tenant.id, capPausedMessage(24, 20));
    await seedSpend(tenant.id, source.id, 24);

    await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 21 }, db, clock);

    const [row] = await aiVisibilitySource(tenant.id);
    expect(row.status).toBe("failing");
    expect(row.lastError).toContain("monthly cap");
  });

  it("never clears a failure that was not the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await seedCapPausedSource(tenant.id, "openai 429: rate limited");

    await saveAiVisibilitySettings(tenant.id, { ...VALID, monthlyCapUsd: 500 }, db, clock);

    const [row] = await aiVisibilitySource(tenant.id);
    expect(row.status).toBe("failing");
    expect(row.lastError).toBe("openai 429: rate limited");
  });

  it("does not create a source row for a tenant that has none", async () => {
    const tenant = await seedTenant(TENANT);

    await saveAiVisibilitySettings(tenant.id, VALID, db, clock);

    expect(await aiVisibilitySource(tenant.id)).toHaveLength(0);
  });
});
