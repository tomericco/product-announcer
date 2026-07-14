import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { brandProfiles } from "../db/schema";

export async function getOrCreateBrandProfile(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<typeof brandProfiles.$inferSelect> {
  const existing = await database.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await database.insert(brandProfiles).values({ tenantId }).returning();
  return created;
}
