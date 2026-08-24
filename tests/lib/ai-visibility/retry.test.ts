import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  aiVisibilitySettings,
} from "../../../src/db/schema";
import { askOpenAi } from "../../../src/lib/ai-visibility/engines/openai";
import type { EngineAnswer, EngineClient, EngineError } from "../../../src/lib/ai-visibility/types";
import {
  MAX_SAMPLE_ATTEMPTS,
  TOTAL_RETRY_WINDOW_MS,
  planRun,
  retryWaitMs,
  runSlice,
  sampleBackoffMs,
} from "../../../src/lib/ai-visibility/run";
import {
  RETRY_WINDOW_MS,
  engineFailureMessage,
} from "../../../src/lib/ai-visibility/engines/failure";
import { seedTenant, dropTenant, seedEngineKey } from "../../helpers/fixtures";

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

/**
 * The sentences the clients actually produce now, rather than the provider's.
 *
 * A fake engine that replied `"openai 429: slow down"` was testing the retry
 * ladder against a string no client can return any more — the message a
 * failure carries is composed from its `code` by `engineFailure()`, and the
 * provider's own body never leaves the client. Using the real copy here keeps
 * these tests honest about what lands in `ai_visibility_samples.error`.
 */
const RATE_LIMITED = engineFailureMessage("openai", "rate_limited");
const UNAVAILABLE = engineFailureMessage("openai", "provider_unavailable");
const INVALID_KEY = engineFailureMessage("openai", "invalid_key");
const REFUSED = engineFailureMessage("openai", "refused");

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
  // BYOK: without a verified key `planRun` refuses with `no_engines`, so every
  // run fixture seeds one. The key is a fake and is never asserted on here.
  await seedEngineKey(tenant.id, "openai");
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
    const engine = fakeEngine(() => ({ kind: "error", code: "rate_limited", message: RATE_LIMITED, retryable: true }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    const row = await sampleRow(runId);
    // The whole change in one assertion: an errored sample used to be
    // terminal, and at n=15 per engine three of them drop that engine below
    // the trend chart's floor for the run.
    expect(row.status).toBe("pending");
    expect(row.askAttempts).toBe(1);
    expect(row.error).toBe(RATE_LIMITED);
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
    const engine = fakeEngine(() => ({ kind: "error", code: "rate_limited", message: RATE_LIMITED, retryable: true }));
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
      call === 1
        ? { kind: "error", code: "provider_unavailable", message: UNAVAILABLE, retryable: true }
        : answer()
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
    const engine = fakeEngine(() => ({ kind: "error", code: "rate_limited", message: RATE_LIMITED, retryable: true }));
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
      kind: "error" as const,
      code: "rate_limited" as const,
      message: `${RATE_LIMITED} attempt ${call}`,
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
    expect(row.error).toBe(`${RATE_LIMITED} attempt ${MAX_SAMPLE_ATTEMPTS}`);
    expect(row.nextAttemptAt).toBeNull();

    // And it stays given up: a fourth slice finds nothing pending at all.
    const after = await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    expect(engine.calls).toBe(MAX_SAMPLE_ATTEMPTS);
    expect(after.remaining).toBe(0);
  });

  it("never retries a terminal failure — the money is spent to fail identically", async () => {
    const { runId } = await plannedOneSample();
    // A 401, a 404, a truncated answer: the client omits `retryable`.
    const engine = fakeEngine(() => ({ kind: "error", code: "invalid_key", message: INVALID_KEY }));
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
    const engine = fakeEngine(() => ({ kind: "refused", code: "refused", message: REFUSED, costUsd: 0.252 }));
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
        ? {
            kind: "error" as const,
            code: "provider_unavailable" as const,
            message: UNAVAILABLE,
            retryable: true,
            costUsd: 0.004,
          }
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
      call === 1 ? { kind: "error", code: "rate_limited", message: RATE_LIMITED, retryable: true } : answer()
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

describe("runSlice — a 429 is not one thing", () => {
  it("a SPEND-CAP 429 is terminal after ONE attempt", async () => {
    // The whole point of the split. Anthropic's spend-cap 429 and Gemini's
    // `$10 / 10 minutes` cap cannot clear inside a 90-second ladder, so the two
    // extra attempts buy two identical failures at full price — on the
    // customer's key, under a hard gate with no vendor fallback.
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({
      kind: "error" as const,
      code: "quota_exceeded" as const,
      message: engineFailureMessage("openai", "quota_exceeded"),
    }));
    const now = controllableClock("2026-03-02T09:00:00Z");

    const outcome = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now },
      { engines: { openai: engine } }
    );

    expect(engine.calls).toBe(1);
    const row = await sampleRow(runId);
    expect(row.status).toBe("error");
    expect(row.askAttempts).toBe(1);
    expect(row.nextAttemptAt).toBeNull();
    expect(outcome.remaining).toBe(0);

    // And it stays given up — no later driver picks it back up.
    now.advance(TOTAL_RETRY_WINDOW_MS + 60_000);
    const later = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now },
      { engines: { openai: engine } }
    );
    expect(engine.calls).toBe(1);
    expect(later.processed).toBe(0);
  });

  it("a THROUGHPUT 429 still retries — the two must not be collapsed", async () => {
    const { runId } = await plannedOneSample();
    const engine = fakeEngine((call) =>
      call === 1
        ? { kind: "error" as const, code: "rate_limited" as const, message: RATE_LIMITED, retryable: true }
        : answer()
    );
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });
    expect((await sampleRow(runId)).status).toBe("pending");

    now.advance(sampleBackoffMs(1) + 1_000);
    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    expect(engine.calls).toBe(2);
    expect((await sampleRow(runId)).status).toBe("ok");
  });

  it("honours the provider's `retry-after` instead of the ladder", async () => {
    // Our ladder is one guess about three providers. `retry-after` is the
    // provider telling us the answer for this key at this moment, and Anthropic
    // warns a nominal 60 RPM "might be enforced as 1 request per second".
    const { runId } = await plannedOneSample();
    const engine = fakeEngine(() => ({
      kind: "error" as const,
      code: "rate_limited" as const,
      message: RATE_LIMITED,
      retryable: true,
      retryAfterMs: 5_000,
    }));
    const startedAt = new Date("2026-03-02T09:00:00Z").getTime();
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: engine } });

    const row = await sampleRow(runId);
    // 5s from the provider, not the ladder's 30s. Compared as a window rather
    // than an instant: the clock steps a few ms per read inside the slice.
    const waited = row.nextAttemptAt!.getTime() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(5_000);
    expect(waited).toBeLessThan(sampleBackoffMs(1));

    // And the row really is picked up once that shorter wait has passed.
    now.advance(6_000);
    const second = await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now },
      { engines: { openai: engine } }
    );
    expect(second.processed).toBe(1);
  });
});

/**
 * The wire between the two halves that were each tested alone.
 *
 * `classifyHttpFailure` is tested against a `Headers` bag in
 * `engines/failure.test.ts`; `runSlice`'s use of `EngineError.retryAfterMs` is
 * tested above with a fake engine that sets the field by hand. Neither notices
 * if the REAL client stops carrying the value from one to the other — a mutation
 * that made `classifyHttpFailure` ignore `retry-after` entirely left every test
 * in this file green, which is how this gap was found.
 *
 * So these two drive the actual `askOpenAi` with a canned 429 and read the
 * sample row, joining header → classification → `EngineError` → `nextAttemptAt`
 * in one assertion. The provider's own instruction is what this feature has
 * instead of guessing: Anthropic warns that a nominal 60 RPM "might be enforced
 * as 1 request per second", and under a hard gate the customer's 429 is our
 * outage.
 */
describe("a real client carries `retry-after` all the way to the row", () => {
  /** The real OpenAI client, given a fetch that returns one canned 429. */
  function throttledOpenAi(headers: Record<string, string>, body = "{}"): EngineClient {
    const fetchImpl = async () => new Response(body, { status: 429, headers });
    return {
      id: "openai",
      label: "openai (canned 429)",
      ask: (prompt) => askOpenAi(prompt, { fetchImpl, apiKey: "test-openai-key-0000" }),
    };
  }

  it("waits the 5 seconds the header asked for, not the ladder's 30", async () => {
    const { runId } = await plannedOneSample();
    const startedAt = new Date("2026-03-02T09:00:00Z").getTime();
    const now = controllableClock("2026-03-02T09:00:00Z");

    await runSlice(
      runId,
      { budgetMs: 60_000, concurrency: 1, now },
      { engines: { openai: throttledOpenAi({ "retry-after": "5" }) } }
    );

    const row = await sampleRow(runId);
    expect(row.status).toBe("pending");
    const waited = row.nextAttemptAt!.getTime() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(5_000);
    // Strictly shorter than our own first rung, which is the whole point: a
    // ladder that ignored the provider would sit here for 30 seconds.
    expect(waited).toBeLessThan(sampleBackoffMs(1));
  });

  it("treats a wait longer than the whole ladder as terminal, and stops paying", async () => {
    // A 429 asking for ten minutes cannot be waited out inside a 90-second
    // ladder, so retrying it burns three attempts of the tenant's budget to
    // fail identically. One attempt, no next one scheduled.
    const { runId } = await plannedOneSample();
    const now = controllableClock("2026-03-02T09:00:00Z");
    const client = throttledOpenAi({ "retry-after": "600" });

    await runSlice(runId, { budgetMs: 60_000, concurrency: 1, now }, { engines: { openai: client } });

    const row = await sampleRow(runId);
    expect(row.status).toBe("error");
    expect(row.nextAttemptAt).toBeNull();
    // And it is named as a RATE LIMIT, not as money. The length of a wait says
    // nothing about whether an account is funded, and this sentence is what the
    // tenant reads on the sample: sending them to a billing page over a
    // throughput limit is telling them to fix something that is not broken.
    expect(row.error).toContain("rate-limiting this key");
    expect(row.error).not.toContain("out of credit");
    // The provider's body never made it into the column either.
    expect(row.error).not.toContain("retry-after");
  });
});

describe("retryWaitMs", () => {
  it("uses the ladder when the provider said nothing", () => {
    expect(retryWaitMs(undefined, 1)).toBe(sampleBackoffMs(1));
    expect(retryWaitMs(undefined, 2)).toBe(sampleBackoffMs(2));
  });

  it("floors a zero or near-zero wait at a second", () => {
    // `retry-after: 0`, or a header parsed off a skewed clock, would otherwise
    // put the row back into the very next batch — the hot loop the
    // `nextAttemptAt` filter exists to prevent.
    expect(retryWaitMs(0, 1)).toBe(1_000);
    expect(retryWaitMs(50, 1)).toBe(1_000);
  });

  it("caps a wait at the whole ladder, as a backstop", () => {
    // A wait longer than this is returned TERMINAL upstream — still
    // `rate_limited`, but with no `retryable`, so there is no next attempt to
    // schedule and this function is never reached with it. The clamp is the
    // guard for a client that sets the field by hand.
    expect(retryWaitMs(TOTAL_RETRY_WINDOW_MS * 10, 1)).toBe(TOTAL_RETRY_WINDOW_MS);
  });

  it("keeps the ladder total and the classifier's threshold in step", () => {
    // `engines/failure.ts` cannot import `run.ts`, so it restates the ladder
    // total as a literal. If the ladder changes and that literal does not, the
    // classifier starts calling recoverable waits terminal — or worse, the
    // reverse. This assertion is the only thing joining them.
    expect(RETRY_WINDOW_MS).toBe(TOTAL_RETRY_WINDOW_MS);
  });
});
