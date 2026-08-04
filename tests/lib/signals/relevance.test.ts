import { describe, it, expect, vi } from "vitest";
import { scoreRelevance, type ScorableItem } from "../../../src/lib/signals/relevance";

const PROFILE = {
  name: "Acme",
  oneLiner: "Issue tracking for software teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["developer productivity", "issue tracking"],
};

const ITEMS: ScorableItem[] = [
  { title: "SSO everywhere", text: "Now on all plans.", url: "https://rival.com/a" },
  { title: "Dark mode", text: "Theme support.", url: "https://rival.com/b" },
  { title: "Patch release", text: "Bug fixes.", url: "https://rival.com/c" },
];

describe("scoreRelevance", () => {
  it("maps scores back by index, not array position", async () => {
    const generate = vi.fn(async () => ({
      object: {
        scores: [
          { index: 2, score: 0.1, rationale: "routine patch", topics: [] },
          { index: 0, score: 0.9, rationale: "direct competitor capability", topics: ["sso"] },
          { index: 1, score: 0.4, rationale: "cosmetic", topics: [] },
        ],
      },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });

    expect(scored[0].score).toBe(0.9);
    expect(scored[1].score).toBe(0.4);
    expect(scored[2].score).toBe(0.1);
    expect(scored[0].topics).toEqual(["sso"]);
  });

  it("treats an omitted index as a scoring failure, not a zero", async () => {
    const generate = vi.fn(async () => ({
      object: { scores: [{ index: 0, score: 0.9, rationale: "ok", topics: [] }] },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });
    expect(scored[0].score).toBe(0.9);
    expect(scored[1].score).toBeNull();
    expect(scored[2].score).toBeNull();
    expect(scored[1].rationale).toMatch(/fail/i);
  });

  it("ignores an index the model invented", async () => {
    const generate = vi.fn(async () => ({
      object: {
        scores: [
          { index: 0, score: 0.5, rationale: "ok", topics: [] },
          { index: 99, score: 1, rationale: "phantom", topics: [] },
        ],
      },
      usage: undefined,
    }));

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });
    expect(scored).toHaveLength(3);
    expect(scored[0].score).toBe(0.5);
  });

  it("fails open — a thrown error leaves every item unscored, none dropped", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model unavailable");
    });

    const scored = await scoreRelevance(ITEMS, PROFILE, "t1", { generate });
    expect(scored).toHaveLength(3);
    expect(scored.every((s) => s.score === null)).toBe(true);
    expect(scored[0].rationale).toMatch(/fail/i);
  });

  it("makes no model call for an empty item list", async () => {
    const generate = vi.fn();
    expect(await scoreRelevance([], PROFILE, "t1", { generate })).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});
