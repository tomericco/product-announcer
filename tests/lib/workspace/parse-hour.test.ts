import { describe, it, expect } from "vitest";
import { parseHour } from "../../../src/lib/workspace/parse-hour";

describe("parseHour", () => {
  it("parses a valid hour", () => {
    expect(parseHour("14")).toBe(14);
  });

  it("defaults to 9 for an empty string", () => {
    expect(parseHour("")).toBe(9);
  });

  it("defaults to 9 for a non-numeric string", () => {
    expect(parseHour("abc")).toBe(9);
  });

  it("clamps an out-of-range high hour to 23", () => {
    expect(parseHour("99")).toBe(23);
  });

  it("clamps an out-of-range low hour to 0", () => {
    expect(parseHour("-5")).toBe(0);
  });

  it("defaults to 9 for null", () => {
    expect(parseHour(null)).toBe(9);
  });
});
