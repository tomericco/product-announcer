import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import type { EngineAnswer, EngineClient, EngineError } from "../../../src/lib/ai-visibility/types";
import {
  MAX_SAMPLE_ATTEMPTS,
  planRun,
  runSlice,
  sampleBackoffMs,
} from "../../../src/lib/ai-visibility/run";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

/**
 * Retrying a transient engine failure.
 *
 * Its own file and its own tenant: the run suite is already long, and every
 * test here turns on the clock in a way the others do not — the whole point of
 * a backoff is that the same row behaves differently at two instants.
 */

const TENANT = "AI Visibility Retry Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

/**
 * A clock the test moves by hand.
 *
 * Every read steps a few ms, like the run suite's, so a slice's own budget
 * arithmetic still advances; `advance` is what jumps a backoff window. Nothing
 * here may read `Date.now()` — the backoff timestamps are written off the
 * injected clock and would otherwise be compared against a different one.
 */
function controllableClock(startIso: string, stepMs = 10) {
  let t = new Date(startIso).getTime();
  const clock = () => {
    const current = new Date(t);
    t += stepMs;
    return current;
  };
  return Object.assign(clock, {
    advance(ms: number) {
      t += ms;
    },
    peek() {
      return new Date(t);
    },
  });
}

function answer(overrides: Partial<EngineAnswer> = {}): EngineAnswer {
  return {
    text: "Acme and Rival are the usual picks.",
    modelId: "gpt-5.5-2026-04-23",
    citations: [],
    searchUsed: true,
    searchQueries: ["best issue tracker"],
    raw: { ok: true },
    costUsd: 0.01,
    ...overrides,
  };
}

function fakeEngine(
  reply: (call: number) => EngineAnswer | EngineError
): EngineClient & { calls: number } {
  const engine = {
    id: "openai" as const,
    label: "openai (fake)",
    calls: 0,
    async ask() {
      engine.calls += 1;
      return reply(engine.calls);
    },
  };
  return engine;
}

/** One prompt, one engine, one sample — so a single row's fate is the whole story. */
async function plannedOneSample(samplesPerPrompt = 1) {
  const tenant = await seedTenant(TENANT);
  await db.insert(aiVisibilitySettings).values({
    tenantId: tenant.id,
    enabled: true,
    engines: ["openai"],
    samplesPerPrompt,
    monthlyCapUsd: 20,
  });
  await db.insert(aiVisibilityPrompts).values({
    tenantId: tenant.id,
    text: "best issue tracker for startups",
    intent: "discovery",
    origin: "generated",
    status: "active",
  });
  const planned = await planRun(tenant.id, {
    trigger: "manual",
    now: () => new Date("2026-03-02T09:00:00Z"),
  });
  if (!planned.ok) throw new Error(`planRun refused: ${planned.reason}`);
  return { tenant, runId: planned.runId };
}

async function sampleRow(runId: string) {
  const [row] = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
  return row;
}

async function runRow(runId: string) {
  const [row] = await db.select().from(aiVisibilityRuns).where(eq(aiVisibilityRuns.id, runId));
  return row;
}

describe("runSlice — retrying a transient engine failure", () => {
  it("leaves a retryable failure pending, counted, and waiting on a backoff", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({ kind: "error", message: "openai 429: slow down", retryable: true }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    const row = await sampleRow(runId);
    // The whole change in one assertion: an errored sample used to be
    // terminal, and at n=15 per engine three of them drop that engine below
    // the trend chart's floor for the run.
    expect(row.status).toBe("pending");
    expect(row.askAttempts).toBe(1);
    expect(row.error).toContain("429");
    expect(row.nextAttemptAt).not.toBeNull();
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(new Date("2026-03-02T09:00:00Z").getTime());
    // Not finished, and not the budget's fault — the slice simply has nothing
    // it may hand out yet, so a later driver picks the row up.
    expect(outcome.remaining).toBe(1);
    expect(outcome.budgetSpent).toBe(false);
    expect((await runRow(runId)).status).toBe("running");
  });

  it("does NOT re-pick the row inside the same slice — the hot-loop guard", async () => {
    // Without the backoff filter on the batch query this is the failure mode:
    // the row is still `pending`, so the very next batch selects it again, the
    // identical 429 comes back, and the slice burns its whole budget on one
    // sample against a rate limit that has had no time to clear.
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({ kind: "error", message: "openai 429: slow down", retryable: true }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(1);
    expect(outcome.processed).toBe(1);
    expect(outcome.remaining).toBe(1);
    expect((await sampleRow(runId)).askAttempts).toBe(1);
  });

  it("retries on a later slice, once the backoff has elapsed", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine((call) =>
      call === 1 ? { kind: "error", message: "openai 503: unavailable", retryable: true } : answer()
    );
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    now.advance(sampleBackoffMs(1) + 1_000);
    const second = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(2);
    expect(second.remaining).toBe(0);
    const row = await sampleRow(runId);
    expect(row.status).toBe("ok");
    expect(row.answerText).toBe("Acme and Rival are the usual picks.");
    // Cleared on success, so nothing downstream ever sees a stale wait on a
    // row that is finished.
    expect(row.nextAttemptAt).toBeNull();
    expect(row.askAttempts).toBe(1);
  });

  it("a slice that arrives DURING the backoff hands out nothing and leaves the run resumable", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({ kind: "error", message: "openai 429: slow down", retryable: true }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    // A second driver arriving a second later, well inside the 30s wait.
    now.advance(1_000);
    const second = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(1);
    expect(second.processed).toBe(0);
    expect(second.remaining).toBe(1);
    expect(second.budgetSpent).toBe(false);
    expect((await runRow(runId)).status).toBe("running");
  });

  it("gives up at MAX_SAMPLE_ATTEMPTS and records the LAST message", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine((call) => ({
      kind: "error",
      message: `openai 429: attempt ${call}`,
      retryable: true,
    }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    for (let attempt = 1; attempt <= MAX_SAMPLE_ATTEMPTS; attempt += 1) {
      await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
      now.advance(sampleBackoffMs(attempt) + 1_000);
    }

    expect(engine.calls).toBe(MAX_SAMPLE_ATTEMPTS);
    const row = await sampleRow(runId);
    expect(row.status).toBe("error");
    expect(row.askAttempts).toBe(MAX_SAMPLE_ATTEMPTS);
    expect(row.error).toBe(`openai 429: attempt ${MAX_SAMPLE_ATTEMPTS}`);
    expect(row.nextAttemptAt).toBeNull();

    // And it stays given up: a fourth slice finds nothing pending at all.
    const after = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    expect(engine.calls).toBe(MAX_SAMPLE_ATTEMPTS);
    expect(after.remaining).toBe(0);
  });

  it("never retries a terminal failure — the money is spent to fail identically", async () => {
    const { runId } = await plannedOneSample();
    // A 401, a 404, a truncated answer: the client omits `retryable`.
    const engine = fakeEngine(() => ({ kind: "error", message: "openai 401: invalid api key" }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(1);
    expect(outcome.remaining).toBe(0);
    const row = await sampleRow(runId);
    expect(row.status).toBe("error");
    expect(row.nextAttemptAt).toBeNull();
  });

  it("never retries a refusal — the model read the prompt and declined", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({ kind: "refused", message: "openai refused the prompt", costUsd: 0.252 }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(1);
    expect(outcome.remaining).toBe(0);
    expect((await sampleRow(runId)).status).toBe("refused");
  });

  it("banks every attempt the provider billed, on the sample and on the run", async () => {
    const { runId } = await plannedOneSample();
    // A provider that charged for the work and then failed anyway — the client
    // reports what it knows, and a retry must not overwrite it. This is the
    // direction of error the monthly cap cannot survive.
    const engine = fakeEngine((call) =>
      call === 1
        ? { kind: "error", message: "openai 500: internal", retryable: true, costUsd: 0.004 }
        : answer({ costUsd: 0.01 })
    );
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    now.advance(sampleBackoffMs(1) + 1_000);
    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect((await sampleRow(runId)).costUsd).toBeCloseTo(0.014, 5);
    expect((await runRow(runId)).costUsd).toBeCloseTo(0.014, 5);
  });

  it("keeps the rest of the wave moving while one sample waits", async () => {
    // Three samples, one engine. The first call 429s; the other two answer. The
    // run must end the slice with two answers and one row waiting, rather than
    // the failing row blocking the batch it is in.
    const { runId } = await plannedOneSample(3);
    const engine = fakeEngine((call) =>
      call === 1 ? { kind: "error", message: "openai 429: slow down", retryable: true } : answer()
    );
    const now = controllableClock("2026-03-02T09:00:00Z");

    const first = await runSlice(runId, { budgetMs: 60_000, concurrency: 3, now }, { engines: { openai: engine } });
    expect(first.remaining).toBe(1);

    now.advance(sampleBackoffMs(1) + 1_000);
    const second = await runSlice(runId, { budgetMs: 60_000, concurrency: 3, now }, { engines: { openai: engine } });
    expect(second.remaining).toBe(0);

    const rows = await db.select().from(aiVisibilitySamples).where(eq(aiVisibilitySamples.runId, runId));
    expect(rows.every((row) => row.status === "ok")).toBe(true);
  });
});
