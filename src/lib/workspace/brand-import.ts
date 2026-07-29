import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { brandProfiles } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { fetchUpdatesPageText, type ScrapeResult } from "@/lib/workspace/scrape-updates-page";
import { analyzeBrandStyle, type DerivedBrandProfile } from "@/lib/workspace/analyze-brand-style";

export type ImportBrandStyleDeps = {
  scrape?: (url: string) => Promise<ScrapeResult>;
  analyze?: (text: string, tenantId: string) => Promise<DerivedBrandProfile>;
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

  const derived = await analyze(scraped.text, tenantId);
  const isEmptyDerivation = derived.guidelines === null && derived.industry === null;
  if (isEmptyDerivation) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateBrandProfile(tenantId, database);

  await database
    .update(brandProfiles)
    .set({
      guidelines: derived.guidelines,
      industry: derived.industry,
      updatesPageUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  return { ok: true };
}
