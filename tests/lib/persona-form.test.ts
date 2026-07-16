import { describe, it, expect } from "vitest";
import { parsePersonas } from "../../src/lib/persona-form";

function fd(personas: string | undefined): FormData {
  const f = new FormData();
  if (personas !== undefined) f.set("personas", personas);
  return f;
}

describe("parsePersonas", () => {
  it("parses valid personas, trimming fields", () => {
    const json = JSON.stringify([
      { name: "  Eng managers ", usage: " track work ", deliveredValue: " know changes " },
    ]);
    expect(parsePersonas(fd(json))).toEqual([
      { name: "Eng managers", usage: "track work", deliveredValue: "know changes" },
    ]);
  });

  it("drops entries with an empty name and fills missing fields with empty strings", () => {
    const json = JSON.stringify([
      { name: "", usage: "x", deliveredValue: "y" },
      { name: "IC devs" },
    ]);
    expect(parsePersonas(fd(json))).toEqual([{ name: "IC devs", usage: "", deliveredValue: "" }]);
  });

  it("returns [] for a missing field", () => {
    expect(parsePersonas(fd(undefined))).toEqual([]);
  });

  it("returns [] for non-JSON or a non-array", () => {
    expect(parsePersonas(fd("not json"))).toEqual([]);
    expect(parsePersonas(fd(JSON.stringify({ name: "x" })))).toEqual([]);
  });
});
