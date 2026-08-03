import { db as defaultDb } from "@/db";
import { systemPersonas, systemUpdateExamples, type companyProfiles, type ResolvedPersona } from "@/db/schema";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";

type Database = typeof defaultDb;

/**
 * The prompt context every generation path needs: the tenant's brand profile,
 * its resolved personas, and the few-shot examples chosen for it. Four callers
 * assembled this identically before it was shared — the compose run, the
 * whole-update edit, the extract split, and the scoped agent edit.
 *
 * `categories` biases example selection toward the kinds of changes being
 * written about. Only the compose run has categories to offer (from its atomic
 * updates); prose-driven callers pass none.
 */
export async function prepareGenerationContext(
  tenantId: string,
  database: Database = defaultDb,
  categories: string[] = []
): Promise<{
  brandProfile: typeof companyProfiles.$inferSelect;
  personas: ResolvedPersona[];
  examples: (typeof systemUpdateExamples.$inferSelect)[];
}> {
  const brandProfile = await getOrCreateCompanyProfile(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories,
  });
  return { brandProfile, personas, examples };
}
