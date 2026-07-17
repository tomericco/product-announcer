import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";
import { isOnboardingComplete, markOnboardingComplete } from "../../../src/lib/workspace/onboarding";

describe("onboarding gate", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Onboarding Test Tenant"));
  });

  it("is false for a freshly created tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Onboarding Test Tenant" }).returning();
    expect(await isOnboardingComplete(tenant.id)).toBe(false);
  });

  it("becomes true once markOnboardingComplete is called — even with zero repos", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Onboarding Test Tenant" }).returning();

    await markOnboardingComplete(tenant.id);

    expect(await isOnboardingComplete(tenant.id)).toBe(true);
  });
});
