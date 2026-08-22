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

  it("prices every engine, and the full weekly run lands near the $20 target", () => {
    for (const id of ENGINE_IDS) {
      expect(engineCost(id)).toBeGreaterThan(0);
      expect(engineCost(id)).toBeLessThan(0.1);
    }

    // 30 prompts x 3 samples on all four engines, weekly.
    const perRun = ENGINE_IDS.reduce((total, id) => total + engineCost(id) * 30 * 3, 0);
    const perMonth = perRun * 4.33;
    expect(perMonth).toBeGreaterThan(10);
    expect(perMonth).toBeLessThan(30);
  });
});

describe("the engine registry, wired to the clients it prices", () => {
  it("prices each engine from that engine's own constant", async () => {
    // A copy-paste that crossed two entries here would be invisible: every
    // number is a plausible per-call cost, and the cap check would simply
    // pause the wrong tenant early or late.
    const [openai, perplexity, gemini, anthropic] = await Promise.all([
      import("../../../../src/lib/ai-visibility/engines/openai"),
      import("../../../../src/lib/ai-visibility/engines/perplexity"),
      import("../../../../src/lib/ai-visibility/engines/gemini"),
      import("../../../../src/lib/ai-visibility/engines/anthropic"),
    ]);

    expect(engineCost("openai")).toBe(openai.OPENAI_COST_PER_CALL_USD);
    expect(engineCost("perplexity")).toBe(perplexity.PERPLEXITY_COST_PER_CALL_USD);
    expect(engineCost("gemini")).toBe(gemini.GEMINI_COST_PER_CALL_USD);
    expect(engineCost("anthropic")).toBe(anthropic.ANTHROPIC_COST_PER_CALL_USD);

    expect(ENGINE_CLIENTS.openai).toBe(openai.openaiEngine);
    expect(ENGINE_CLIENTS.perplexity).toBe(perplexity.perplexityEngine);
    expect(ENGINE_CLIENTS.gemini).toBe(gemini.geminiEngine);
    expect(ENGINE_CLIENTS.anthropic).toBe(anthropic.anthropicEngine);
  });

  it("gives every engine a label of its own, so a run report can tell them apart", () => {
    const labels = ENGINE_IDS.map((id) => engineLabel(id));
    expect(new Set(labels).size).toBe(ENGINE_IDS.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it("keeps the default weekly run inside the $20 cap on every engine combination", () => {
    // The cap is a hard pause, so the worst case — all four engines, the 30
    // prompt maximum, 5 samples — is the number that decides whether a tenant
    // on defaults can ever complete a month.
    const worstCase = ENGINE_IDS.reduce((total, id) => total + engineCost(id) * 30 * 5, 0) * 4.33;
    expect(worstCase).toBeGreaterThan(20);

    // …whereas the shipped default (3 samples) must fit under it.
    const defaults = ENGINE_IDS.reduce((total, id) => total + engineCost(id) * 30 * 3, 0) * 4.33;
    expect(defaults).toBeLessThan(20);
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
      vi.stubEnv("PERPLEXITY_API_KEY", "pplx-test");
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
