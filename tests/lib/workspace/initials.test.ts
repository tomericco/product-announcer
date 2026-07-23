import { describe, it, expect } from "vitest";
import { initials } from "../../../src/lib/workspace/initials";

describe("initials", () => {
  it("takes the first letters of the first two words of a name", () => {
    expect(initials("Tomer Gabbai")).toBe("TG");
  });
  it("uses a single-word name's first two letters", () => {
    expect(initials("Cher")).toBe("CH");
  });
  it("falls back to the email local-part when there is no name", () => {
    expect(initials("tomer@frontitude.com")).toBe("TO");
  });
  it("returns a single letter when only one is available", () => {
    expect(initials("a@b.com")).toBe("A");
  });
  it("returns '?' for empty input", () => {
    expect(initials("")).toBe("?");
  });
});
