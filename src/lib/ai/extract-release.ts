import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { releases, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { generateExtractedDraft } from "@/lib/ai/generation";
import { reviewAndReconcile } from "@/lib/ai/review-draft";
import { validateDraftLinks } from "@/lib/ai/validate-links";
import type { OnDraftProgress } from "@/lib/scheduling/draft-progress";

type Database = typeof defaultDb;

export type ExtractDeps = {
  generateDraft?: typeof generateExtractedDraft;
  review?: typeof reviewAndReconcile;
};

/**
 * Splits a passage out of an existing draft into a draft of its own, through
 * the SAME generate → review-against-brand-guidelines → validate-links pipeline
 * as the initial compose (compare `runWholeEditForRelease`, which runs that
 * pipeline over a whole body instead).
 *
 * `remainingBody` is computed by the CLIENT, not derived here: MDXEditor
 * serializes a selection independently of the whole document, so the excerpt is
 * not reliably a substring of the body and a server-side string removal would
 * fail silently or cut the wrong occurrence. This function persists what it is
 * given.
 *
 * The insert of the new release and the rewrite of the source body share one
 * transaction, so the passage is never present in two drafts at once. The new
 * release deliberately claims NO atomic updates — see the design spec's
 * "Known consequences".
 *
 * Returns null (after emitting an error event) when the release doesn't exist
 * or the split would empty the source draft.
 */
export async function runExtractForRelease(
  args: {
    releaseId: string;
    excerpt: string;
    remainingBody: string;
    instruction: string;
    editedBy: string;
  },
  database: Database = defaultDb,
  onProgress?: OnDraftProgress,
  deps: ExtractDeps = {}
): Promise<{ releaseId: string; title: string } | null> {
  const generateDraft = deps.generateDraft ?? generateExtractedDraft;
  const review = deps.review ?? reviewAndReconcile;
  const emit: OnDraftProgress = onProgress ?? (() => {});

  const [source] = await database.select().from(releases).where(eq(releases.id, args.releaseId));
  if (!source) {
    emit({ type: "error", message: "Update not found." });
    return null;
  }

  // Refusing this is not cosmetic: `resolveBody` in drafts/actions.ts reads a
  // blank submitted body as an editor parse failure and falls back to the
  // stored text, so an emptied source draft would silently resurrect the very
  // passage we just moved out of it.
  if (args.remainingBody.trim().length === 0) {
    emit({ type: "error", message: "You can't extract the entire update — leave some text behind." });
    return null;
  }

  if (args.excerpt.trim().length === 0) {
    emit({ type: "error", message: "Nothing was selected to extract." });
    return null;
  }

  emit({ type: "step", key: "preparing", status: "start" });
  const brandProfile = await getOrCreateBrandProfile(source.tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  // Prose carries no category, so example selection leans on industry/personas
  // only — same call shape as the whole-update edit path.
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: [],
  });
  emit({ type: "step", key: "preparing", status: "done" });

  emit({ type: "step", key: "generating", status: "start" });
  const generated = await generateDraft({
    excerpt: args.excerpt,
    instruction: args.instruction,
    brandProfile,
    personas,
    examples,
  });
  emit({ type: "step", key: "generating", status: "done" });

  emit({ type: "step", key: "reviewing", status: "start" });
  const outcome = await review(generated, brandProfile, emit);
  emit({ type: "step", key: "reviewing", status: "done" });

  // Validate links on the FINAL body — after review, which may itself rewrite
  // links — so no unresolvable URL is persisted (see `validateDraftLinks`).
  const { body: validatedBody } = await validateDraftLinks(outcome.finalDraft.body);

  emit({ type: "step", key: "saving", status: "start" });
  // One timestamp for both rows, so the split reads as a single event.
  const now = new Date();
  const created = await database.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(releases)
      .values({
        tenantId: source.tenantId,
        title: outcome.finalDraft.title,
        body: validatedBody,
        // Has a DB default, but set explicitly: this is the baseline that
        // catch-up deltas measure against, so it belongs in the creating code.
        composedAt: now,
        reviewStatus: outcome.status,
        reviewIssues: outcome.issues,
        reviewedAt: now,
        editedBy: args.editedBy,
      })
      .returning();

    await tx
      .update(releases)
      .set({ body: args.remainingBody, bodyEditedAt: now, editedBy: args.editedBy })
      .where(eq(releases.id, source.id));

    return inserted;
  });
  emit({ type: "step", key: "saving", status: "done" });

  emit({ type: "done", updateId: created.id });
  return { releaseId: created.id, title: created.title };
}
