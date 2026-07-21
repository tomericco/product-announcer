import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";
import {
  buildResolverPrompt,
  resolveAtomicUpdates,
  RESOLVER_BATCH_SIZE,
} from "../../../src/lib/ai/resolve-atomic-updates";

const EVENTS = [
  { id: "e1", type: "commit" as const, title: "add csv export", summary: "Adds CSV export.", repoName: "acme/api" },
];
const OPEN = [{ id: "a1", title: "CSV export", summary: "Export reports as CSV." }];

describe("buildResolverPrompt", () => {
  it("includes every event and every open atomic update", () => {
    const prompt = buildResolverPrompt(EVENTS, OPEN);
    expect(prompt).toContain("e1");
    expect(prompt).toContain("add csv export");
    expect(prompt).toContain("a1");
    expect(prompt).toContain("CSV export");
  });

  it("states explicitly when there are no open atomic updates", () => {
    expect(buildResolverPrompt(EVENTS, [])).toContain("(none)");
  });
});

describe("resolveAtomicUpdates", () => {
  afterEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(recordLlmUsage).mockReset();
  });

  it("returns the model's plan and records usage", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "e1", action: "assign", atomicUpdateId: "a1" }] },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    } as never);

    const result = await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN });

    expect(result).toEqual([{ eventId: "e1", action: "assign", atomicUpdateId: "a1" }]);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1", operation: "resolution" })
    );
  });

  it("drops an assign action pointing at an unknown atomic update", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "e1", action: "assign", atomicUpdateId: "hallucinated" }] },
      usage: {},
    } as never);

    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("drops an action for an event that was not in the batch", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { actions: [{ eventId: "not-sent", action: "assign", atomicUpdateId: "a1" }] },
      usage: {},
    } as never);

    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("returns an empty plan on model error rather than throwing", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));
    expect(await resolveAtomicUpdates({ tenantId: "t1", events: EVENTS, open: OPEN })).toEqual([]);
  });

  it("returns an empty plan without calling the model when there are no events", async () => {
    expect(await resolveAtomicUpdates({ tenantId: "t1", events: [], open: OPEN })).toEqual([]);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("caps the batch size at 25", () => {
    expect(RESOLVER_BATCH_SIZE).toBe(25);
  });
});
