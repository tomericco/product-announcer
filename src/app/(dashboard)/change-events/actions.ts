"use server";

import { and, desc, eq, isNotNull, isNull, not, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reassignChangeEvent, type ReassignResult, type ReassignTarget } from "@/lib/change-events/reassign";

export type ChangeEventRow = {
  id: string;
  type: (typeof changeEvents.$inferSelect)["type"];
  provider: (typeof changeEvents.$inferSelect)["provider"];
  title: string;
  externalUrl: string | null;
  createdAt: Date;
  atomicUpdateId: string | null;
  atomicUpdateTitle: string | null;
  status: (typeof changeEvents.$inferSelect)["status"];
  filterReason: (typeof changeEvents.$inferSelect)["filterReason"];
  userFacing: (typeof changeEvents.$inferSelect)["userFacing"];
};

export type ChangeEventFilters = {
  type?: (typeof changeEvents.$inferSelect)["type"];
  provider?: (typeof changeEvents.$inferSelect)["provider"];
  assignment?: "assigned" | "unassigned";
  showHidden?: boolean;
};

/**
 * All change events for the tenant, joined to their atomic update (for
 * `atomicUpdateTitle`), newest first.
 *
 * Hidden-by-default rule: an event that was never surfaced to a human — not
 * user-facing, deterministically filtered, or manually excluded — AND is
 * currently unassigned is noise from the resolver's perspective, so it's
 * excluded unless `showHidden` is set. The moment such an event gets manually
 * assigned to an atomic update it becomes live evidence for that update's
 * summary, so an assigned event always shows regardless of how it was
 * originally classified — the hidden check only ever applies to unassigned
 * rows (`isNull(changeEvents.atomicUpdateId)` is ANDed into the hidden
 * predicate itself, not applied as a separate filter).
 */
export async function listChangeEvents(filters: ChangeEventFilters): Promise<ChangeEventRow[]> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  // `eq(userFacing, false)` alone is NOT safe here: SQL's three-valued logic
  // makes `NULL = false` evaluate to NULL (not false) when a row hasn't been
  // classified yet (userFacing IS NULL). That NULL then poisons the
  // surrounding OR/AND/NOT chain — `NOT (... OR NULL ...)` can itself become
  // NULL, and a WHERE clause silently drops rows where the condition is NULL
  // rather than FALSE, hiding rows that were never supposed to be hidden.
  // Anding with `isNotNull(userFacing)` first makes this term a real boolean
  // (never NULL): false whenever userFacing hasn't been classified, so it
  // can't corrupt the OR below.
  const explicitlyNotUserFacing = and(isNotNull(changeEvents.userFacing), eq(changeEvents.userFacing, false));

  const hiddenWhenUnassigned = and(
    isNull(changeEvents.atomicUpdateId),
    or(explicitlyNotUserFacing, isNotNull(changeEvents.filterReason), eq(changeEvents.status, "excluded"))
  );

  const conditions = [eq(changeEvents.tenantId, tenantId)];

  if (!filters.showHidden) {
    // `and(...)` is typed as `SQL | undefined` because it's variadic (an empty
    // call would have nothing to combine), but the two-argument call above
    // always produces a real SQL fragment — the `!` just satisfies `not`'s
    // stricter `SQLWrapper` parameter type.
    conditions.push(not(hiddenWhenUnassigned!));
  }
  if (filters.type) {
    conditions.push(eq(changeEvents.type, filters.type));
  }
  if (filters.provider) {
    conditions.push(eq(changeEvents.provider, filters.provider));
  }
  if (filters.assignment === "assigned") {
    conditions.push(isNotNull(changeEvents.atomicUpdateId));
  } else if (filters.assignment === "unassigned") {
    conditions.push(isNull(changeEvents.atomicUpdateId));
  }

  const rows = await db
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      provider: changeEvents.provider,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      externalUrl: changeEvents.externalUrl,
      createdAt: changeEvents.createdAt,
      atomicUpdateId: changeEvents.atomicUpdateId,
      atomicUpdateTitle: atomicUpdates.title,
      status: changeEvents.status,
      filterReason: changeEvents.filterReason,
      userFacing: changeEvents.userFacing,
    })
    .from(changeEvents)
    .leftJoin(atomicUpdates, eq(changeEvents.atomicUpdateId, atomicUpdates.id))
    .where(and(...conditions))
    .orderBy(desc(changeEvents.createdAt), desc(changeEvents.id));

  return rows.map((row) => {
    const firstLine = row.commitMessage?.split("\n")[0]?.trim();
    const title = row.prTitle ?? firstLine ?? "Untitled";
    return {
      id: row.id,
      type: row.type,
      provider: row.provider,
      title,
      externalUrl: row.externalUrl,
      createdAt: row.createdAt,
      atomicUpdateId: row.atomicUpdateId,
      atomicUpdateTitle: row.atomicUpdateTitle,
      status: row.status,
      filterReason: row.filterReason,
      userFacing: row.userFacing,
    };
  });
}

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
  revalidatePath("/change-events");
  return result;
}
