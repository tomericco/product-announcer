import { describe, it, expect } from "vitest";
import { parseCompetitorId, parseDateFrom, parseDateTo, parseKind, parseMinScore, single } from "../../../src/lib/signals/params";
import { signalKindEnum } from "../../../src/db/schema";

describe("single", () => {
  it("returns the first element of an array param", () => {
    expect(single(["a", "b"])).toBe("a");
  });

  it("passes a scalar param through", () => {
    expect(single("a")).toBe("a");
  });

  it("returns undefined for an absent param", () => {
    expect(single(undefined)).toBeUndefined();
  });
});

describe("parseKind", () => {
  it("accepts a known kind", () => {
    expect(parseKind("shipped_work")).toBe("shipped_work");
  });

  it("rejects an unknown kind", () => {
    expect(parseKind("bogus")).toBeUndefined();
  });

  it("rejects an absent value", () => {
    expect(parseKind(undefined)).toBeUndefined();
  });

  it("accepts ai_visibility, so the filter the browser offers actually filters", () => {
    // `SignalsFilters` puts "AI visibility" in its dropdown and pushes
    // `?kind=ai_visibility`. If this whitelist did not know the value, the
    // page would silently render every kind while the dropdown claimed it was
    // filtered — the one failure mode a whitelist-on-read has.
    expect(parseKind("ai_visibility")).toBe("ai_visibility");
  });

  /**
   * The whitelist and the column have to agree. TypeScript checks the four
   * LABEL maps against `Signal["kind"]`, but `KIND_VALUES` is its own
   * `as const` tuple compared as strings — nothing in the type system stops a
   * sixth kind being added to the enum and never reaching the filter.
   */
  it("round-trips every kind the column can actually hold", () => {
    for (const kind of signalKindEnum.enumValues) {
      expect(parseKind(kind)).toBe(kind);
    }
  });
});

describe("parseCompetitorId", () => {
  it("accepts a well-formed uuid", () => {
    const id = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    expect(parseCompetitorId(id)).toBe(id);
  });

  it("is case-insensitive", () => {
    const id = "9B1DEB4D-3B7D-4BAD-9BDD-2B0D7B3DCB6D";
    expect(parseCompetitorId(id)).toBe(id);
  });

  // The bug this guards against: a non-uuid competitorId used to reach
  // Postgres unchanged, raising 22P02 (invalid input syntax for type uuid)
  // inside the Server Component and turning /signals?competitorId=x into a
  // hard error page instead of being silently dropped like every other
  // malformed filter.
  it("rejects a non-uuid value instead of letting it reach the query", () => {
    expect(parseCompetitorId("x")).toBeUndefined();
    expect(parseCompetitorId("'; drop table signals; --")).toBeUndefined();
  });

  it("rejects an absent value", () => {
    expect(parseCompetitorId(undefined)).toBeUndefined();
  });
});

describe("parseMinScore", () => {
  it("parses a numeric string", () => {
    expect(parseMinScore("0.55")).toBe(0.55);
  });

  it("rejects a non-numeric string", () => {
    expect(parseMinScore("abc")).toBeUndefined();
  });

  it("rejects an absent value", () => {
    expect(parseMinScore(undefined)).toBeUndefined();
    expect(parseMinScore("")).toBeUndefined();
  });
});

describe("parseDateFrom", () => {
  it("parses a date-only string to midnight UTC", () => {
    expect(parseDateFrom("2026-07-15")?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("rejects an unparseable string", () => {
    expect(parseDateFrom("not-a-date")).toBeUndefined();
  });
});

describe("parseDateTo", () => {
  // The bug: a bare parseDate("2026-07-15") produces T00:00:00Z, and
  // lte(occurredAt, to) then drops everything that happened later that same
  // day — picking one date as both `from` and `to` returned nothing.
  it("is inclusive of the entire day for a date-only string", () => {
    expect(parseDateTo("2026-07-15")?.toISOString()).toBe("2026-07-15T23:59:59.999Z");
  });

  it("lets a single day satisfy both from and to", () => {
    const from = parseDateFrom("2026-07-15")!;
    const to = parseDateTo("2026-07-15")!;
    const occurredAt = new Date("2026-07-15T18:30:00Z");
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect(occurredAt.getTime()).toBeLessThanOrEqual(to.getTime());
  });

  it("trusts a value that already carries a time component", () => {
    expect(parseDateTo("2026-07-15T10:00:00.000Z")?.toISOString()).toBe("2026-07-15T10:00:00.000Z");
  });

  it("rejects an unparseable string", () => {
    expect(parseDateTo("not-a-date")).toBeUndefined();
  });
});
