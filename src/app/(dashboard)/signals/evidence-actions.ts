"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { readSignalEvidence } from "@/lib/signals/evidence";
import type { SignalEvidence } from "@/lib/signals/evidence";
import {
  editAtomicUpdate,
  setAtomicUpdateSize,
  setAtomicUpdateCategory,
  hideAtomicUpdate,
  removeEventFromAtomicUpdate,
} from "@/lib/atomic-updates/list";
import {
  openAtomicUpdatesForReassign,
  reassignChangeEvent,
  type ReassignResult,
} from "@/lib/change-events/reassign";

/**
 * Loads the atomic update and change events behind one signal, for the
 * evidence drawer on `/signals`. Tenant-scoped from the session, never from
 * whatever `signalId` the browser sends — `readSignalEvidence` returns `null`
 * both for a signal with no atomic update and for another tenant's signal,
 * deliberately undistinguished (see its docstring), so this action can't leak
 * cross-tenant existence either.
 */
export async function loadSignalEvidence(signalId: string): Promise<SignalEvidence | null> {
  const session = await requireSession();
  return readSignalEvidence(session.user.tenantId, signalId);
}

/**
 * Every OPEN atomic update for the tenant — the drawer's reassign targets,
 * loaded alongside the evidence itself. Same source as the Company page's
 * change-events section (`openAtomicUpdatesForReassign`), which deliberately
 * includes updates already claimed into a draft: they are still open, so they
 * are still valid destinations.
 */
export async function loadEvidenceReassignTargets(): Promise<{ id: string; title: string }[]> {
  const session = await requireSession();
  const rows = await openAtomicUpdatesForReassign(session.user.tenantId);
  return rows.map((row) => ({ id: row.id, title: row.title }));
}

/**
 * Writes straight to the atomic update, same as the curation card on
 * /company. The signal row's own title/excerpt do NOT follow this edit —
 * those columns are only ever written by `syncShippedWorkSignals`, and this
 * action revalidating `/signals` does not change that; it just lets a fresher
 * server render replace this drawer's own display next time it's opened.
 *
 * Returns `{ok:false}` when the atomic update is no longer open, matching
 * `saveEvidenceSize`/`saveEvidenceCategory` so the drawer's one Save cannot
 * half-apply.
 */
export async function saveEvidenceEdit(
  atomicUpdateId: string,
  patch: { title: string; summary: string }
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await editAtomicUpdate(session.user.tenantId, atomicUpdateId, patch);
  revalidatePath("/signals");
  return result;
}

export async function saveEvidenceSize(
  atomicUpdateId: string,
  size: "s" | "m" | "l" | "xl"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await setAtomicUpdateSize(session.user.tenantId, atomicUpdateId, size);
  revalidatePath("/signals");
  return result;
}

export async function saveEvidenceCategory(
  atomicUpdateId: string,
  category: "new" | "improvement" | "fix" | "announcement"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await setAtomicUpdateCategory(session.user.tenantId, atomicUpdateId, category);
  revalidatePath("/signals");
  return result;
}

export async function hideEvidenceAtomicUpdate(atomicUpdateId: string): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await hideAtomicUpdate(session.user.tenantId, atomicUpdateId);
  revalidatePath("/signals");
  return result;
}

/**
 * Moves one change event out of this signal's atomic update and onto another
 * open one, or splits it into a brand-new atomic update. The design's
 * per-event "reassign" half, alongside "remove".
 *
 * Goes through the same `reassignChangeEvent` core the Company page's
 * `reassign` action uses, tenant/user derived from the session and never from
 * the client. Unlike `removeEvidenceEvent` it does NOT pass
 * `forceRegenerate`: a move is not evidence being rejected, so the source
 * update's hand-edited summary stays frozen — the `updatedAt` bump inside the
 * core is what marks it stale either way.
 *
 * A `{ok:false, needsConfirmation:true}` result (the move would empty the
 * source atomic update) is returned rather than thrown, for the drawer to
 * confirm and re-post.
 */
export async function reassignEvidenceEvent(
  eventId: string,
  target: { kind: "existing"; atomicUpdateId: string } | { kind: "new" },
  confirmEmptyDeletion?: boolean
): Promise<ReassignResult> {
  const session = await requireSession();
  const result = await reassignChangeEvent({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    eventId,
    target,
    confirmEmptyDeletion,
  });
  revalidatePath("/signals");
  return result;
}

export async function removeEvidenceEvent(
  atomicUpdateId: string,
  eventId: string,
  confirmEmptyDeletion?: boolean
): Promise<ReassignResult> {
  const session = await requireSession();
  const result = await removeEventFromAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId,
    eventId,
    confirmEmptyDeletion,
  });
  revalidatePath("/signals");
  return result;
}
