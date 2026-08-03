import { db as defaultDb } from "@/db";
import { generateReleaseDraft } from "@/lib/ai/generation";
import type { AtomicUpdateForPrompt } from "@/lib/ai/compose-prompt";
import { claimReleaseFromAtomicUpdates } from "@/lib/change-events/release-claim";
import { prepareGenerationContext } from "@/lib/ai/generation-context";
import { reviewAndReconcile } from "@/lib/ai/review-draft";
import { validateDraftLinks } from "@/lib/ai/validate-links";
import type { OnDraftProgress } from "./draft-progress";

/** Distinct non-null categories among the atomic updates being composed, used to
 * bias example selection toward examples about the same kinds of changes. */
function atomicUpdateCategories(items: { category: string | null }[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.category !== null) seen.add(item.category);
  }
  return [...seen];
}

export async function runBatchForWorkspace(
  tenantId: string,
  items: AtomicUpdateForPrompt[],
  database: typeof defaultDb = defaultDb,
  onProgress?: OnDraftProgress
): Promise<boolean> {
  if (items.length === 0) return false;

  onProgress?.({ type: "step", key: "preparing", status: "start" });
  const { brandProfile, personas, examples } = await prepareGenerationContext(
    tenantId,
    database,
    atomicUpdateCategories(items)
  );
  onProgress?.({ type: "step", key: "preparing", status: "done" });

  onProgress?.({ type: "step", key: "generating", status: "start" });
  let draft;
  try {
    draft = await generateReleaseDraft(items, brandProfile, personas, examples);
  } catch {
    try {
      draft = await generateReleaseDraft(items, brandProfile, personas, examples);
    } catch (err) {
      // Both attempts failed. Leave the atomic updates open — they remain
      // available to the next manual compose run.
      onProgress?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  onProgress?.({ type: "step", key: "generating", status: "done" });

  onProgress?.({ type: "step", key: "reviewing", status: "start" });
  const review = await reviewAndReconcile(draft, brandProfile, onProgress);
  onProgress?.({ type: "step", key: "reviewing", status: "done" });

  // Validate links on the FINAL body — after review, which may itself rewrite
  // links — so no unresolvable URL is persisted (see `validateDraftLinks`).
  const { body: validatedBody } = await validateDraftLinks(review.finalDraft.body);

  onProgress?.({ type: "step", key: "saving", status: "start" });
  const release = await claimReleaseFromAtomicUpdates(
    {
      tenantId,
      atomicUpdateIds: items.map((i) => i.id),
      draft: { ...review.finalDraft, body: validatedBody },
      review: { status: review.status, issues: review.issues },
    },
    database
  );
  if (!release) {
    onProgress?.({ type: "error", message: "No changes were available to draft." });
    return false;
  }
  onProgress?.({ type: "step", key: "saving", status: "done" });

  onProgress?.({ type: "done", updateId: release.id });
  return true;
}
