import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import {
  readMonth, bucketByLocalDay, monthRangeUtc, CALENDAR_TYPES,
} from "../../../src/lib/content/calendar";

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
    // 2026-09-10T23:30Z is still the 10th in UTC but the 11th anywhere east of
    // UTC+1. Whichever zone the test runs in, the piece must land on the day a
    // local `Date` says it is — never on the UTC date.
    const p = piece("late", "2026-09-10T23:30:00Z");
    const days = bucketByLocalDay([p], "2026-09");
    const expected = `${p.at.getFullYear()}-${String(p.at.getMonth() + 1).padStart(2, "0")}-${String(p.at.getDate()).padStart(2, "0")}`;
    const found = days.find((d) => d.pieces.blog_post.some((x) => x.id === "late"));
    expect(found?.key).toBe(expected);
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

  it("handles a 28-day month and a 31-day one", () => {
    expect(bucketByLocalDay([], "2026-02")).toHaveLength(28);
    expect(bucketByLocalDay([], "2026-01")).toHaveLength(31);
  });
});
