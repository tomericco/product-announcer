import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { brandProfiles } from "../db/schema";

export async function getOrCreateBrandProfile(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<typeof brandProfiles.$inferSelect> {
  const existing = await database.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await database.insert(brandProfiles).values({ tenantId }).onConflictDoNothing().returning();
  if (created) return created;

  // A concurrent caller inserted the row between our select and insert; the
  // onConflictDoNothing produced no row, so re-select the now-present one.
  const [afterConflict] = await database
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.tenantId, tenantId))
    .limit(1);
  return afterConflict;
}
