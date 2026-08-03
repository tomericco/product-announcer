import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { competitors, type Competitor } from "@/db/schema";

export async function listCompetitors(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Competitor[]> {
  return database
    .select()
    .from(competitors)
    .where(eq(competitors.tenantId, tenantId))
    .orderBy(asc(competitors.name));
}

/**
 * Adds a competitor, or returns the existing row when the name is already
 * present for this tenant. Idempotent so a re-run of the bootstrap tops up the
 * list instead of failing on the unique index.
 */
export async function addCompetitor(
  tenantId: string,
  input: { name: string; websiteUrl: string | null },
  database: typeof defaultDb = defaultDb
): Promise<Competitor> {
  const name = input.name.trim();
  const [row] = await database
    .insert(competitors)
    .values({ tenantId, name, websiteUrl: input.websiteUrl })
    .onConflictDoNothing({ target: [competitors.tenantId, competitors.name] })
    .returning();
  if (row) return row;

  const [existing] = await database
    .select()
    .from(competitors)
    .where(and(eq(competitors.tenantId, tenantId), eq(competitors.name, name)))
    .limit(1);
  return existing;
}

/** Scoped by tenant so an id from another workspace cannot delete a row. */
export async function removeCompetitor(
  tenantId: string,
  id: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database.delete(competitors).where(and(eq(competitors.tenantId, tenantId), eq(competitors.id, id)));
}
