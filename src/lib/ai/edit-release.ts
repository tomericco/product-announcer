import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { releases, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { editReleaseBody } from "@/lib/ai/edit";
import { reviewAndReconcile } from "@/lib/ai/review-draft";
import { validateDraftLinks } from "@/lib/ai/validate-links";
import type { OnDraftProgress } from "@/lib/scheduling/draft-progress";

type Database = typeof defaultDb;

export type WholeEditDeps = {
  generateEdit?: typeof editReleaseBody;
  review?: typeof reviewAndReconcile;
};

/**
 * Whole-update agent edit that runs the SAME generate → review-against-brand-
 * guidelines → save pipeline as the initial compose (contrast the single-shot
 * `editReleaseBody` used for a scoped selection edit, which skips review).
 * Emits stepped progress (preparing/generating/reviewing/saving) so the editor
 * modal can show the same checklist loader as the compose dialog — the review
 * loop's own `detail` events are threaded through the shared `onProgress`.
 *
 * Persists body-only: the current title is passed to the reviewer for context
 * but never overwritten, matching the feature's body-only scope. `fullBody`
 * comes from the live editor (so unsaved edits are respected), not the DB row.
 *
 * Returns the persisted body, or null if the release doesn't exist.
 */
export async function runWholeEditForRelease(
  args: { releaseId: string; instruction: string; fullBody: string; editedBy: string },
  database: Database = defaultDb,
  onProgress?: OnDraftProgress,
  deps: WholeEditDeps = {}
): Promise<{ body: string } | null> {
  const generateEdit = deps.generateEdit ?? editReleaseBody;
  const review = deps.review ?? reviewAndReconcile;
  const emit: OnDraftProgress = onProgress ?? (() => {});

  const [release] = await database.select().from(releases).where(eq(releases.id, args.releaseId));
  if (!release) {
    emit({ type: "error", message: "Update not found." });
    return null;
  }

  emit({ type: "step", key: "preparing", status: "start" });
  const brandProfile = await getOrCreateBrandProfile(release.tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: [],
  });
  emit({ type: "step", key: "preparing", status: "done" });

  emit({ type: "step", key: "generating", status: "start" });
  const editedBody = await generateEdit({
    mode: "whole",
    instruction: args.instruction,
    currentBody: args.fullBody,
    excerpt: "",
    brandProfile,
    personas,
    examples,
  });
  emit({ type: "step", key: "generating", status: "done" });

  emit({ type: "step", key: "reviewing", status: "start" });
  const outcome = await review({ title: release.title, body: editedBody }, brandProfile, emit);
  emit({ type: "step", key: "reviewing", status: "done" });

  // Validate links on the LLM's final body — after review, which may itself
  // rewrite links — so no unresolvable URL is persisted (see `validateDraftLinks`).
  const { body: finalBody } = await validateDraftLinks(outcome.finalDraft.body);

  emit({ type: "step", key: "saving", status: "start" });
  // Blank-guard mirrors `saveDraft`/`saveDraftBody`: never clobber a real body
  // with an empty one the review pipeline might hand back on a failure path.
  const body = finalBody.trim().length === 0 && release.body.trim().length > 0 ? release.body : finalBody;
  await database
    .update(releases)
    .set({ body, editedBy: args.editedBy, bodyEditedAt: new Date() })
    .where(eq(releases.id, release.id));
  emit({ type: "step", key: "saving", status: "done" });

  emit({ type: "done", updateId: release.id, body });
  return { body };
}
