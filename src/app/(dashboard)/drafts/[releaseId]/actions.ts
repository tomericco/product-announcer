"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { catchUpRelease, startOverRelease } from "@/lib/change-events/catch-up";

// Same tenant-checked load as `loadOwnedDraft` in `drafts/actions.ts` — kept
// as a separate copy rather than a shared import so this file's action set
// doesn't reach back into a sibling route's private helper.
async function loadOwnedDraft(tenantId: string, releaseId: string) {
  const [release] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)));
  if (!release) throw new Error("Update not found for this tenant");
  return release;
}

/**
 * Merge-regenerates a stale draft: folds in new/changed atomic updates while
 * preserving the current wording (see `catchUpRelease`). Tenant-checked via
 * `loadOwnedDraft` before the orchestrator ever runs — the release id in
 * `formData` is client-supplied, so ownership must be re-derived from the
 * session, not trusted from the request.
 */
export async function catchUp(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  await loadOwnedDraft(session.user.tenantId, releaseId);

  await catchUpRelease(releaseId);

  revalidatePath(`/drafts/${releaseId}`);
}

/**
 * Regenerates a stale draft from scratch over its full atomic-update set
 * (see `startOverRelease`) — discards the current wording, contrast
 * `catchUp`. Same tenant check as `catchUp` before the orchestrator runs.
 */
export async function startOver(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  await loadOwnedDraft(session.user.tenantId, releaseId);

  await startOverRelease(releaseId);

  revalidatePath(`/drafts/${releaseId}`);
}
