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
import type { ReassignResult } from "@/lib/change-events/reassign";

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
 * Writes straight to the atomic update, same as the Atomic updates tab's
 * editor. The signal row's own title/excerpt do NOT follow this edit — those
 * columns are only ever written by `syncShippedWorkSignals`, and this action
 * revalidating `/signals` does not change that; it just lets a fresher server
 * render replace this drawer's own display next time it's opened.
 */
export async function saveEvidenceEdit(
  atomicUpdateId: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const session = await requireSession();
  await editAtomicUpdate(session.user.tenantId, atomicUpdateId, patch);
  revalidatePath("/signals");
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
