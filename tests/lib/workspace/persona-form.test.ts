import { describe, it, expect } from "vitest";
import { parsePersonas, sanitizePersonas } from "../../../src/lib/workspace/persona-form";

function fd(personas: string | undefined): FormData {
  const f = new FormData();
  if (personas !== undefined) f.set("personas", personas);
  return f;
}

describe("parsePersonas", () => {
  it("parses system references and custom personas, trimming fields", () => {
    const json = JSON.stringify([
      { type: "system", key: " developer " },
      { type: "custom", name: "  Eng managers ", brief: " track shipped work " },
    ]);
    expect(parsePersonas(fd(json))).toEqual([
      { type: "system", key: "developer" },
      { type: "custom", name: "Eng managers", brief: "track shipped work" },
    ]);
  });

  it("drops a custom persona with an empty name and a system ref with an empty key", () => {
    const json = JSON.stringify([
      { type: "custom", name: "  ", brief: "y" },
      { type: "system", key: "" },
      { type: "custom", name: "IC devs" },
    ]);
    expect(parsePersonas(fd(json))).toEqual([{ type: "custom", name: "IC devs", brief: "" }]);
  });

  it("ignores entries with an unknown or missing type", () => {
    const json = JSON.stringify([
      { name: "x", usage: "y" },
      { type: "other", key: "z" },
      { type: "system", key: "product-manager" },
    ]);
    expect(parsePersonas(fd(json))).toEqual([{ type: "system", key: "product-manager" }]);
  });

  it("returns [] for a missing field", () => {
    expect(parsePersonas(fd(undefined))).toEqual([]);
  });

  it("returns [] for non-JSON or a non-array", () => {
    expect(parsePersonas(fd("not json"))).toEqual([]);
    expect(parsePersonas(fd(JSON.stringify({ type: "custom", name: "x" })))).toEqual([]);
  });
});

// The auto-saving personas card posts an array straight to a Server Action
// instead of through a form, so this is the validation boundary for that path.
describe("sanitizePersonas", () => {
  it("applies the same trimming and dropping as the form path", () => {
    expect(
      sanitizePersonas([
        { type: "system", key: " developer " },
        { type: "custom", name: "  Eng managers ", brief: " track shipped work " },
        { type: "custom", name: "   ", brief: "dropped: no name" },
        { type: "system", key: "" },
        { type: "other", key: "ignored" },
        "not an object",
        null,
      ])
    ).toEqual([
      { type: "system", key: "developer" },
      { type: "custom", name: "Eng managers", brief: "track shipped work" },
    ]);
  });

  it("returns [] for anything that isn't an array", () => {
    expect(sanitizePersonas(undefined)).toEqual([]);
    expect(sanitizePersonas(null)).toEqual([]);
    expect(sanitizePersonas("[]")).toEqual([]);
    expect(sanitizePersonas({ type: "custom", name: "x" })).toEqual([]);
  });
});
