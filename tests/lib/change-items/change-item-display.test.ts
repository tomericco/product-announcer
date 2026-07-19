import { describe, it, expect } from "vitest";
import { changeItemFacingState, ignoredReasonLabel } from "../../../src/lib/change-items/change-item-display";

describe("changeItemFacingState", () => {
  it("is non-facing when userFacing is false", () => {
    expect(changeItemFacingState({ userFacing: false, enrichmentConfidence: 0.9 })).toBe("non-facing");
  });

  it("is low-confidence when facing with confidence below threshold", () => {
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: 0.3 })).toBe("low-confidence");
  });

  it("is facing when confidence is high", () => {
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: 0.8 })).toBe("facing");
  });

  it("is facing when un-enriched (null userFacing / null confidence)", () => {
    expect(changeItemFacingState({ userFacing: null, enrichmentConfidence: null })).toBe("facing");
    expect(changeItemFacingState({ userFacing: true, enrichmentConfidence: null })).toBe("facing");
  });
});

describe("ignoredReasonLabel", () => {
  it("labels the ignore reasons", () => {
    expect(ignoredReasonLabel("merge_commit")).toBe("merge commit");
    expect(ignoredReasonLabel("empty_diff")).toBe("empty diff");
    expect(ignoredReasonLabel(null)).toBeNull();
  });
});
