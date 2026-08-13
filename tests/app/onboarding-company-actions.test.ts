import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "../../src/db";
import { tenants, companyProfiles } from "../../src/db/schema";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: async () => ({ user: { id: "u1", tenantId: currentTenantId } }),
}));

const bootstrap = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/company-bootstrap", () => ({
  bootstrapCompanyContext: (...args: unknown[]) => bootstrap(...args),
}));

const importBrandStyleForTenant = vi.fn(
  async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string }
);
vi.mock("../../src/lib/workspace/brand-import", () => ({
  importBrandStyleForTenant: (...args: unknown[]) => importBrandStyleForTenant(...args),
}));

import {
  bootstrapOnboardingCompany,
  saveOnboardingCompany,
  skipBrandStep,
  importBrandStyle,
} from "../../src/app/onboarding/actions";

const TENANT = "Onboarding Company Actions Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT, onboardingStep: 2 }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedCompleted() {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: TENANT, onboardingStep: 2, onboardingCompletedAt: new Date() })
    .returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function storedStep(tenantId: string) {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return row.onboardingStep;
}

async function storedProfile(tenantId: string) {
  const [row] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
  return row;
}

beforeEach(() => {
  vi.mocked(redirect).mockClear();
  bootstrap.mockClear();
  bootstrap.mockResolvedValue({ ok: true });
  importBrandStyleForTenant.mockClear();
  importBrandStyleForTenant.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("bootstrapOnboardingCompany", () => {
  it("drafts the profile and stays on step 2 for review, rather than advancing the wizard", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).toHaveBeenCalledWith(tenant.id, "https://acme.com");
    expect(await storedStep(tenant.id)).toBe(2);
    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?drafted=1");
  });

  it("keeps the user on step 2 when the crawl fails, carrying the reason so the page can tell a blocked site apart from other failures", async () => {
    const tenant = await seed();
    bootstrap.mockResolvedValue({ ok: false, reason: "blocked" });
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?bootstrap=blocked");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("carries an analysis-empty reason distinctly from a crawl failure, since the advice differs", async () => {
    const tenant = await seed();
    bootstrap.mockResolvedValue({ ok: false, reason: "analysis-empty" });
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?bootstrap=analysis-empty");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("rejects an empty url without spending a crawl", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("websiteUrl", "   ");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?error=empty");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("respects the completion guard and does not spend a crawl on a replayed call", async () => {
    const tenant = await seedCompleted();
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/briefs");
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile).toBeUndefined();
  });
});

describe("saveOnboardingCompany", () => {
  it("persists the edited fields, advances to step 3, and continues the wizard", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("oneLiner", " Issue tracking for software teams. ");
    form.set("category", "Project management");
    form.set("positioning", "Fast where incumbents are configurable.");
    form.set("topics", "developer productivity, issue tracking,, ");

    await saveOnboardingCompany(form);

    const profile = await storedProfile(tenant.id);
    expect(profile.oneLiner).toBe("Issue tracking for software teams.");
    expect(profile.category).toBe("Project management");
    expect(profile.positioning).toBe("Fast where incumbents are configurable.");
    expect(profile.topics).toEqual(["developer productivity", "issue tracking"]);
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });

  it("respects the completion guard and does not touch the profile on a replayed call", async () => {
    const tenant = await seedCompleted();
    const form = new FormData();
    form.set("oneLiner", "Should not be written");

    await saveOnboardingCompany(form);

    expect(redirect).toHaveBeenCalledWith("/briefs");
    const [profile] = await db.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenant.id));
    expect(profile).toBeUndefined();
  });
});

describe("skipBrandStep", () => {
  it("still advances past the step (existing behavior must survive)", async () => {
    const tenant = await seed();
    await skipBrandStep();
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });
});

describe("importBrandStyle", () => {
  it("returns to the review page rather than advancing on success, now that it's a tertiary action below the profile review", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("updatesPageUrl", "https://acme.com/changelog");

    await importBrandStyle(form);

    expect(importBrandStyleForTenant).toHaveBeenCalledWith(tenant.id, "https://acme.com/changelog");
    expect(redirect).toHaveBeenCalledWith("/onboarding/brand");
    // Unlike the old advance-and-redirect behavior, the step must not move --
    // advancing here would skip the profile review and strand any unsaved edits.
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("keeps the failure branch unchanged: a failed scrape stays on step 2 with brandImport=failed", async () => {
    const tenant = await seed();
    importBrandStyleForTenant.mockResolvedValue({ ok: false, reason: "blocked" });
    const form = new FormData();
    form.set("updatesPageUrl", "https://acme.com/changelog");

    await importBrandStyle(form);

    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?brandImport=failed");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("rejects an empty url without spending a scrape", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("updatesPageUrl", "   ");

    await importBrandStyle(form);

    expect(importBrandStyleForTenant).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?error=empty");
    expect(await storedStep(tenant.id)).toBe(2);
  });

  it("keeps its cost guard unchanged: a replayed call after onboarding is done never scrapes", async () => {
    const tenant = await seedCompleted();
    const form = new FormData();
    form.set("updatesPageUrl", "https://acme.com/changelog");

    await importBrandStyle(form);

    expect(importBrandStyleForTenant).not.toHaveBeenCalled();
    expect(redirect).toHaveBeenCalledWith("/briefs");
    expect(await storedStep(tenant.id)).toBe(2);
  });
});
