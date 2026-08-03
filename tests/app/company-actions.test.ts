import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, companyProfiles, competitors } from "../../src/db/schema";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  saveCompanyContext,
  addCompetitorAction,
  removeCompetitorAction,
} from "../../src/app/(dashboard)/company/actions";

const TENANT = "Company Actions Test Tenant";
const OTHER = "Company Actions Other Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seed(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

describe("saveCompanyContext", () => {
  it("persists the prose fields and parsed topics", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("oneLiner", " Issue tracking for software teams. ");
    form.set("category", "Project management");
    form.set("positioning", "Fast where incumbents are configurable.");
    form.set("topics", "developer productivity, issue tracking,, ");
    await saveCompanyContext(form);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBe("Issue tracking for software teams.");
    expect(profile.category).toBe("Project management");
    expect(profile.topics).toEqual(["developer productivity", "issue tracking"]);
  });

  it("stores null rather than an empty string for a cleared prose field", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("oneLiner", "   ");
    form.set("category", "");
    form.set("positioning", "");
    form.set("topics", "");
    await saveCompanyContext(form);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.oneLiner).toBeNull();
    expect(profile.topics).toEqual([]);
  });
});

describe("competitor actions", () => {
  it("refuses a blank name without inserting", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("name", "   ");
    const result = await addCompetitorAction(form);
    expect(result).toEqual({ ok: false, reason: "empty-name" });
    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });

  it("cannot remove a competitor belonging to another tenant", async () => {
    const mine = await seed(TENANT);
    const theirs = await seed(OTHER);
    const [victim] = await db
      .insert(competitors)
      .values({ tenantId: theirs.id, name: "Jira" })
      .returning();

    currentTenantId = mine.id;
    await removeCompetitorAction(victim.id);

    const [stillThere] = await db.select().from(competitors).where(eq(competitors.id, victim.id));
    expect(stillThere).toBeDefined();
  });
});
