import { describe, it, expect } from "vitest";
import {
  changeItemFacingState,
  changeItemReleasedAt,
  ignoredReasonLabel,
} from "../../../src/lib/change-items/change-item-display";

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

describe("changeItemReleasedAt", () => {
  const MERGED = new Date("2026-03-10T12:00:00Z");
  const RELEASED = new Date("2026-03-08T09:00:00Z");
  const COMMITTED = new Date("2026-03-01T08:00:00Z");

  it("uses the merge time for a PR, ignoring commit timestamps", () => {
    expect(
      changeItemReleasedAt({ type: "pull_request", mergedAt: MERGED, releasedAt: null, committedAt: COMMITTED })
    ).toBe(MERGED);
  });

  it("prefers a commit's push time over its author date", () => {
    expect(
      changeItemReleasedAt({ type: "commit", mergedAt: null, releasedAt: RELEASED, committedAt: COMMITTED })
    ).toBe(RELEASED);
  });

  it("falls back to the author date for imported commits, which have no push time", () => {
    expect(
      changeItemReleasedAt({ type: "commit", mergedAt: null, releasedAt: null, committedAt: COMMITTED })
    ).toBe(COMMITTED);
  });

  it("returns null when nothing is known, so callers can sort it last", () => {
    expect(
      changeItemReleasedAt({ type: "commit", mergedAt: null, releasedAt: null, committedAt: null })
    ).toBeNull();
  });
});
