import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants } from "../../../src/db/schema";
import {
  isOnboardingComplete,
  markOnboardingComplete,
  getOnboardingState,
  advanceOnboardingStep,
} from "../../../src/lib/workspace/onboarding";

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

describe("onboarding step storage", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Onboarding Step Tenant"));
  });

  async function newTenant() {
    const [tenant] = await db.insert(tenants).values({ name: "Onboarding Step Tenant" }).returning();
    return tenant.id;
  }

  it("starts a fresh tenant on step 1", async () => {
    const id = await newTenant();
    expect(await getOnboardingState(id)).toEqual({ completed: false, storedStep: 1 });
  });

  it("advances forward", async () => {
    const id = await newTenant();
    await advanceOnboardingStep(id, 3);
    expect((await getOnboardingState(id)).storedStep).toBe(3);
  });

  // Browser Back then re-submitting step 1 must not rewind someone on step 3.
  it("never moves backward", async () => {
    const id = await newTenant();
    await advanceOnboardingStep(id, 3);
    await advanceOnboardingStep(id, 2);
    expect((await getOnboardingState(id)).storedStep).toBe(3);
  });

  it("reports completion", async () => {
    const id = await newTenant();
    await markOnboardingComplete(id);
    expect((await getOnboardingState(id)).completed).toBe(true);
  });
});
