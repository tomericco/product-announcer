"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { releases, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { catchUpRelease, startOverRelease } from "@/lib/change-events/catch-up";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { editReleaseBody } from "@/lib/ai/edit";

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

/**
 * Runs a single-call agent edit against the draft's live body. `fullBody` comes
 * from the client editor (so unsaved edits are respected) — the DB row is used
 * only for the tenant-ownership check, never as the prompt's body. No DB write:
 * for a surgical edit the final body only exists after the client splices the
 * returned excerpt in, so persistence is a separate `saveDraftBody` call.
 */
export async function requestAgentEdit(input: {
  releaseId: string;
  mode: "selection" | "whole";
  instruction: string;
  fullBody: string;
  excerpt?: string;
}): Promise<{ text: string }> {
  const session = await requireSession();
  const release = await loadOwnedDraft(session.user.tenantId, input.releaseId);

  // Same prompt context the composer uses, so edits stay on brand.
  const brandProfile = await getOrCreateBrandProfile(release.tenantId, db);
  const catalog = await db.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await db.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: [],
  });

  const text = await editReleaseBody({
    mode: input.mode,
    instruction: input.instruction,
    currentBody: input.fullBody,
    excerpt: input.excerpt ?? "",
    brandProfile,
    personas,
    examples,
  });

  return { text };
}

/**
 * Persists a body-only change (the agent edit, applied client-side). Updates
 * just `body` — never the title — so it can't clobber an unsaved title. Same
 * blank-guard and `bodyEditedAt` stamping as `saveDraft`.
 */
export async function saveDraftBody(input: { releaseId: string; body: string }): Promise<void> {
  const session = await requireSession();
  const existing = await loadOwnedDraft(session.user.tenantId, input.releaseId);

  const body =
    input.body.trim().length === 0 && existing.body.trim().length > 0 ? existing.body : input.body;
  const bodyChanged = body !== existing.body;

  await db
    .update(releases)
    .set({
      body,
      editedBy: session.user.id,
      ...(bodyChanged ? { bodyEditedAt: new Date() } : {}),
    })
    .where(eq(releases.id, input.releaseId));

  revalidatePath(`/drafts/${input.releaseId}`);
}
