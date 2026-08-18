import { and, asc, eq, sql } from "drizzle-orm";
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
 *
 * The lookup is case-insensitive even though the unique index below is not:
 * an LLM re-run emitting "GitHub" then "Github" would otherwise create two
 * rows for the same competitor, which is exactly what that index's comment
 * says it prevents. First-seen spelling wins (mirrors parse-topics.ts's
 * dedupe). A later run that now knows a URL for a competitor we only had a
 * bare name for backfills it, but never clobbers one already set.
 *
 * Returns `undefined` when a concurrent insert of the exact same
 * tenant+name wins the race between this function's own lookup and its
 * insert -- callers must not assume a row always comes back.
 */
export async function addCompetitor(
  tenantId: string,
  input: { name: string; websiteUrl: string | null },
  database: typeof defaultDb = defaultDb
): Promise<Competitor | undefined> {
  const name = input.name.trim();
  const websiteUrl = input.websiteUrl;

  const [existing] = await database
    .select()
    .from(competitors)
    .where(and(eq(competitors.tenantId, tenantId), sql`lower(${competitors.name}) = lower(${name})`))
    .limit(1);
  if (existing) {
    if (!existing.websiteUrl && websiteUrl) {
      const [updated] = await database
        .update(competitors)
        .set({ websiteUrl })
        .where(eq(competitors.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

  const [row] = await database
    .insert(competitors)
    .values({ tenantId, name, websiteUrl })
    .onConflictDoNothing({ target: [competitors.tenantId, competitors.name] })
    .returning();
  if (row) return row;

  // Lost a race against a concurrent insert of the exact same tenant+name.
  const [raced] = await database
    .select()
    .from(competitors)
    .where(and(eq(competitors.tenantId, tenantId), eq(competitors.name, name)))
    .limit(1);
  return raced;
}

/** Scoped by tenant so an id from another workspace cannot delete a row. */
export async function removeCompetitor(
  tenantId: string,
  id: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database.delete(competitors).where(and(eq(competitors.tenantId, tenantId), eq(competitors.id, id)));
}
