import { describe, it, expect } from "vitest";
import {
  applySelectionChange,
  applyToggleAll,
  retainVisible,
  reconcileSelection,
} from "../../src/app/(dashboard)/_components/row-selection";

/**
 * Pure reducer core behind `useRowSelection`, tested directly rather than
 * through the hook. Lives under `tests/components/` (the jsdom project's
 * glob) so a `renderHook` test that pins the hook's wiring to this reducer
 * can live alongside it; see `tests/components/generation-checklist.test.tsx`
 * for the same pure-function pattern applied to a component.
 */

describe("applySelectionChange", () => {
  it("adds an id when isSelected is true", () => {
    const result = applySelectionChange(new Set(["a"]), "b", true);
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("removes an id when isSelected is false", () => {
    const result = applySelectionChange(new Set(["a", "b"]), "b", false);
    expect(result).toEqual(new Set(["a"]));
  });

  it("is a no-op adding an id already present", () => {
    const result = applySelectionChange(new Set(["a"]), "a", true);
    expect(result).toEqual(new Set(["a"]));
  });

  it("is a no-op removing an id not present", () => {
    const result = applySelectionChange(new Set(["a"]), "z", false);
    expect(result).toEqual(new Set(["a"]));
  });

  it("does not mutate the Set it was given", () => {
    const selected = new Set(["a"]);
    applySelectionChange(selected, "b", true);
    expect(selected).toEqual(new Set(["a"]));
  });
});

describe("applyToggleAll", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("selects every row's id when checked", () => {
    const result = applyToggleAll(rows, true);
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("clears the selection when unchecked", () => {
    const result = applyToggleAll(rows, false);
    expect(result).toEqual(new Set());
  });

  it("selecting all over an empty row list yields an empty selection", () => {
    const result = applyToggleAll([], true);
    expect(result).toEqual(new Set());
  });
});

// The stale-selection bug: both Company filter bars (`atomic-updates-filters.tsx`,
// `change-events-filters.tsx`) navigate via `router.push`, a soft navigation,
// so neither list is remounted when the filtered rows narrow. Confirmed
// against the code — see the task report — that without this, a selection
// made before a filter change survives it with no row on screen, and a
// subsequent bulk hide/delete acts on rows the user can no longer see.
// `retainVisible` (imported, not reimplemented — the same function
// `signals-list.tsx` already uses and `tests/lib/signals/selection.test.ts`
// already covers in full) is what `useRowSelection` runs on every `rows`
// change to close that.
describe("retainVisible (reused by useRowSelection to close the stale-selection bug)", () => {
  it("drops ids no longer present in the current rows", () => {
    const selected = new Set(["a", "b"]);
    const result = retainVisible(selected, [{ id: "a" }]);
    expect(result).toEqual(new Set(["a"]));
  });

  it("keeps ids still present in the current rows", () => {
    const selected = new Set(["a", "b"]);
    const result = retainVisible(selected, [{ id: "a" }, { id: "b" }]);
    expect(result).toEqual(new Set(["a", "b"]));
  });
});

// `reconcileSelection` is the exact function `useRowSelection`'s effect
// calls on every `rows` change — its body is nothing but
// `setSelected((prev) => reconcileSelection(prev, rows))`. It's tested here
// directly, not just through `retainVisible` above, because a prior version
// of this task had the effect call `retainVisible` inline, with no exported
// name for the composition itself: a reviewer deleted that effect entirely
// and all the (then-existing) tests still passed, since none of them
// exercised anything the effect actually ran. Testing this exact composition
// is what makes a regression in the wiring itself — not just in
// `retainVisible`'s own logic — fail a test.
describe("reconcileSelection (the reconciliation useRowSelection's effect runs on every `rows` change)", () => {
  it("drops ids no longer present in rows", () => {
    const prev = new Set(["a", "b"]);
    const result = reconcileSelection(prev, [{ id: "a" }]);
    expect(result).toEqual(new Set(["a"]));
  });

  it("keeps ids still present in rows", () => {
    const prev = new Set(["a", "b"]);
    const result = reconcileSelection(prev, [{ id: "a" }, { id: "b" }]);
    expect(result).toEqual(new Set(["a", "b"]));
  });

  it("returns the same Set reference when nothing was dropped", () => {
    const prev = new Set(["a", "b"]);
    const result = reconcileSelection(prev, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(result).toBe(prev);
  });

  it("returns a new Set reference when something was dropped", () => {
    const prev = new Set(["a", "b"]);
    const result = reconcileSelection(prev, [{ id: "a" }]);
    expect(result).not.toBe(prev);
  });
});
