"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import * as list from "@/lib/change-events/list";
import { reassignChangeEvent, type ReassignResult, type ReassignTarget } from "@/lib/change-events/reassign";

// Mutations behind the Company page's ungrouped-queue section (moved here
// from the retired standalone /change-events route in Task 6 of the
// signals-absorb-atomic-updates spec). `listChangeEvents` and
// `listImportRepos` didn't come with them — every surviving caller
// (`change-events-section.tsx`, the /integrations page) already reads
// `@/lib/change-events/list` directly rather than through this "use server"
// wrapper, so re-exporting the read paths here would just be dead code.

function parseTarget(formData: FormData): ReassignTarget | null {
  const targetKind = formData.get("targetKind");
  if (targetKind === "existing") {
    const atomicUpdateId = formData.get("atomicUpdateId");
    if (typeof atomicUpdateId !== "string" || !atomicUpdateId) return null;
    return { kind: "existing", atomicUpdateId };
  }
  if (targetKind === "detach") {
    return { kind: "detach" };
  }
  if (targetKind === "new") {
    return { kind: "new" };
  }
  return null;
}

function parseConfirmEmptyDeletion(formData: FormData): boolean {
  return formData.get("confirmEmptyDeletion") === "true";
}

/**
 * Manually reassigns a change event to a different open atomic update,
 * detaches it, or splits it into a new one (phase 3's reassignment UI).
 *
 * tenantId and userId ALWAYS come from the session, never from formData — a
 * client could stuff arbitrary values into a hidden field, and the
 * `reassignChangeEvent` core re-validates tenant ownership of the event/AUs
 * regardless, but this action must not even offer a foreign tenantId as
 * input. `eventId` and the target descriptor are the only formData reads.
 *
 * A `{ok:false}` outcome from the core (e.g. the event's atomic update was
 * already released, or the move needs confirmation because it would empty
 * the source atomic update) is returned to the caller, not thrown — the
 * client component surfaces it as a toast, or in the needs-confirmation case
 * as a confirm dialog, rather than an error boundary.
 *
 * `confirmEmptyDeletion` is read from formData as an explicit opt-in the
 * client only sets after the user confirms the warning dialog; omitted (the
 * common case) it's `false`, so a first-pass move that would empty its
 * source atomic update comes back as `needsConfirmation` instead of silently
 * deleting it.
 */
export async function reassign(formData: FormData): Promise<ReassignResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  const eventId = formData.get("eventId");
  const target = parseTarget(formData);
  const confirmEmptyDeletion = parseConfirmEmptyDeletion(formData);

  if (typeof eventId !== "string" || !eventId || !target) {
    return { ok: false, reason: "Invalid reassignment request." };
  }

  const result = await reassignChangeEvent({ tenantId, userId, eventId, target, confirmEmptyDeletion });
  revalidatePath("/company");
  return result;
}

export async function bulkReassignChangeEvents(
  eventIds: string[],
  target: { kind: "existing"; atomicUpdateId: string } | { kind: "detach" }
): Promise<{ succeeded: number; failed: number; deletedAtomicUpdates: number }> {
  const session = await requireSession();
  const result = await list.bulkReassignChangeEvents({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    eventIds,
    target,
  });
  revalidatePath("/company");
  return result;
}

export async function bulkDeleteChangeEvents(eventIds: string[]): Promise<{ count: number }> {
  const session = await requireSession();
  const result = await list.bulkDeleteChangeEvents(session.user.tenantId, eventIds);
  revalidatePath("/company");
  return result;
}
