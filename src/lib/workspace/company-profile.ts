import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { companyProfiles } from "@/db/schema";

export async function getOrCreateCompanyProfile(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<typeof companyProfiles.$inferSelect> {
  const existing = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId)).limit(1);
  if (existing.length > 0) return existing[0];

  const [created] = await database.insert(companyProfiles).values({ tenantId }).onConflictDoNothing().returning();
  if (created) return created;

  // A concurrent caller inserted the row between our select and insert; the
  // onConflictDoNothing produced no row, so re-select the now-present one.
  const [afterConflict] = await database
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.tenantId, tenantId))
    .limit(1);
  return afterConflict;
}
