import { describe, expect, it } from "vitest";
import { retainVisible } from "@/lib/signals/selection";

describe("retainVisible", () => {
  it("retains an id that is present in rows", () => {
    const selected = new Set(["a"]);
    const result = retainVisible(selected, [{ id: "a" }]);
    expect(result).toEqual(new Set(["a"]));
  });

  it("drops an id that is absent from rows", () => {
    const selected = new Set(["a", "b"]);
    const result = retainVisible(selected, [{ id: "a" }]);
    expect(result).toEqual(new Set(["a"]));
    expect(result.has("b")).toBe(false);
  });

  it("returns an empty selection when rows is empty", () => {
    const selected = new Set(["a", "b"]);
    const result = retainVisible(selected, []);
    expect(result).toEqual(new Set());
  });

  it("does not mutate the Set it was given", () => {
    const selected = new Set(["a", "b"]);
    retainVisible(selected, [{ id: "a" }]);
    expect(selected).toEqual(new Set(["a", "b"]));
  });
});
