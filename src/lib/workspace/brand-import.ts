import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { companyProfiles } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { analyzeBrandStyle, type DerivedBrandProfile } from "@/lib/workspace/analyze-brand-style";

export type ImportBrandStyleDeps = {
  scrape?: (url: string) => Promise<PageResult>;
  analyze?: (text: string, tenantId: string) => Promise<DerivedBrandProfile>;
  database?: typeof defaultDb;
};

/**
 * Scrapes the tenant's updates page, derives their brand style, and OVERWRITES
 * the brand profile with it (safe at onboarding, where the profile is fresh).
 * On a scrape error, writes nothing and returns the reason.
 *
 * Derives VOICE ONLY — guidelines and industry. The product update template is
 * derived by `importProductUpdateTemplateForTenant` (`./template-import`),
 * which scrapes the same page independently.
 *
 * The two were one call until 2026-08-31. Splitting them is what lets a person
 * re-run either analysis without disturbing the other, which matters because
 * the template derivation is the less reliable of the two: iterating on it used
 * to mean overwriting hand-tuned guidelines every attempt. They also fail
 * independently now — a page that yields good guidelines and no usable
 * structure no longer reports as a failed import.
 */
export async function importBrandStyleForTenant(
  tenantId: string,
  url: string,
  deps: ImportBrandStyleDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const scrape = deps.scrape ?? fetchPageText;
  const analyze = deps.analyze ?? analyzeBrandStyle;
  const database = deps.database ?? defaultDb;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const derived = await analyze(scraped.text, tenantId);
  // Normalize blank-string derivations to null here, at the one place both
  // downstream problems originate: the empty-derivation guard below only
  // checked `=== null` (so a blank string slipped past it and got persisted),
  // and the editor's `defaultValue ?? GUIDELINES_TEMPLATE` treats "" as
  // configured (opening blank instead of templated). Trimming and folding
  // blank into null here fixes both at the source.
  const guidelines = derived.guidelines?.trim() || null;
  const industry = derived.industry?.trim() || null;
  const isEmptyDerivation = guidelines === null && industry === null;
  if (isEmptyDerivation) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateCompanyProfile(tenantId, database);

  await database
    .update(companyProfiles)
    .set({
      // A null derived field means "the model couldn't infer this from a
      // sparse page" -- not "the user wants it cleared". Never let that
      // overwrite a value the team already wrote by hand; only write fields
      // the analysis actually produced.
      ...(guidelines !== null && { guidelines }),
      ...(industry !== null && { industry }),
      updatesPageUrl: url,
      updatedAt: new Date(),
    })
    .where(eq(companyProfiles.id, profile.id));

  return { ok: true };
}
