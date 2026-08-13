"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import * as curation from "@/lib/atomic-updates/list";
import type { AtomicUpdateListFilters } from "@/lib/atomic-updates/list";
import type { ReassignResult } from "@/lib/change-events/reassign";

export async function listAtomicUpdates(filters: AtomicUpdateListFilters = {}) {
  const session = await requireSession();
  return curation.listAtomicUpdates(session.user.tenantId, filters);
}

export async function hasCuratableAtomicUpdates(): Promise<boolean> {
  const session = await requireSession();
  return curation.hasCuratableAtomicUpdates(session.user.tenantId);
}

export async function hideAtomicUpdate(id: string): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await curation.hideAtomicUpdate(session.user.tenantId, id);
  revalidatePath("/company");
  return result;
}

export async function bulkHideAtomicUpdates(ids: string[]): Promise<{ count: number }> {
  const session = await requireSession();
  const result = await curation.bulkHideAtomicUpdates(session.user.tenantId, ids);
  revalidatePath("/company");
  return result;
}

export async function bulkDeleteAtomicUpdates(ids: string[]): Promise<{ count: number }> {
  const session = await requireSession();
  const result = await curation.bulkDeleteAtomicUpdates(session.user.tenantId, ids);
  revalidatePath("/company");
  return result;
}

export async function unhideAtomicUpdate(id: string): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await curation.unhideAtomicUpdate(session.user.tenantId, id);
  revalidatePath("/company");
  return result;
}

export async function editAtomicUpdate(
  id: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const session = await requireSession();
  await curation.editAtomicUpdate(session.user.tenantId, id, patch);
  revalidatePath("/company");
}

export async function removeEventFromAtomicUpdate(
  atomicUpdateId: string,
  eventId: string,
  confirmEmptyDeletion?: boolean
): Promise<ReassignResult> {
  const session = await requireSession();
  const result = await curation.removeEventFromAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId,
    eventId,
    confirmEmptyDeletion,
  });
  revalidatePath("/company");
  return result;
}

export async function setAtomicUpdateSize(
  id: string,
  size: "s" | "m" | "l" | "xl"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await curation.setAtomicUpdateSize(session.user.tenantId, id, size);
  revalidatePath("/company");
  return result;
}

export async function setAtomicUpdateCategory(
  id: string,
  category: "new" | "improvement" | "fix" | "announcement"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const result = await curation.setAtomicUpdateCategory(session.user.tenantId, id, category);
  revalidatePath("/company");
  return result;
}
