import { db as defaultDb } from "@/db";
import { systemPersonas, systemContentExamples, type companyProfiles, type ResolvedPersona } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import type { ContentType } from "@/lib/ai/compose-prompt";

type Database = typeof defaultDb;

/**
 * The prompt context every generation path needs: the tenant's brand profile,
 * its resolved personas, and the few-shot examples chosen for it. Four callers
 * assembled this identically before it was shared — the compose run, the
 * whole-update edit, the extract split, and the scoped agent edit.
 *
 * The `categories` argument is gone. Its only caller was the release
 * composition, which biased example selection by the categories of the atomic
 * updates it was about to write up — and the release path no longer sends
 * few-shot examples at all: the tenant's own product update template is the
 * structural exemplar now. Nothing else ever had categories to offer.
 */
export async function prepareGenerationContext(
  tenantId: string,
  database: Database = defaultDb,
  contentType: ContentType = "product_update"
): Promise<{
  brandProfile: typeof companyProfiles.$inferSelect;
  personas: ResolvedPersona[];
  examples: (typeof systemContentExamples.$inferSelect)[];
}> {
  const brandProfile = await getOrCreateCompanyProfile(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemContentExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    contentType,
    categories: [],
  });
  return { brandProfile, personas, examples };
}
