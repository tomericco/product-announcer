import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { tenants } from "../db/schema";

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
