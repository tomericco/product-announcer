import { describe, it, expect } from "vitest";
import { saveOutcomeMessage } from "../../../src/lib/atomic-updates/save-outcome";

// One Save over an atomic update is three writes (title/summary, then size and
// category when they changed). Both editors used to report it twice: a failed
// size call toasted "Could not update size" and the run then finished with
// "Saved" — two contradictory toasts for one click. This derives a single
// outcome instead.

describe("saveOutcomeMessage", () => {
  it("is a success when nothing failed", () => {
    expect(saveOutcomeMessage([])).toEqual({ ok: true, message: "Saved" });
  });

  it("takes the caller's own success wording", () => {
    // The card says "Atomic update saved"; the drawer says "Saved".
    expect(saveOutcomeMessage([], "Atomic update saved")).toEqual({
      ok: true,
      message: "Atomic update saved",
    });
  });

  it("is a single failure outcome when a part failed — never a success as well", () => {
    const outcome = saveOutcomeMessage(["size"]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Saved the title and summary, but couldn't update size");
  });

  it("names both parts when both failed, in one message", () => {
    expect(saveOutcomeMessage(["category", "size"]).message).toBe(
      "Saved the title and summary, but couldn't update size or category"
    );
  });

  it("is stable regardless of the order the writes were attempted in", () => {
    expect(saveOutcomeMessage(["size", "category"])).toEqual(saveOutcomeMessage(["category", "size"]));
  });

  it("still reports what DID persist — the title and summary are already written by then", () => {
    // A bare "couldn't save" would be false: `editAtomicUpdate` succeeded, or
    // the caller would have bailed before reaching the size/category writes.
    expect(saveOutcomeMessage(["category"]).message).toContain("Saved the title and summary");
  });

  it("ignores a duplicate part rather than repeating it", () => {
    expect(saveOutcomeMessage(["size", "size"]).message).toBe(
      "Saved the title and summary, but couldn't update size"
    );
  });
});
