import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { companyProfiles } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { fetchPageText, type PageResult } from "@/lib/workspace/fetch-page";
import { deriveUpdateTemplate } from "@/lib/workspace/derive-update-template";

export type ImportUpdateTemplateDeps = {
  scrape?: (url: string) => Promise<PageResult>;
  derive?: (text: string, tenantId: string) => Promise<string | null>;
  database?: typeof defaultDb;
};

/**
 * Scrapes the tenant's updates page and derives their product update template
 * from it — the markdown skeleton their changelog actually follows.
 *
 * The sibling of `importBrandStyleForTenant` (`./brand-import`), deliberately
 * separate rather than a second field on that call. The two analyses read the
 * same page but answer different questions: that one asks how the company
 * SOUNDS, this one asks what shape their updates TAKE. They were one call until
 * 2026-08-31, and coupling them meant every attempt at iterating on the less
 * reliable of the two overwrote hand-tuned guidelines as a side effect.
 *
 * Independence buys three things. Either can be re-run alone from its own
 * section in Company settings. Either can fail without reporting the other as
 * failed — a page giving good guidelines and no consistent structure is a
 * normal outcome, not a broken import. And each writes only its own column, so
 * neither can clear the other's.
 *
 * `updatesPageUrl` is written by BOTH importers, since it records where the
 * company's updates live rather than belonging to either analysis. Whichever
 * ran last wins, and they are expected to agree — the settings UI seeds both
 * inputs from this same column.
 *
 * On a scrape error, or a derivation that produced nothing usable, writes
 * NOTHING and returns the reason. A null derivation specifically must not
 * reach the update, because null on this column is meaningful: it selects the
 * pre-template prompt, and an import that silently cleared a hand-written
 * template would be indistinguishable from one that never ran.
 */
export async function importProductUpdateTemplateForTenant(
  tenantId: string,
  url: string,
  deps: ImportUpdateTemplateDeps = {}
): Promise<{ ok: boolean; reason?: string }> {
  const scrape = deps.scrape ?? fetchPageText;
  const derive = deps.derive ?? deriveUpdateTemplate;
  const database = deps.database ?? defaultDb;

  const scraped = await scrape(url);
  if ("error" in scraped) return { ok: false, reason: scraped.error };

  const productUpdateTemplate = await derive(scraped.text, tenantId);
  // `deriveUpdateTemplate` returns null both when the page shows no consistent
  // structure and when the model call failed. Neither is a value to persist —
  // see the note above on why a null write is worse than no write.
  if (productUpdateTemplate === null) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateCompanyProfile(tenantId, database);

  await database
    .update(companyProfiles)
    .set({ productUpdateTemplate, updatesPageUrl: url, updatedAt: new Date() })
    .where(eq(companyProfiles.id, profile.id));

  return { ok: true };
}
