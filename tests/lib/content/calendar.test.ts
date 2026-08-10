import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { single } from "../../../src/lib/signals/params";
// `readMonth` comes from `calendar.ts` (it imports `@/db`); every pure
// member below comes from `calendar-view.ts` directly — `calendar.ts`
// deliberately no longer re-exports them (see its header comment). Importing
// the pure members from the db-importing path would defeat the whole point
// of the split this test exists to exercise indirectly: a client component
// must be able to import these without pulling `pg`/`net`/`tls` in.
import { readMonth } from "../../../src/lib/content/calendar";
import {
  bucketByLocalDay,
  monthRangeUtc,
  resolveMonth,
  isValidMonthParam,
  shiftMonth,
  CALENDAR_TYPES,
} from "../../../src/lib/content/calendar-view";

const TENANT = "Calendar Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "A piece", body: "b", ...overrides })
    .returning();
  return piece;
}

describe("monthRangeUtc", () => {
  it("pads a day either side, so any viewer timezone is covered", () => {
    const { from, to } = monthRangeUtc("2026-09");
    // A viewer up to ~14h from UTC must still receive the pieces that fall on
    // their local 1st or 30th. One day of slack each way covers every zone.
    expect(from.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-02T00:00:00.000Z");
  });
});

describe("readMonth", () => {
  it("returns scheduled pieces by scheduledFor and published by publishedAt", async () => {
    const tenant = await seedTenant();
    await seedPiece(tenant.id, {
      title: "S", status: "scheduled", scheduledFor: new Date("2026-09-10T09:00:00Z"),
    });
    await seedPiece(tenant.id, {
      title: "P", status: "published", publishedAt: new Date("2026-09-12T09:00:00Z"),
    });

    const { pieces } = await readMonth(tenant.id, "2026-09", db);
    const byTitle = Object.fromEntries(pieces.map((p) => [p.title, p]));
    expect(byTitle.S.at.toISOString()).toBe("2026-09-10T09:00:00.000Z");
    expect(byTitle.P.at.toISOString()).toBe("2026-09-12T09:00:00.000Z");
  });

  it("ignores every other status", async () => {
    const tenant = await seedTenant();
    for (const status of ["brief", "draft", "review", "archived"] as const) {
      await seedPiece(tenant.id, { status, scheduledFor: new Date("2026-09-10T09:00:00Z") });
    }
    const { pieces } = await readMonth(tenant.id, "2026-09", db);
    // Only scheduled and published have a date the calendar can honour. A
    // draft carrying a stale scheduledFor must not appear.
    expect(pieces).toEqual([]);
  });

  it("counts a published piece with no publishedAt instead of dropping it", async () => {
    const tenant = await seedTenant();
    await seedPiece(tenant.id, { status: "published", publishedAt: null });

    const { pieces, undatedPublished } = await readMonth(tenant.id, "2026-09", db);
    // Silently dropping it understates coverage, which is the one thing this
    // view measures. Placing it on a guessed date misstates it.
    expect(pieces).toEqual([]);
    expect(undatedPublished).toBe(1);
  });

  it("does not use a scheduled piece's publishedAt, or the reverse", async () => {
    const tenant = await seedTenant();
    await seedPiece(tenant.id, {
      title: "S", status: "scheduled",
      scheduledFor: new Date("2026-09-10T09:00:00Z"),
      publishedAt: new Date("2026-03-01T09:00:00Z"),
    });
    const { pieces } = await readMonth(tenant.id, "2026-09", db);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].at.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });

  it("excludes a piece outside the padded range", async () => {
    const tenant = await seedTenant();
    await seedPiece(tenant.id, {
      status: "scheduled", scheduledFor: new Date("2026-07-15T09:00:00Z"),
    });
    expect((await readMonth(tenant.id, "2026-09", db)).pieces).toEqual([]);
  });

  it("returns only the calling tenant's pieces", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedPiece(mine.id, { title: "Mine", status: "scheduled", scheduledFor: new Date("2026-09-10T09:00:00Z") });
    await seedPiece(other.id, { title: "Theirs", status: "scheduled", scheduledFor: new Date("2026-09-10T09:00:00Z") });

    const { pieces } = await readMonth(mine.id, "2026-09", db);
    expect(pieces.map((p) => p.title)).toEqual(["Mine"]);
  });
});

describe("bucketByLocalDay", () => {
  const piece = (id: string, iso: string, type: (typeof CALENDAR_TYPES)[number] = "blog_post") => ({
    id, title: id, type, status: "scheduled" as const, at: new Date(iso),
  });

  it("returns one entry per day of the month, empty ones included", () => {
    const days = bucketByLocalDay([], "2026-09");
    expect(days).toHaveLength(30);
    // Every type lane must exist on every day: a missing lane renders as a
    // missing type, not an empty one.
    for (const d of days) {
      expect(Object.keys(d.pieces).sort()).toEqual([...CALENDAR_TYPES].sort());
    }
  });

  it("buckets a piece onto its LOCAL day, not its UTC one", () => {
    // 2026-09-10T23:30Z is the 10th in UTC but the 11th under the pinned
    // Asia/Jerusalem (UTC+3) test zone — vitest.setup.ts pins TZ specifically
    // so this discriminates. The expected key is a LITERAL, not computed via
    // the same local getters the implementation uses (`p.at.getFullYear()`
    // etc.) — a computed-the-same-way expectation is a tautology that would
    // pass even a `getUTCDate()` implementation on a UTC machine, proving
    // nothing. A literal fails against that wrong implementation regardless
    // of which zone the test happens to run in.
    const p = piece("late", "2026-09-10T23:30:00Z");
    const days = bucketByLocalDay([p], "2026-09");
    const found = days.find((d) => d.pieces.blog_post.some((x) => x.id === "late"));
    expect(found?.key).toBe("2026-09-11");
  });

  it("a piece just before local midnight, crossing INTO the month, lands on day 1 (the padded fetch's reason to exist)", () => {
    // 2026-08-31T22:00Z is still August in UTC, but 2026-09-01T01:00 local
    // under UTC+3 — this is exactly the case `monthRangeUtc`'s one-day pad
    // exists to let through, and `bucketByLocalDay` is where it actually
    // gets placed.
    const p = piece("cross-in", "2026-08-31T22:00:00Z");
    const days = bucketByLocalDay([p], "2026-09");
    const day1 = days.find((d) => d.key === "2026-09-01");
    expect(day1?.pieces.blog_post.map((x) => x.id)).toEqual(["cross-in"]);
  });

  it("a piece just after local midnight, crossing OUT of the month, is dropped", () => {
    // 2026-09-30T23:00Z is still September in UTC, but 2026-10-01T02:00
    // local under UTC+3 — the padded fetch over-reads it, and bucketing must
    // drop it since October is not the requested month.
    const p = piece("cross-out", "2026-09-30T23:00:00Z");
    const days = bucketByLocalDay([p], "2026-09");
    expect(days.every((d) => d.pieces.blog_post.length === 0)).toBe(true);
  });

  it("drops a piece whose local day falls outside the month", () => {
    // The padded fetch deliberately over-reads; bucketing is where the month
    // boundary is actually applied, because only here is the zone known.
    const days = bucketByLocalDay([piece("early", "2026-08-15T12:00:00Z")], "2026-09");
    expect(days.every((d) => d.pieces.blog_post.length === 0)).toBe(true);
  });

  it("separates pieces into their type lanes", () => {
    const days = bucketByLocalDay(
      [piece("a", "2026-09-10T12:00:00Z", "blog_post"), piece("b", "2026-09-10T12:00:00Z", "social_post")],
      "2026-09"
    );
    const day = days.find((d) => d.pieces.blog_post.length > 0);
    expect(day?.pieces.blog_post.map((p) => p.id)).toEqual(["a"]);
    expect(day?.pieces.social_post.map((p) => p.id)).toEqual(["b"]);
  });

  it("returns a day's lane sorted by time ascending, regardless of input order", () => {
    // Mirrors readMonth's query, which has no ORDER BY — rows (and so
    // `pieces`) can arrive in any order, and can change between identical
    // reloads. Every card in a lane shows its time, so an unsorted lane can
    // render 21:00 above 09:00 with nothing to explain why.
    const late = piece("late", "2026-09-10T18:00:00Z"); // local 21:00
    const early = piece("early", "2026-09-10T06:00:00Z"); // local 09:00
    const mid = piece("mid", "2026-09-10T11:00:00Z"); // local 14:00
    const days = bucketByLocalDay([late, early, mid], "2026-09");
    const day = days.find((d) => d.key === "2026-09-10");
    expect(day?.pieces.blog_post.map((p) => p.id)).toEqual(["early", "mid", "late"]);
  });

  it("handles a 28-day month and a 31-day one", () => {
    expect(bucketByLocalDay([], "2026-02")).toHaveLength(28);
    expect(bucketByLocalDay([], "2026-01")).toHaveLength(31);
  });
});

describe("isValidMonthParam", () => {
  it("rejects an out-of-range month (00 or 13) and accepts the range's edges (01, 12)", () => {
    expect(isValidMonthParam("2026-00")).toBe(false);
    expect(isValidMonthParam("2026-13")).toBe(false);
    expect(isValidMonthParam("2026-01")).toBe(true);
    expect(isValidMonthParam("2026-12")).toBe(true);
  });

  it("rejects malformed and absent input", () => {
    expect(isValidMonthParam("nonsense")).toBe(false);
    expect(isValidMonthParam("2026-9")).toBe(false); // not zero-padded
    expect(isValidMonthParam(undefined)).toBe(false);
  });
});

describe("resolveMonth", () => {
  const now = new Date("2026-09-15T12:00:00Z");

  it("falls back to now's month when raw is absent", () => {
    expect(resolveMonth(undefined, now)).toBe("2026-09");
  });

  it("falls back to now's month when raw is malformed", () => {
    expect(resolveMonth("nonsense", now)).toBe("2026-09");
  });

  it("falls back to now's month when raw names an out-of-range month (2026-13)", () => {
    expect(resolveMonth("2026-13", now)).toBe("2026-09");
  });

  it("falls back to now's month for a repeated ?month=, which single() collapses to its first value before this ever runs", () => {
    // Mirrors the actual call site in page.tsx: resolveMonth(single(params.month)).
    // "?month=nonsense&month=2026-06" collapses to "nonsense" — malformed, so
    // this still falls back, exactly as it would for a single malformed value.
    expect(resolveMonth(single(["nonsense", "2026-06"]), now)).toBe("2026-09");
  });

  it("passes through a valid, explicit month unchanged", () => {
    expect(resolveMonth("2026-03", now)).toBe("2026-03");
  });
});

describe("shiftMonth", () => {
  it("crosses the year boundary forward: 2026-12 + 1 -> 2027-01", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("crosses the year boundary backward: 2026-01 - 1 -> 2025-12", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("stays within the year for a mid-year shift", () => {
    expect(shiftMonth("2026-06", 1)).toBe("2026-07");
  });
});
