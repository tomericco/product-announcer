import { describe, it, expect } from "vitest";
import { parsePersonas } from "../../../src/lib/workspace/persona-form";

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
