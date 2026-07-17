import { describe, it, expect } from "vitest";
import { reviewStatusLabel } from "../../../src/lib/ai/review-status";

describe("reviewStatusLabel", () => {
  it("labels the actionable statuses", () => {
    expect(reviewStatusLabel("failed")).toBe("Failed review");
    expect(reviewStatusLabel("revised")).toBe("Auto-revised");
    expect(reviewStatusLabel("error")).toBe("Review unavailable");
  });

  it("returns null for passed, null, and unknown", () => {
    expect(reviewStatusLabel("passed")).toBeNull();
    expect(reviewStatusLabel(null)).toBeNull();
    expect(reviewStatusLabel("weird")).toBeNull();
  });
});
