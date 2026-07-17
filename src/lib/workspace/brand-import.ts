import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { brandProfiles } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { fetchUpdatesPageText, type ScrapeResult } from "@/lib/workspace/scrape-updates-page";
import { analyzeBrandStyle, type DerivedBrandProfile } from "@/lib/workspace/analyze-brand-style";

export type ImportBrandStyleDeps = {
  scrape?: (url: string) => Promise<ScrapeResult>;
  analyze?: (text: string) => Promise<DerivedBrandProfile>;
  database?: typeof defaultDb;
};

/**
 * Scrapes the tenant's updates page, derives their brand style, and OVERWRITES
 * the brand profile with it (safe at onboarding, where the profile is fresh).
 * On a scrape error, writes nothing and returns the reason.
 */
export async function importBrandStyleForTenant(
  tenantId: string,
  url: string,
  deps: ImportBrandStyleDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const scrape = deps.scrape ?? fetchUpdatesPageText;
  const analyze = deps.analyze ?? analyzeBrandStyle;
  const database = deps.database ?? defaultDb;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const derived = await analyze(scraped.text);
  const isEmptyDerivation =
    derived.tone === null &&
    derived.readingLevel === null &&
    derived.industry === null &&
    derived.updatesStyleSummary === null &&
    derived.doList.length === 0 &&
    derived.dontList.length === 0 &&
    derived.examplePhrases.length === 0;
  if (isEmptyDerivation) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateBrandProfile(tenantId, database);

  await database
    .update(brandProfiles)
    .set({
      tone: derived.tone,
      readingLevel: derived.readingLevel,
      doList: derived.doList,
      dontList: derived.dontList,
      examplePhrases: derived.examplePhrases,
      industry: derived.industry,
      updatesStyleSummary: derived.updatesStyleSummary,
      updatesPageUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  return { ok: true };
}
