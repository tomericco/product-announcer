import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityEngineKeys,
  aiVisibilityPrompts,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import { askAnthropic } from "../../../src/lib/ai-visibility/engines/anthropic";
import { askGemini } from "../../../src/lib/ai-visibility/engines/gemini";
import { askOpenAi } from "../../../src/lib/ai-visibility/engines/openai";
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
