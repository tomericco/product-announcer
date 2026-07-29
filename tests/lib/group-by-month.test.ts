import { describe, expect, it } from "vitest";
import { groupByMonth } from "@/lib/group-by-month";

type Row = { id: string; createdAt: Date };

const row = (id: string, iso: string): Row => ({ id, createdAt: new Date(iso) });

describe("groupByMonth", () => {
  it("returns no groups for an empty list", () => {
    expect(groupByMonth([], (r: Row) => r.createdAt)).toEqual([]);
  });

  it("buckets rows by calendar month and labels each group", () => {
    const groups = groupByMonth(
      [row("a", "2026-07-20T10:00:00Z"), row("b", "2026-07-02T09:00:00Z")],
      (r) => r.createdAt
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("2026-07");
    expect(groups[0].label).toBe("July 2026");
    expect(groups[0].items.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders groups latest month first, regardless of input order", () => {
    const groups = groupByMonth(
      [
        row("jun", "2026-06-15T00:00:00Z"),
        row("jan27", "2027-01-05T00:00:00Z"),
        row("jul", "2026-07-01T00:00:00Z"),
        row("dec", "2026-12-31T00:00:00Z"),
      ],
      (r) => r.createdAt
    );

    expect(groups.map((g) => g.label)).toEqual([
      "January 2027",
      "December 2026",
      "July 2026",
      "June 2026",
    ]);
  });

  it("keeps the caller's ordering within a group", () => {
    const groups = groupByMonth(
      [row("first", "2026-07-01T00:00:00Z"), row("second", "2026-07-28T00:00:00Z")],
      (r) => r.createdAt
    );

    expect(groups[0].items.map((r) => r.id)).toEqual(["first", "second"]);
  });

  it("buckets by UTC so a month boundary lands identically on server and client", () => {
    // 00:30 UTC on the 1st is still the previous month in any negative-offset
    // timezone — pinning to UTC keeps the bucket stable across environments.
    const groups = groupByMonth([row("edge", "2026-07-01T00:30:00Z")], (r) => r.createdAt);

    expect(groups[0].key).toBe("2026-07");
    expect(groups[0].label).toBe("July 2026");
  });
});
