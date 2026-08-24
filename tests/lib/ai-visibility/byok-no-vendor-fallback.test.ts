import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityEngineKeyEvents,
  aiVisibilityEngineKeys,
  aiVisibilityPrompts,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import { askAnthropic } from "../../../src/lib/ai-visibility/engines/anthropic";
import { askGemini } from "../../../src/lib/ai-visibility/engines/gemini";
import { askOpenAi } from "../../../src/lib/ai-visibility/engines/openai";
import { ENGINE_KEY_ENV_VAR, resolveEngineKey } from "../../../src/lib/ai-visibility/engines/shape";
import { effectiveEngines } from "../../../src/lib/ai-visibility/engine-keys";
import { getAiVisibilitySettings } from "../../../src/lib/ai-visibility/settings";
import { ENGINE_IDS } from "../../../src/lib/ai-visibility/types";
import { planRun, runSlice } from "../../../src/lib/ai-visibility/run";
import type { EngineClient } from "../../../src/lib/ai-visibility/types";
import { seedTenant, dropTenant, seedEngineKey } from "../../helpers/fixtures";

/**
 * The hard gate, asserted where it can actually be broken.
 *
 * The product decision is that there is no vendor-key fallback: a tenant with
 * no verified key does not sample that engine, and never on our account. Two
 * layers have to hold for that to be true, and each is a different mistake:
 *
 *  1. **The client** must send the key it was GIVEN. If `ask()` quietly read
 *     `process.env` when handed a tenant key, every BYOK call would be billed
 *     to us and nothing on screen would differ.
 *  2. **The run** must never hand a client an absent key. `resolveEngineKey`
 *     falls back to the env var when `apiKey` is undefined — that is the
 *     local-development seam — so `runSlice` passing `undefined` for an engine
 *     whose row it could not read would reintroduce the fallback through the
 *     back door.
 *
 * The env vars below are stubbed to recognisable values on purpose: an
 * assertion that the tenant's key was sent is only worth anything when OUR key
 * was sitting right there to be sent instead.
 */

const TENANT = "AI Visibility BYOK Fallback Test Tenant";
const OUR_KEY = "sk-ours-must-never-be-sent";

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", OUR_KEY);
  vi.stubEnv("GEMINI_API_KEY", OUR_KEY);
  vi.stubEnv("ANTHROPIC_API_KEY", OUR_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await dropTenant(TENANT);
});

/** Captures the headers a client sends, and answers with a minimal valid body. */
function capturingFetch(body: unknown) {
  const seen: Headers[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(new Headers(init.headers));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("engine clients take the key as an argument", () => {
  it("openai sends the caller's key, not ours", async () => {
    const { fetchImpl, seen } = capturingFetch({
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "an answer" }] }],
    });

    await askOpenAi("x", { fetchImpl, apiKey: "sk-theirs-1234" });

    expect(seen[0].get("authorization")).toBe("Bearer sk-theirs-1234");
    expect(seen[0].get("authorization")).not.toContain(OUR_KEY);
  });

  it("gemini sends the caller's key, not ours", async () => {
    const { fetchImpl, seen } = capturingFetch({
      modelVersion: "gemini-3-pro",
      candidates: [{ content: { parts: [{ text: "an answer" }] } }],
    });

    await askGemini("x", { fetchImpl, apiKey: "AIza-theirs-1234" });

    expect(seen[0].get("x-goog-api-key")).toBe("AIza-theirs-1234");
  });

  it("anthropic sends the caller's key, not ours", async () => {
    const { fetchImpl, seen } = capturingFetch({
      model: "claude-sonnet-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "an answer" }],
    });

    await askAnthropic("x", { fetchImpl, apiKey: "sk-ant-theirs-1234" });

    expect(seen[0].get("x-api-key")).toBe("sk-ant-theirs-1234");
  });

  it("an EMPTY key does not fall back to ours — it fails", async () => {
    // The dangerous case. `undefined` means "no caller opinion" and is the
    // local-dev seam; `""` means a caller looked for a key and found none, and
    // spending our money on that is the exact failure this whole file guards.
    const fetchImpl = vi.fn();

    expect(await askOpenAi("x", { fetchImpl: fetchImpl as never, apiKey: "" })).toMatchObject({
      code: "invalid_key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an ABSENT key still reads the env var — the local-development seam", async () => {
    // Kept deliberately, and narrowly: a developer must be able to exercise a
    // client from a script without seeding an encrypted row. The run path never
    // takes this branch, which is what the runSlice tests below pin.
    const { fetchImpl, seen } = capturingFetch({
      model: "gpt-5.5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "an answer" }] }],
    });

    await askOpenAi("x", { fetchImpl });

    expect(seen[0].get("authorization")).toBe(`Bearer ${OUR_KEY}`);
  });
});

describe("runSlice never falls back to a vendor key", () => {
  async function plannedTenant() {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      engines: ["openai"],
      samplesPerPrompt: 1,
      monthlyCapUsd: 20,
    });
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best issue tracker for startups",
      intent: "discovery",
      origin: "generated",
      status: "active",
    });
    return tenant;
  }

  /** Records the key each `ask` was handed, and answers successfully. */
  function recordingClient(seen: (string | undefined)[]): EngineClient {
    return {
      id: "openai",
      label: "openai (recording)",
      ask: async (_prompt, deps) => {
        seen.push(deps?.apiKey);
        return {
          text: "an answer",
          modelId: "gpt-5.5",
          citations: [],
          searchUsed: false,
          searchQueries: [],
          raw: {},
          costUsd: 0.25,
        };
      },
    };
  }

  it("hands the client the tenant's own decrypted key", async () => {
    const tenant = await plannedTenant();
    const { key } = await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    const seen: (string | undefined)[] = [];
    await runSlice(
      planned.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date() },
      { database: db, engines: { openai: recordingClient(seen) }, extract: async () => {} }
    );

    expect(seen).toEqual([key]);
    // The run stamped the key as used — the Cloudflare "last used" column.
    const [row] = await db
      .select()
      .from(aiVisibilityEngineKeys)
      .where(eq(aiVisibilityEngineKeys.tenantId, tenant.id));
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("never calls an engine whose key row vanished mid-run — the migration case", async () => {
    // A run planned before this table existed, or before the tenant removed a
    // key, reaches `runSlice` with pending rows and no credential. It must
    // record a failure, not borrow ours.
    const tenant = await plannedTenant();
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
    await db.delete(aiVisibilityEngineKeys).where(eq(aiVisibilityEngineKeys.tenantId, tenant.id));

    const seen: (string | undefined)[] = [];
    await runSlice(
      planned.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date() },
      { database: db, engines: { openai: recordingClient(seen) }, extract: async () => {} }
    );

    expect(seen).toEqual([]);
    const samples = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, planned.runId));
    expect(samples.every((sample) => sample.status === "error")).toBe(true);
    expect(samples[0].error).toContain("No ChatGPT key is connected");
    // Not one cent, and not one call.
    expect(samples.every((sample) => sample.costUsd === 0)).toBe(true);
  });

  it("says the key is UNREADABLE rather than invalid when decryption fails", async () => {
    // Zed's bug: a keychain failure surfaced as "invalid or has expired" and
    // users replaced keys that were fine. The fault is in OUR key material and
    // the sentence has to say so — a fifth state, never collapsed into the
    // fourth.
    const tenant = await plannedTenant();
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
    // Corrupt the auth tag: GCM verifies it on `final()`, so this is exactly
    // what a rotated `CREDENTIALS_ENCRYPTION_KEY` or a restored backup looks
    // like from here.
    await db
      .update(aiVisibilityEngineKeys)
      .set({ keyAuthTag: "00000000000000000000000000000000" })
      .where(eq(aiVisibilityEngineKeys.tenantId, tenant.id));

    const seen: (string | undefined)[] = [];
    await runSlice(
      planned.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date() },
      { database: db, engines: { openai: recordingClient(seen) }, extract: async () => {} }
    );

    expect(seen).toEqual([]);
    const [sample] = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, planned.runId));
    expect(sample.error).toContain("could not be read");
    expect(sample.error).toContain("not with your key");
    expect(sample.error).not.toContain("rejected");
  });

  it("flips the key row and stops asking when the provider rejects the key", async () => {
    const tenant = await plannedTenant();
    // Two prompts so there is a second sample left to NOT ask after the first
    // one comes back rejected.
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best issue tracker for small teams",
      intent: "discovery",
      origin: "generated",
      status: "active",
    });
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    let asked = 0;
    const rejecting: EngineClient = {
      id: "openai",
      label: "openai (rejecting)",
      ask: async () => {
        asked += 1;
        return {
          kind: "error" as const,
          code: "invalid_key" as const,
          message: "ChatGPT rejected the API key.",
        };
      },
    };

    await runSlice(
      planned.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date() },
      { database: db, engines: { openai: rejecting }, extract: async () => {} }
    );

    // Asked once. The second sample found the row already flipped out of
    // `verified` and was never sent — a rejected key must not be retried across
    // an entire work list at the tenant's expense.
    expect(asked).toBe(1);

    const [row] = await db
      .select()
      .from(aiVisibilityEngineKeys)
      .where(eq(aiVisibilityEngineKeys.tenantId, tenant.id));
    expect(row.status).toBe("invalid_key");
    expect(row.lastFailureCode).toBe("invalid_key");
    // The tenant's own switch is UNTOUCHED. A provider verdict must not leave
    // someone looking at a control reporting a choice they did not make, and
    // the row has to stay on and present for a Re-check to mean "resume".
    expect(row.enabled).toBe(true);
  });

  it("does NOT flip the key over a throughput 429 — that is the account working as sold", async () => {
    const tenant = await plannedTenant();
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    const limited: EngineClient = {
      id: "openai",
      label: "openai (429)",
      ask: async () => ({
        kind: "error" as const,
        code: "rate_limited" as const,
        message: "OpenAI is rate-limiting this key.",
        retryable: true as const,
      }),
    };

    // Three attempts, so the sample exhausts its ladder and the failure becomes
    // terminal — the moment a status flip would happen if the split were wrong.
    for (let i = 0; i < 3; i++) {
      await runSlice(
        planned.runId,
        // The clock walks past the backoff so each slice actually re-picks the row.
        { budgetMs: 60_000, concurrency: 1, now: () => new Date(Date.now() + i * 120_000) },
        { database: db, engines: { openai: limited }, extract: async () => {} }
      );
    }

    const [row] = await db
      .select()
      .from(aiVisibilityEngineKeys)
      .where(eq(aiVisibilityEngineKeys.tenantId, tenant.id));
    // Recorded, so a badge can say "rate-limited on the 24 Aug run"…
    expect(row.lastFailureCode).toBe("rate_limited");
    // …but still usable. Taking a paid, working engine off the board over a
    // Tier 1 throughput limit is a self-inflicted outage.
    expect(row.status).toBe("verified");
    expect(row.enabled).toBe(true);
  });
});

/**
 * `resolveEngineKey` is the hinge the whole hard gate turns on, and the
 * absent-vs-empty distinction inside it is the subtle half.
 *
 * `undefined` means "the caller has no opinion" — the local-development seam,
 * so a script or a client test can run without seeding an encrypted row.
 * `""` means "a caller went looking for a key and came back with nothing", and
 * quietly substituting OUR key for that is the exact failure BYOK exists to
 * prevent: every call billed to us, nothing different on screen.
 *
 * Tested here directly, per engine, rather than only through `askOpenAi`: the
 * three clients each call this with their own engine id, and a lookup table
 * that returned the wrong env var — or a `??` where a `!== undefined` belongs —
 * would be invisible from a test that only ever exercises one of them.
 */
describe("resolveEngineKey — absent is not empty", () => {
  const OURS = { openai: "sk-ours-openai", gemini: "AIza-ours-gemini", anthropic: "sk-ant-ours" };

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", OURS.openai);
    vi.stubEnv("GEMINI_API_KEY", OURS.gemini);
    vi.stubEnv("ANTHROPIC_API_KEY", OURS.anthropic);
  });

  for (const engine of ENGINE_IDS) {
    it(`${engine}: an EMPTY key is null — never the env var`, () => {
      expect(resolveEngineKey(engine, "")).toBeNull();
      // Whitespace is empty too: people paste a trailing newline, and a key
      // that trims to nothing must fail rather than silently become ours.
      expect(resolveEngineKey(engine, "   ")).toBeNull();
      expect(resolveEngineKey(engine, "\n")).toBeNull();
    });

    it(`${engine}: an ABSENT key reads its OWN env var — the local-dev seam`, () => {
      expect(resolveEngineKey(engine, undefined)).toBe(OURS[engine]);
      // And the right one. A transposed lookup table would send an OpenAI key
      // to Anthropic and read as "invalid key" forever.
      expect(process.env[ENGINE_KEY_ENV_VAR[engine]]).toBe(OURS[engine]);
    });

    it(`${engine}: a supplied key wins, trimmed`, () => {
      expect(resolveEngineKey(engine, `  theirs-${engine}\n`)).toBe(`theirs-${engine}`);
    });

    it(`${engine}: no key and no env var is null, not an empty string sent as auth`, () => {
      vi.stubEnv(ENGINE_KEY_ENV_VAR[engine], "");
      expect(resolveEngineKey(engine, undefined)).toBeNull();
    });
  }
});

/**
 * The state every existing tenant is in on the day migration 0075 lands.
 *
 * `DEFAULT_AI_VISIBILITY_SETTINGS.engines` is all three and nothing rewrites a
 * tenant's row, so the shipped shape is: three engines switched on, zero key
 * rows. Everything downstream has to resolve that to "measure nothing, and say
 * why" rather than to "measure everything on our card".
 *
 * Also pinned here are the two properties the migration itself provides, which
 * no other test asserts: the unique index that makes one key per engine per
 * tenant a database rule rather than a convention, and the cascade that takes
 * the ciphertext with the tenant.
 */
describe("migration 0075 against the shape that already exists", () => {
  const OTHER = "AI Visibility BYOK Neighbour Tenant";

  afterEach(async () => {
    await dropTenant(OTHER);
  });

  it("a tenant that has never touched settings has three engines on and zero keys", async () => {
    const tenant = await seedTenant(TENANT);

    // No settings row and no key rows — the literal ship-day state.
    expect(
      await db
        .select()
        .from(aiVisibilityEngineKeys)
        .where(eq(aiVisibilityEngineKeys.tenantId, tenant.id))
    ).toEqual([]);

    const settings = await getAiVisibilitySettings(tenant.id);
    expect(settings.engines).toEqual(["openai", "gemini", "anthropic"]);
    // …and the intersection is empty, with no fallback to the three above it.
    expect(await effectiveEngines(tenant.id, settings.engines)).toEqual([]);
  });

  it("one key per engine per tenant is a database rule, not a convention", async () => {
    const tenant = await seedTenant(TENANT);
    await seedEngineKey(tenant.id, "openai");

    // A second row for the same pair is what `storeEngineKey`'s
    // `onConflictDoUpdate` relies on; without the unique index it would insert
    // a duplicate instead, and `loadEngineKeySecret`'s `limit(1)` would pick
    // whichever the planner felt like.
    await expect(
      db.insert(aiVisibilityEngineKeys).values({
        tenantId: tenant.id,
        engine: "openai",
        keyCiphertext: "x",
        keyIv: "y",
        keyAuthTag: "z",
        last4: "0000",
      })
    ).rejects.toThrow();
  });

  it("a neighbour's key is not this tenant's key", async () => {
    const tenant = await seedTenant(TENANT);
    const other = await seedTenant(OTHER);
    await seedEngineKey(other.id, "openai");

    expect(await effectiveEngines(tenant.id, ["openai", "gemini", "anthropic"])).toEqual([]);
    expect(await effectiveEngines(other.id, ["openai", "gemini", "anthropic"])).toEqual(["openai"]);
  });

  it("deleting a tenant takes its ciphertext with it", async () => {
    // ON DELETE cascade, and the reason it matters: a key row orphaned by a
    // deleted workspace is a customer secret we are still holding after they
    // asked us to stop.
    const other = await seedTenant(OTHER);
    await seedEngineKey(other.id, "openai");

    await dropTenant(OTHER);

    expect(
      await db
        .select()
        .from(aiVisibilityEngineKeys)
        .where(eq(aiVisibilityEngineKeys.tenantId, other.id))
    ).toEqual([]);
  });
});

/**
 * The money half: what a tenant is QUOTED and gated on is what will actually
 * run, not what their settings row happens to name.
 *
 * The design's own worked example — "a tenant with `engines: [openai, gemini,
 * anthropic]` and one Gemini key runs Gemini, is quoted Gemini's price, and
 * sees one tile" — has a sharp edge on the cap: at three engines this run is
 * $2.49 and refused against a $1 budget; at the one engine that can actually
 * answer it is $0.41 and fine. Pricing the wrong list does not merely misquote,
 * it stops the run.
 */
describe("the cap is charged for the engines that will run, not the ones named", () => {
  it("plans a run the three-engine price would have refused", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      engines: ["openai", "gemini", "anthropic"],
      samplesPerPrompt: 3,
      // 2 prompts x 3 samples = 6 calls per engine. All three = $2.49; Gemini
      // alone = $0.414. The budget sits deliberately between the two.
      monthlyCapUsd: 1,
    });
    for (const text of ["best issue tracker for startups", "best issue tracker for small teams"]) {
      await db.insert(aiVisibilityPrompts).values({
        tenantId: tenant.id,
        text,
        intent: "discovery",
        origin: "generated",
        status: "active",
      });
    }
    await seedEngineKey(tenant.id, "gemini");

    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });

    // Priced at what runs. Reading `settings.engines` here would refuse this
    // tenant's run for spend on two engines they cannot use and are not billed
    // for — our estimate closing their budget over calls nobody will make.
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
    const samples = await db
      .select()
      .from(aiVisibilitySamples)
      .where(eq(aiVisibilitySamples.runId, planned.runId));
    expect(new Set(samples.map((sample) => sample.engine))).toEqual(new Set(["gemini"]));
    expect(samples).toHaveLength(6);
  });

  it("still refuses when even the keyed engine cannot fit the budget", async () => {
    // The gate did not stop being a gate. Same tenant, same one key, a budget
    // below Gemini's own price.
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      engines: ["openai", "gemini", "anthropic"],
      samplesPerPrompt: 3,
      monthlyCapUsd: 1,
    });
    for (let i = 0; i < 6; i++) {
      await db.insert(aiVisibilityPrompts).values({
        tenantId: tenant.id,
        text: `best issue tracker variant ${i}`,
        intent: "discovery",
        origin: "generated",
        status: "active",
      });
    }
    await seedEngineKey(tenant.id, "gemini");

    // 6 prompts x 3 samples x $0.069 = $1.242, over a $1 budget.
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });

    expect(planned.ok).toBe(false);
    if (planned.ok) throw new Error("unreachable");
    expect(planned.reason).toBe("cap_reached");
  });
});

/**
 * A run's own verdict is an audited write too.
 *
 * The four Server Actions have an actor; this one does not, and that is the
 * point — `actorUserId: null` is how the trail distinguishes "a colleague
 * removed the key" from "the 24 Aug run found it rejected". Without the line at
 * all, a tenant coming back to a switched-off engine has no way to learn which
 * of those happened.
 */
describe("a run writes its verdict into the audit trail", () => {
  it("records `auto_failed` with no actor when the provider rejects the key", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      engines: ["openai"],
      samplesPerPrompt: 1,
      monthlyCapUsd: 20,
    });
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best issue tracker for startups",
      intent: "discovery",
      origin: "generated",
      status: "active",
    });
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    await runSlice(
      planned.runId,
      { budgetMs: 60_000, concurrency: 1, now: () => new Date() },
      {
        database: db,
        engines: {
          openai: {
            id: "openai",
            label: "openai (out of credit)",
            ask: async () => ({
              kind: "error" as const,
              code: "quota_exceeded" as const,
              message: "The key is valid, but the account is out of credit.",
            }),
          },
        },
        extract: async () => {},
      }
    );

    const trail = await db
      .select()
      .from(aiVisibilityEngineKeyEvents)
      .where(eq(aiVisibilityEngineKeyEvents.tenantId, tenant.id));
    expect(trail.map((entry) => entry.action)).toEqual(["auto_failed"]);
    expect(trail[0].status).toBe("quota_exceeded");
    // Nobody did this. A run is not a person, and pinning it on the last owner
    // to touch the key would be the trail lying about who to ask.
    expect(trail[0].actorUserId).toBeNull();
  });

  it("does NOT write an audit line for a throughput 429 — that changed no state", async () => {
    // `flipEngineKeyOnFailure` records `lastFailureCode` and returns without
    // touching the status, so there is no state change to audit. A line here
    // would make a busy Tier 1 account look like a security event.
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilitySettings).values({
      tenantId: tenant.id,
      enabled: true,
      engines: ["openai"],
      samplesPerPrompt: 1,
      monthlyCapUsd: 20,
    });
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best issue tracker for startups",
      intent: "discovery",
      origin: "generated",
      status: "active",
    });
    await seedEngineKey(tenant.id, "openai");
    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });
    if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);

    for (let i = 0; i < 3; i++) {
      await runSlice(
        planned.runId,
        { budgetMs: 60_000, concurrency: 1, now: () => new Date(Date.now() + i * 120_000) },
        {
          database: db,
          engines: {
            openai: {
              id: "openai",
              label: "openai (429)",
              ask: async () => ({
                kind: "error" as const,
                code: "rate_limited" as const,
                message: "OpenAI is rate-limiting this key.",
                retryable: true as const,
              }),
            },
          },
          extract: async () => {},
        }
      );
    }

    expect(
      await db
        .select()
        .from(aiVisibilityEngineKeyEvents)
        .where(eq(aiVisibilityEngineKeyEvents.tenantId, tenant.id))
    ).toEqual([]);
  });
});
