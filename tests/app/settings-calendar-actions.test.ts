import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1", role: "owner" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveCalendarSettings } from "../../src/app/(dashboard)/settings/actions";
import { normalizeWeekStart, parseHolidayCountries } from "../../src/lib/workspace/calendar-settings";

const TENANT = "Calendar Settings Test Tenant";
const OTHER = "Calendar Settings Other Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seed(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

async function reload(id: string) {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, id));
  return row;
}

function form(fields: { weekStartsOn?: string; countries?: string[] }) {
  const data = new FormData();
  if (fields.weekStartsOn !== undefined) data.set("weekStartsOn", fields.weekStartsOn);
  for (const code of fields.countries ?? []) data.append("holidayCountries", code);
  return data;
}

describe("the tenants columns' defaults", () => {
  it("start a brand-new workspace on Sunday with no holiday countries", () => {
    // The default is not cosmetic: it is what keeps every workspace that
    // predates these columns rendering exactly the grid it rendered before.
    return seed(TENANT).then(async (tenant) => {
      const row = await reload(tenant.id);
      expect(row.weekStartsOn).toBe(0);
      expect(row.holidayCountries).toEqual([]);
    });
  });
});

describe("saveCalendarSettings", () => {
  it("round-trips a Monday start and a pair of countries", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    await saveCalendarSettings(form({ weekStartsOn: "1", countries: ["IL", "GB"] }));

    const row = await reload(tenant.id);
    expect(row.weekStartsOn).toBe(1);
    expect(row.holidayCountries).toEqual(["IL", "GB"]);
  });

  it("clears the countries when every box is unticked", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    await saveCalendarSettings(form({ weekStartsOn: "1", countries: ["IL", "US", "DE", "GB"] }));
    await saveCalendarSettings(form({ weekStartsOn: "0", countries: [] }));

    const row = await reload(tenant.id);
    expect(row.weekStartsOn).toBe(0);
    expect(row.holidayCountries).toEqual([]);
  });

  it("drops a country code the UI never offered", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    await saveCalendarSettings(form({ weekStartsOn: "0", countries: ["IL", "ZZ", "FR"] }));

    expect((await reload(tenant.id)).holidayCountries).toEqual(["IL"]);
  });

  it("falls back to a Sunday start for a week-start value that isn't 0 or 1", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    await saveCalendarSettings(form({ weekStartsOn: "1" }));
    await saveCalendarSettings(form({ weekStartsOn: "9" }));

    expect((await reload(tenant.id)).weekStartsOn).toBe(0);
  });

  it("writes only the acting workspace's row — the other tenant is untouched BY ID", async () => {
    const tenant = await seed(TENANT);
    const other = await seed(OTHER);
    // Give the bystander non-default values first, so "untouched" is a real
    // assertion about ITS row rather than a coincidence of the column
    // defaults matching whatever the acting tenant did not write.
    currentTenantId = other.id;
    await saveCalendarSettings(form({ weekStartsOn: "1", countries: ["DE"] }));

    currentTenantId = tenant.id;
    await saveCalendarSettings(form({ weekStartsOn: "0", countries: ["US"] }));

    const bystander = await reload(other.id);
    expect(bystander.weekStartsOn).toBe(1);
    expect(bystander.holidayCountries).toEqual(["DE"]);

    const acting = await reload(tenant.id);
    expect(acting.weekStartsOn).toBe(0);
    expect(acting.holidayCountries).toEqual(["US"]);
  });
});

describe("normalizeWeekStart", () => {
  it("accepts the two real values", () => {
    expect(normalizeWeekStart("0")).toBe(0);
    expect(normalizeWeekStart("1")).toBe(1);
    expect(normalizeWeekStart(0)).toBe(0);
    expect(normalizeWeekStart(1)).toBe(1);
  });

  it("falls back to Sunday for anything else", () => {
    expect(normalizeWeekStart(null)).toBe(0);
    expect(normalizeWeekStart(undefined)).toBe(0);
    expect(normalizeWeekStart("")).toBe(0);
    expect(normalizeWeekStart("2")).toBe(0);
    expect(normalizeWeekStart("Monday")).toBe(0);
    expect(normalizeWeekStart(-1)).toBe(0);
  });
});

describe("parseHolidayCountries", () => {
  it("keeps the offered codes in the offered order, whatever order they arrive in", () => {
    expect(parseHolidayCountries(["GB", "IL"])).toEqual(["IL", "GB"]);
  });

  it("drops unknown codes and duplicates", () => {
    expect(parseHolidayCountries(["IL", "IL", "ZZ"])).toEqual(["IL"]);
  });

  it("returns an empty list for no input", () => {
    expect(parseHolidayCountries([])).toEqual([]);
  });
});
