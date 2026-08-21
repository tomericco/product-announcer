import { describe, it, expect } from "vitest";
import { ENGINE_CLIENTS, engineLabel, engineCost } from "../../../../src/lib/ai-visibility/engines";
import { ENGINE_IDS } from "../../../../src/lib/ai-visibility/types";

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
