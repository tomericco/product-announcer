import { eq, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tenants } from "@/db/schema";
import type { OnboardingStep } from "./onboarding-step";

export async function isOnboardingComplete(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<boolean> {
  const [tenant] = await database
    .select({ onboardingCompletedAt: tenants.onboardingCompletedAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return Boolean(tenant?.onboardingCompletedAt);
}

export async function markOnboardingComplete(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database.update(tenants).set({ onboardingCompletedAt: new Date() }).where(eq(tenants.id, tenantId));
}

export async function getOnboardingState(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ completed: boolean; storedStep: number }> {
  const [tenant] = await database
    .select({ onboardingCompletedAt: tenants.onboardingCompletedAt, onboardingStep: tenants.onboardingStep })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return {
    completed: Boolean(tenant?.onboardingCompletedAt),
    storedStep: tenant?.onboardingStep ?? 1,
  };
}

/**
 * Move the tenant's progress forward. Monotonic: GREATEST is evaluated in SQL, so
 * re-submitting an earlier step (browser Back, then Save) cannot rewind someone
 * already further along, and a form submit racing an OAuth return cannot lose an
 * update the way read-then-write would.
 */
export async function advanceOnboardingStep(
  tenantId: string,
  step: OnboardingStep,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database
    .update(tenants)
    .set({ onboardingStep: sql`GREATEST(${tenants.onboardingStep}, ${step})` })
    .where(eq(tenants.id, tenantId));
}
