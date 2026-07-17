import { describe, it, expect } from "vitest";
import { formatScheduleDistance } from "../../../src/lib/scheduling/format-schedule";

describe("formatScheduleDistance", () => {
  const now = new Date("2026-07-15T12:00:00Z");

  it("uses the two largest non-zero units joined with 'and'", () => {
    expect(formatScheduleDistance(new Date("2026-07-20T13:00:00Z"), now)).toBe("in 5 days and 1 hour");
  });

  it("drops a zero middle unit and shows a single unit", () => {
    expect(formatScheduleDistance(new Date("2026-07-20T12:00:00Z"), now)).toBe("in 5 days");
  });

  it("handles hours and minutes", () => {
    expect(formatScheduleDistance(new Date("2026-07-15T14:30:00Z"), now)).toBe("in 2 hours and 30 minutes");
  });

  it("returns 'now' when the target is in the past", () => {
    expect(formatScheduleDistance(new Date("2026-07-15T11:00:00Z"), now)).toBe("now");
  });

  it("returns 'in less than a minute' when under a minute away", () => {
    expect(formatScheduleDistance(new Date("2026-07-15T12:00:30Z"), now)).toBe("in less than a minute");
  });
});
