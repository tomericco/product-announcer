import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, companyProfiles, competitors } from "../../src/db/schema";

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const bootstrapMock = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/company-bootstrap", () => ({
  bootstrapCompanyContext: (...args: unknown[]) => bootstrapMock(...args),
}));

import {
  saveCompanyContext,
  addCompetitorAction,
  removeCompetitorAction,
  bootstrapFromWebsite,
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

  it("round-trips the websiteUrl field alongside the prose fields", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form = new FormData();
    form.set("websiteUrl", "  https://acme.com  ");
    form.set("oneLiner", "Issue tracking for software teams.");
    form.set("category", "Project management");
    form.set("positioning", "Fast where incumbents are configurable.");
    form.set("topics", "developer productivity");
    await saveCompanyContext(form);

    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile.websiteUrl).toBe("https://acme.com");
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

  it("ignores a non-string id rather than throwing", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;
    const [row] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" }).returning();

    await expect(removeCompetitorAction(42 as unknown as string)).resolves.toBeUndefined();
    await expect(removeCompetitorAction(null as unknown as string)).resolves.toBeUndefined();

    const [stillThere] = await db.select().from(competitors).where(eq(competitors.id, row.id));
    expect(stillThere).toBeDefined();
  });

  it("reports reason: \"exists\" (not a fresh add) for a case-insensitive duplicate name", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const form1 = new FormData();
    form1.set("name", "GitHub");
    const first = await addCompetitorAction(form1);
    expect(first).toEqual({ ok: true });

    const form2 = new FormData();
    form2.set("name", "github");
    const second = await addCompetitorAction(form2);
    expect(second).toEqual({ ok: true, reason: "exists" });

    const rows = await db.select().from(competitors).where(eq(competitors.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });
});

describe("bootstrapFromWebsite", () => {
  afterEach(() => {
    bootstrapMock.mockClear();
    bootstrapMock.mockResolvedValue({ ok: true });
  });

  it("rejects an empty url without spending a crawl", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const result = await bootstrapFromWebsite("   ");

    expect(result).toEqual({ ok: false, reason: "empty" });
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  it("delegates to bootstrapCompanyContext with the trimmed url", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;

    const result = await bootstrapFromWebsite("  https://acme.com  ");

    expect(bootstrapMock).toHaveBeenCalledWith(tenant.id, "https://acme.com");
    expect(result).toEqual({ ok: true });
  });

  it("surfaces a failed crawl's reason instead of throwing", async () => {
    const tenant = await seed(TENANT);
    currentTenantId = tenant.id;
    bootstrapMock.mockResolvedValue({ ok: false, reason: "blocked" });

    const result = await bootstrapFromWebsite("https://acme.com");

    expect(result).toEqual({ ok: false, reason: "blocked" });
  });
});
