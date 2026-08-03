import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: async () => ({ user: { id: "u1", tenantId: currentTenantId } }),
}));

const bootstrap = vi.fn(async (..._args: unknown[]) => ({ ok: true }) as { ok: boolean; reason?: string });
vi.mock("../../src/lib/workspace/company-bootstrap", () => ({
  bootstrapCompanyContext: (...args: unknown[]) => bootstrap(...args),
}));

import { bootstrapOnboardingCompany, skipBrandStep } from "../../src/app/onboarding/actions";

const TENANT = "Onboarding Company Actions Test Tenant";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT, onboardingStep: 2 }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function storedStep(tenantId: string) {
  const [row] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  return row.onboardingStep;
}

beforeEach(() => {
  vi.mocked(redirect).mockClear();
  bootstrap.mockClear();
  bootstrap.mockResolvedValue({ ok: true });
});

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

describe("bootstrapOnboardingCompany", () => {
  it("advances to step 3 and continues the wizard on success", async () => {
    const tenant = await seed();
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(bootstrap).toHaveBeenCalledWith(tenant.id, "https://acme.com");
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });

  it("keeps the user on step 2 when the crawl fails, so a blocked site is not a dead end", async () => {
    const tenant = await seed();
    bootstrap.mockResolvedValue({ ok: false, reason: "blocked" });
    const form = new FormData();
    form.set("websiteUrl", "https://acme.com");

    await bootstrapOnboardingCompany(form);

    expect(redirect).toHaveBeenCalledWith("/onboarding/brand?bootstrap=failed");
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
});

describe("skipBrandStep", () => {
  it("still advances past the step (existing behavior must survive)", async () => {
    const tenant = await seed();
    await skipBrandStep();
    expect(await storedStep(tenant.id)).toBe(3);
    expect(redirect).toHaveBeenCalledWith("/onboarding/connect");
  });
});
