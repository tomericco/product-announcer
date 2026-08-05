import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { sources, type Source } from "@/db/schema";

/**
 * All of a tenant's `competitor_web` sources, ordered by competitor then
 * label, for the source-health surface in `/company`. Scoped to
 * `competitor_web` on purpose: spec 4's null-url `news` sources have no
 * competitor to attach to in that view and would need their own treatment.
 */
export async function listCompetitorSources(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Source[]> {
  return database
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "competitor_web")))
    .orderBy(asc(sources.competitorId), asc(sources.label));
}

/**
 * The tenant's one `news` source, if they've opted in via `setNewsWatching`.
 * Unlike `listCompetitorSources`, there's at most one row: the null-url
 * identity index from spec 4 (`sources_tenant_type_null_url_unique`)
 * enforces that. Null before the first opt-in.
 */
export async function getNewsSource(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<Source | null> {
  const [source] = await database
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.type, "news")));
  return source ?? null;
}
