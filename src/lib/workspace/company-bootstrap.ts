import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { companyProfiles } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { crawlCompanySite, type CrawlResult } from "@/lib/workspace/crawl-company-site";
import { analyzeCompanyContext, type DerivedCompanyContext } from "@/lib/workspace/analyze-company-context";
import { addCompetitor } from "@/lib/workspace/competitors";

export type BootstrapDeps = {
  crawl?: (url: string) => Promise<CrawlResult>;
  analyze?: (text: string, tenantId: string) => Promise<DerivedCompanyContext>;
  database?: typeof defaultDb;
};

/**
 * Crawls the company's own site and drafts their profile for a human to correct.
 *
 * Mirrors `importBrandStyleForTenant`: a null derived field means "the pages gave
 * the model nothing to go on", never "the user wants this cleared", so only
 * fields the analysis actually produced are written. Competitors are topped up
 * rather than replaced, since the human may have added their own.
 */
export async function bootstrapCompanyContext(
  tenantId: string,
  url: string,
  deps: BootstrapDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const crawl = deps.crawl ?? crawlCompanySite;
  const analyze = deps.analyze ?? analyzeCompanyContext;
  const database = deps.database ?? defaultDb;

  const crawled = await crawl(url);
  if ("error" in crawled) return { ok: false, reason: crawled.error };

  const derived = await analyze(crawled.text, tenantId);

  const oneLiner = derived.oneLiner?.trim() || null;
  const category = derived.category?.trim() || null;
  const positioning = derived.positioning?.trim() || null;
  const topics = derived.topics.map((t) => t.trim()).filter(Boolean);
  const namedCompetitors = derived.competitors.filter((c) => c.name.trim().length > 0);

  const isEmpty =
    oneLiner === null && category === null && positioning === null &&
    topics.length === 0 && namedCompetitors.length === 0;
  if (isEmpty) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateCompanyProfile(tenantId, database);

  await database
    .update(companyProfiles)
    .set({
      ...(oneLiner !== null && { oneLiner }),
      ...(category !== null && { category }),
      ...(positioning !== null && { positioning }),
      ...(topics.length > 0 && { topics }),
      websiteUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  for (const competitor of namedCompetitors) {
    await addCompetitor(tenantId, { name: competitor.name, websiteUrl: competitor.websiteUrl }, database);
  }

  return { ok: true };
}
