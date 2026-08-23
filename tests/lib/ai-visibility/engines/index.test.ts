import { describe, it, expect, afterEach, vi } from "vitest";
import { ENGINE_CLIENTS, engineLabel, engineCost } from "../../../../src/lib/ai-visibility/engines";
import { ENGINE_IDS } from "../../../../src/lib/ai-visibility/types";
import { ENGINE_REQUEST_TIMEOUT_MS } from "../../../../src/lib/ai-visibility/engines/shape";

describe("the engine registry", () => {
  it("has one client per engine id, keyed by its own id", () => {
    expect(Object.keys(ENGINE_CLIENTS).sort()).toEqual([...ENGINE_IDS].sort());
    for (const id of ENGINE_IDS) {
      expect(ENGINE_CLIENTS[id].id).toBe(id);
      expect(typeof ENGINE_CLIENTS[id].ask).toBe("function");
    }
  });

  it("labels every engine as an API, which is the trust cue the spec asks for", () => {
    for (const id of ENGINE_IDS) {
      expect(engineLabel(id)).toBe(ENGINE_CLIENTS[id].label);
      expect(engineLabel(id)).toMatch(/API/);
    }
  });

  it("prices every engine from a measured call, not a guess", () => {
    for (const id of ENGINE_IDS) {
      expect(engineCost(id)).toBeGreaterThan(0);
      // A grounded call puts the retrieved page text in the INPUT, so these are
      // tens of cents, not the ~$0.01 a bare completion costs. An entry that
      // drifts back under a cent means someone priced the answer and forgot the
      // search results that produced it.
      expect(engineCost(id)).toBeGreaterThan(0.05);
      expect(engineCost(id)).toBeLessThan(1);
    }
  });

  it("reports what the DEFAULT run actually costs, which is far above the $20 cap", () => {
    // 30 prompts x 3 samples on all three engines, weekly. This test does not
    // assert a target — it pins the real number so that changing the run shape
    // or a provider's rates has to be a deliberate edit here.
    //
    // The default cap is $20/month. This shape costs roughly nine times that,
    // so a tenant on the defaults pauses partway through their first run. That
    // is a product decision (fewer prompts, fewer samples, or a higher cap),
    // NOT something to fix by quietly lowering these constants — the previous
    // values were ~8-27x too low and made the estimate and the cap both lie.
    const perRun = ENGINE_IDS.reduce((total, id) => total + engineCost(id) * 30 * 3, 0);
    const perMonth = perRun * 4.33;

    expect(perRun).toBeCloseTo(43.47, 1);
    expect(perMonth).toBeGreaterThan(180);
    expect(perMonth).toBeLessThan(195);
  });
});

describe("the engine registry, wired to the clients it prices", () => {
  it("prices each engine from that engine's own constant", async () => {
    // A copy-paste that crossed two entries here would be invisible: every
    // number is a plausible per-call cost, and the cap check would simply
    // pause the wrong tenant early or late.
    const [openai, gemini, anthropic] = await Promise.all([
      import("../../../../src/lib/ai-visibility/engines/openai"),
      import("../../../../src/lib/ai-visibility/engines/gemini"),
      import("../../../../src/lib/ai-visibility/engines/anthropic"),
    ]);

    expect(engineCost("openai")).toBe(openai.OPENAI_COST_PER_CALL_USD);
    expect(engineCost("gemini")).toBe(gemini.GEMINI_COST_PER_CALL_USD);
    expect(engineCost("anthropic")).toBe(anthropic.ANTHROPIC_COST_PER_CALL_USD);

    expect(ENGINE_CLIENTS.openai).toBe(openai.openaiEngine);
    expect(ENGINE_CLIENTS.gemini).toBe(gemini.geminiEngine);
    expect(ENGINE_CLIENTS.anthropic).toBe(anthropic.anthropicEngine);
  });

  it("gives every engine a label of its own, so a run report can tell them apart", () => {
    const labels = ENGINE_IDS.map((id) => engineLabel(id));
    expect(new Set(labels).size).toBe(ENGINE_IDS.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it("shows which run shapes actually fit the $20 cap, and which do not", () => {
    const monthly = (prompts: number, samples: number, runsPerMonth: number) =>
      ENGINE_IDS.reduce((total, id) => total + engineCost(id) * prompts * samples, 0) * runsPerMonth;

    const WEEKLY = 4.33;
    const FORTNIGHTLY = 2.17;

    // The shipped default does NOT fit, by roughly 9x. Pinned rather than
    // wished away: whoever changes the defaults should see this move.
    expect(monthly(30, 3, WEEKLY)).toBeGreaterThan(20);
    // Nor does dropping to one sample while staying weekly.
    expect(monthly(30, 1, WEEKLY)).toBeGreaterThan(20);
    // Nor fortnightly at one sample, on the full 30-prompt set.
    expect(monthly(30, 1, FORTNIGHTLY)).toBeGreaterThan(20);

    // Roughly where $20 actually lands today: half the prompt set, one sample,
    // fortnightly. That is the honest shape of a $20 budget at current rates.
    expect(monthly(15, 1, FORTNIGHTLY)).toBeLessThan(20);
  });
});

describe("every engine bounds its own request", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives a grounded answer a generous minute, and no more", () => {
    // Generous: every client asks the provider to run a live web search before
    // answering, and aborting a slow grounded answer costs a real sample.
    // Finite: `runSlice`'s budget only governs when it stops HANDING OUT work,
    // so a request that never returns holds its concurrency slot until the
    // platform kills the whole cron invocation.
    expect(ENGINE_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it.each([...ENGINE_IDS])(
    "%s aborts a hung provider and degrades it to an ordinary EngineError",
    async (id) => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("GEMINI_API_KEY", "gem-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
      // What `AbortSignal.timeout` actually produces when it fires.
      const fetchImpl = vi.fn(async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });

      const result = await ENGINE_CLIENTS[id].ask("best issue trackers", {
        fetchImpl: fetchImpl as never,
      });

      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.signal as AbortSignal).aborted).toBe(false);
      // An error on one sample, not a throw: the sample is stored `error` and
      // excluded from every rate, and the run carries on.
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("TimeoutError") });
    }
  );
});
