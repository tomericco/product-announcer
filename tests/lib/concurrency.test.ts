import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/lib/concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order in the results", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const delay = () => new Promise((r) => setTimeout(r, 5));
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay();
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("passes the index to fn and handles an empty list", async () => {
    const idx = await mapWithConcurrency(["a", "b"], 5, async (_item, i) => i);
    expect(idx).toEqual([0, 1]);
    expect(await mapWithConcurrency([], 5, async (x) => x)).toEqual([]);
  });
});
