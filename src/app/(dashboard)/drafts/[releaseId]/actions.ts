"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { contentPieces } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { assertDraftEditable } from "@/lib/draft-editable";
import { catchUpRelease, startOverRelease } from "@/lib/change-events/catch-up";
import { prepareGenerationContext } from "@/lib/ai/generation-context";
import { editReleaseBody } from "@/lib/ai/edit";
import { validateDraftLinks } from "@/lib/ai/validate-links";

// Same tenant-checked load as `loadOwnedDraft` in `drafts/actions.ts` — kept
// as a separate copy rather than a shared import so this file's action set
// doesn't reach back into a sibling route's private helper.
async function loadOwnedDraft(tenantId: string, contentPieceId: string) {
  const [piece] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)));
  if (!piece) throw new Error("Update not found for this tenant");
  return piece;
}

/**
 * Merge-regenerates a stale draft: folds in new/changed atomic updates while
 * preserving the current wording (see `catchUpRelease`). Tenant-checked via
 * `loadOwnedDraft` before the orchestrator ever runs — the content piece id in
 * `formData` is client-supplied, so ownership must be re-derived from the
 * session, not trusted from the request.
 */
export async function catchUp(formData: FormData) {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  assertDraftEditable(await loadOwnedDraft(session.user.tenantId, contentPieceId));

  await catchUpRelease(contentPieceId);

  revalidatePath(`/drafts/${contentPieceId}`);
}

/**
 * Regenerates a stale draft from scratch over its full atomic-update set
 * (see `startOverRelease`) — discards the current wording, contrast
 * `catchUp`. Same tenant check as `catchUp` before the orchestrator runs.
 */
export async function startOver(formData: FormData) {
  const session = await requireSession();
  const contentPieceId = formData.get("contentPieceId") as string;
  assertDraftEditable(await loadOwnedDraft(session.user.tenantId, contentPieceId));

  await startOverRelease(contentPieceId);

  revalidatePath(`/drafts/${contentPieceId}`);
}

/**
 * Runs a single-call agent edit against the draft's live body. `fullBody` comes
 * from the client editor (so unsaved edits are respected) — the DB row is used
 * only for the tenant-ownership check, never as the prompt's body. No DB write:
 * for a surgical edit the final body only exists after the client splices the
 * returned excerpt in, so persistence is a separate `saveDraftBody` call.
 */
export async function requestAgentEdit(input: {
  contentPieceId: string;
  mode: "selection" | "whole";
  instruction: string;
  fullBody: string;
  excerpt?: string;
}): Promise<{ text: string }> {
  const session = await requireSession();
  const piece = await loadOwnedDraft(session.user.tenantId, input.contentPieceId);
  // Before the LLM call, not after: a stale tab must not burn tokens producing
  // text that `saveDraftBody` will then refuse to persist.
  assertDraftEditable(piece);

  // Same prompt context the composer uses, so edits stay on brand.
  const { brandProfile, personas, examples } = await prepareGenerationContext(piece.tenantId, db);

  const text = await editReleaseBody({
    mode: input.mode,
    instruction: input.instruction,
    currentBody: input.fullBody,
    excerpt: input.excerpt ?? "",
    brandProfile,
    personas,
    examples,
  });

  // This is LLM-authored output (spliced in client-side, then saved via the
  // human-save path `saveDraftBody`, which does NOT validate), so validate any
  // fabricated links here at the LLM boundary before returning to the client.
  const { body: validated } = await validateDraftLinks(text);
  return { text: validated };
}

/**
 * Persists a body-only change (the agent edit, applied client-side). Updates
 * just `body` — never the title — so it can't clobber an unsaved title. Same
 * blank-guard and `bodyEditedAt` stamping as `saveDraft`.
 */
export async function saveDraftBody(input: { contentPieceId: string; body: string }): Promise<void> {
  const session = await requireSession();
  const existing = await loadOwnedDraft(session.user.tenantId, input.contentPieceId);
  assertDraftEditable(existing);

  const body =
    input.body.trim().length === 0 && existing.body.trim().length > 0 ? existing.body : input.body;
  const bodyChanged = body !== existing.body;

  await db
    .update(contentPieces)
    .set({
      body,
      editedBy: session.user.id,
      ...(bodyChanged ? { bodyEditedAt: new Date() } : {}),
    })
    .where(eq(contentPieces.id, input.contentPieceId));

  revalidatePath(`/drafts/${input.contentPieceId}`);
}
