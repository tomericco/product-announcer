import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilitySettings,
  sources,
} from "../../../src/db/schema";
import { askOpenAi } from "../../../src/lib/ai-visibility/engines/openai";
import { askAnthropic } from "../../../src/lib/ai-visibility/engines/anthropic";
import { finalizeRun, planRun, runSlice } from "../../../src/lib/ai-visibility/run";
import type { EngineClient } from "../../../src/lib/ai-visibility/types";
import { seedTenant, dropTenant, seedEngineKey } from "../../helpers/fixtures";

/**
 * A provider's error body must not survive into the database.
 *
 * The bug this file pins down: `openai.ts` used to return
 * `` `openai ${status}: ${body.slice(0, 300)}` ``, `runSlice` wrote that to
 * `ai_visibility_samples.error`, `finalizeRun` summarised it onto
 * `sources.lastError`, and the overview page interpolated it into a tile. An
 * OpenAI 401 body quotes the submitted key's prefix and its last four
 * characters; the organization variant quotes the org id. Today that is our
 * key. Under BYOK it is a customer's secret in two unencrypted columns and on
 * a page anyone in the workspace can open. LiteLLM shipped this shape and it
 * became CVE-2025-0330, CVSS 7.5.
 *
 * Every assertion below is about an ABSENCE. Asserting that the code came out
 * right would pass against an implementation that also appended the body.
 *
 * The engines here are the REAL clients with a fake `fetch` — a stubbed
 * `EngineClient` returning a tidy string would test the fake, and the fake is
 * not what talks to OpenAI.
 */

const TENANT = "AI Visibility Error Sanitisation Test Tenant";

/** The 401 body OpenAI actually returns, key fragment and all. */
const OPENAI_401_BODY =
  '{"error":{"message":"Incorrect API key provided: sk-Eyftb****************************99vW. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}';

/** The organization variant — it leaks the tenant identifier instead. */
const OPENAI_ORG_401_BODY =
  '{"error":{"message":"No such organization: org-8Xk2mQpL9v.","type":"invalid_request_error","code":"invalid_organization"}}';

const SECRET_FRAGMENTS = ["sk-Eyftb", "99vW", "Incorrect API key"];
const ORG_FRAGMENTS = ["org-8Xk2mQpL9v", "No such organization"];

beforeEach(() => {
  // The bodies ARE logged, scrubbed — that is deliberate and covered in
  // `engines/failure.test.ts`. Silenced here so a security test does not print
  // a wall of provider errors on every run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await dropTenant(TENANT);
});

const frozen = (iso: string) => () => new Date(iso);

/** The real client, given a fetch that returns one canned non-2xx. */
function clientReturning(
  id: "openai" | "anthropic",
  body: string,
  status: number,
  headers: Record<string, string> = {}
): EngineClient {
  const fetchImpl = async () => new Response(body, { status, headers });
  const ask = id === "openai" ? askOpenAi : askAnthropic;
  return { id, label: `${id} (canned ${status})`, ask: (prompt) => ask(prompt, { fetchImpl }) };
}

async function plannedRun(engine: "openai" | "anthropic") {
  const tenant = await seedTenant(TENANT);
  await db.insert(aiVisibilitySettings).values({
    tenantId: tenant.id,
    enabled: true,
    engines: [engine],
    samplesPerPrompt: 1,
    monthlyCapUsd: 20,
  });
  // BYOK: a tenant with no verified key plans nothing at all, so every run
  // test now seeds one. The key here is a fake — the assertions below are
  // about the PROVIDER's body leaking, not this string.
  await seedEngineKey(tenant.id, engine);
  await db.insert(aiVisibilityPrompts).values({
    tenantId: tenant.id,
    text: "best issue tracker for startups",
    intent: "discovery",
    origin: "generated",
    status: "active",
  });
  const planned = await planRun(tenant.id, {
    trigger: "manual",
    now: frozen("2026-03-02T09:00:00Z"),
  });
  if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
  return { tenant, runId: planned.runId };
}

async function sampleErrors(runId: string) {
  const rows = await db
    .select({ error: aiVisibilitySamples.error, status: aiVisibilitySamples.status })
    .from(aiVisibilitySamples)
    .where(eq(aiVisibilitySamples.runId, runId));
  return rows;
}

async function sourceRow(tenantId: string) {
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "ai_visibility")));
  return row;
}

const noopJudge = async () => ({ judged: 0, flagged: 0, remaining: 0, budgetSpent: false, errors: [] });

async function finalize(runId: string) {
  await finalizeRun(
    runId,
    { budgetMs: 60_000, now: frozen("2026-03-02T09:10:00Z") },
    { judge: noopJudge, emit: async () => ({ written: 0, considered: 0 }) }
  );
}

describe("a provider error body never reaches storage", () => {
  it("an OpenAI 401 leaves no key fragment on the sample row", async () => {
    const { runId } = await plannedRun("openai");

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { openai: clientReturning("openai", OPENAI_401_BODY, 401) } }
    );

    const [sample] = await sampleErrors(runId);
    expect(sample.status).toBe("error");
    expect(sample.error).toBeTruthy();
    for (const fragment of SECRET_FRAGMENTS) {
      expect(sample.error).not.toContain(fragment);
    }
    // And it still SAYS something a person can act on.
    expect(sample.error).toContain("ChatGPT rejected the API key");
  });

  it("…nor on `sources.lastError`, which /company renders", async () => {
    const { tenant, runId } = await plannedRun("openai");

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { openai: clientReturning("openai", OPENAI_401_BODY, 401) } }
    );
    await finalize(runId);

    const source = await sourceRow(tenant.id);
    expect(source.lastError).toBeTruthy();
    for (const fragment of SECRET_FRAGMENTS) {
      expect(source.lastError).not.toContain(fragment);
    }
    // The summary sentence itself is intact — this is redaction of the
    // provider's words, not suppression of ours.
    expect(source.lastError).toContain("openai failed on 1 of 1 calls");

    // The run row is the third copy, and it is what the header reads.
    const [run] = await db
      .select()
      .from(aiVisibilityRuns)
      .where(eq(aiVisibilityRuns.id, runId));
    for (const fragment of SECRET_FRAGMENTS) {
      expect(run.error).not.toContain(fragment);
    }
  });

  it("the organization variant leaks no tenant identifier either", async () => {
    const { tenant, runId } = await plannedRun("openai");

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { openai: clientReturning("openai", OPENAI_ORG_401_BODY, 401) } }
    );
    await finalize(runId);

    const [sample] = await sampleErrors(runId);
    const source = await sourceRow(tenant.id);
    for (const fragment of ORG_FRAGMENTS) {
      expect(sample.error).not.toContain(fragment);
      expect(source.lastError).not.toContain(fragment);
    }
  });

  it("an Anthropic 401 leaks neither its body nor `anthropic-organization-id`", async () => {
    // The organization id lives in a RESPONSE HEADER on this API, which is why
    // nothing in the client reads the header bag wholesale.
    const { tenant, runId } = await plannedRun("anthropic");
    const client = clientReturning(
      "anthropic",
      '{"error":{"type":"authentication_error","message":"invalid x-api-key: sk-ant-api03-LEAKED123"}}',
      401,
      { "anthropic-organization-id": "org-01ABCDEF", "request-id": "req_011CX" }
    );

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { anthropic: client } }
    );
    await finalize(runId);

    const [sample] = await sampleErrors(runId);
    const source = await sourceRow(tenant.id);
    for (const stored of [sample.error, source.lastError]) {
      expect(stored).not.toContain("sk-ant-api03-LEAKED123");
      expect(stored).not.toContain("invalid x-api-key");
      expect(stored).not.toContain("org-01ABCDEF");
    }
    // The request id is kept on purpose: not a secret, and the only handle
    // Anthropic support can act on.
    expect(sample.error).toContain("req_011CX");
  });

  it("a client that returns a raw body anyway is scrubbed at the write", async () => {
    // Clients are injectable, so "the client promised" is not a property the
    // write can rely on. This is the last gate before the string is durable.
    const { tenant, runId } = await plannedRun("openai");
    const rogue: EngineClient = {
      id: "openai",
      label: "openai (rogue)",
      ask: async () => ({
        kind: "error",
        code: "invalid_key",
        message: "openai 401: Incorrect API key provided: sk-Eyftb****************99vW.",
      }),
    };

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { openai: rogue } }
    );
    await finalize(runId);

    const [sample] = await sampleErrors(runId);
    const source = await sourceRow(tenant.id);
    for (const stored of [sample.error, source.lastError]) {
      expect(stored).not.toContain("sk-Eyftb");
      expect(stored).not.toContain("99vW");
    }
  });

  it("a client that THROWS a provider error is scrubbed too", async () => {
    // `ask()` promises never to throw, but a fetch or SDK error that escapes it
    // stringifies with the failing request attached — headers included.
    const { runId } = await plannedRun("openai");
    const thrower: EngineClient = {
      id: "openai",
      label: "openai (thrower)",
      ask: async () => {
        throw new Error("POST https://api.openai.com/v1/responses [Bearer sk-proj-LEAKED9876]");
      },
    };

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now: frozen("2026-03-02T09:00:00Z") },
      { engines: { openai: thrower } }
    );

    const [sample] = await sampleErrors(runId);
    expect(sample.status).toBe("error");
    expect(sample.error).not.toContain("sk-proj-LEAKED9876");
  });
});
