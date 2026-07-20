import { describe, it, expect } from "vitest";
import { parsePushedAt } from "../../../src/lib/integrations/github/github-webhook";

describe("parsePushedAt", () => {
  it("reads a Unix-seconds timestamp, the form push events use", () => {
    // GitHub sends repository.pushed_at as seconds on push events specifically.
    expect(parsePushedAt(1772618400)).toEqual(new Date("2026-03-04T10:00:00.000Z"));
  });

  it("reads an ISO string, the form every other event uses", () => {
    expect(parsePushedAt("2026-03-04T10:00:00Z")).toEqual(new Date("2026-03-04T10:00:00.000Z"));
  });

  it("returns null for anything unparseable so the caller can fall back", () => {
    // Storing an Invalid Date would poison the column silently; null is recoverable.
    for (const value of [undefined, null, "", "not a date", {}, NaN]) {
      expect(parsePushedAt(value)).toBeNull();
    }
  });
});
