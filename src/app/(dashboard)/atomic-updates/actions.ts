"use server";

import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import {
  createAtomicUpdateFromEvents,
  type CreateFromEventsResult,
} from "@/lib/change-events/create-from-events";
import { reassignChangeEvent, type ReassignResult } from "@/lib/change-events/reassign";
import {
  addEventsToExistingAtomicUpdate,
  type AddEventsResult,
} from "@/lib/change-events/add-events-to-atomic-update";

export type AtomicUpdateEvent = {
  id: string;
  type: "commit" | "pull_request" | "task";
  // A PR's title, a commit's first message line, or (until a dedicated task
  // pipeline exists) the same prTitle field — mirrors the fallback already
  // used in regenerate-atomic-summary.ts.
  label: string;
  externalUrl: string | null;
};

export type AtomicUpdateRow = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
  events: AtomicUpdateEvent[];
  summaryEditedAt: Date | null;
  updatedAt: Date;
};

export async function listAtomicUpdates(): Promise<AtomicUpdateRow[]> {
  const session = await requireSession();

  const atomics = await db
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
    })
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for and shows up on that draft instead — see
        // getOpenAtomicUpdates in release-claim.ts for the same rule.
        isNull(atomicUpdates.releaseId)
      )
    )
    .orderBy(desc(atomicUpdates.updatedAt));

  if (atomics.length === 0) return [];

  const atomicIds = atomics.map((a) => a.id);

  // Single query for every event behind every listed atomic update, instead of
  // one query per card (the N+1 shape). Tenant-scoped independently of the
  // atomicIds filter above — the where clause is the security boundary, so
  // this join must not rely solely on ids already having been tenant-checked.
  // Ordered by createdAt then id: createdAt is always non-null (unlike
  // committedAt/mergedAt), but events ingested in the same webhook batch can
  // share a createdAt, and SQL does not guarantee a deterministic order among
  // rows with equal sort keys — id as a tiebreaker keeps a card's evidence
  // list stable across loads.
  const events = await db
    .select({
      id: changeEvents.id,
      atomicUpdateId: changeEvents.atomicUpdateId,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      externalUrl: changeEvents.externalUrl,
    })
    .from(changeEvents)
    .where(
      and(eq(changeEvents.tenantId, session.user.tenantId), inArray(changeEvents.atomicUpdateId, atomicIds))
    )
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  const eventsByAtomicId = new Map<string, AtomicUpdateEvent[]>();
  for (const event of events) {
    // TS-nullability guard, not a reachable branch: inArray(atomicUpdateId, atomicIds)
    // can never match a null atomicUpdateId.
    if (!event.atomicUpdateId) continue;
    const label = event.type === "commit" ? (event.commitMessage ?? "").split("\n")[0] : (event.prTitle ?? "");
    const list = eventsByAtomicId.get(event.atomicUpdateId) ?? [];
    list.push({ id: event.id, type: event.type, label, externalUrl: event.externalUrl });
    eventsByAtomicId.set(event.atomicUpdateId, list);
  }

  return atomics.map((atomic) => ({
    ...atomic,
    events: eventsByAtomicId.get(atomic.id) ?? [],
  }));
}

/**
 * Marks an OPEN, unlinked atomic update as non-user-facing ("hidden"). This
 * is a third status alongside `open`/`released`, not a boolean flag — every
 * candidate/list/resolver query in the codebase already filters
 * `status = 'open'` (see `loadOpenAtomicUpdates` in apply-resolution.ts,
 * `getOpenAtomicUpdates` in release-claim.ts, `listAtomicUpdates` above,
 * etc.), so a `hidden` update falls out of all of them automatically: it
 * disappears from the curation list, can't be claimed into a release, and —
 * load-bearing — the resolver can no longer attach a follow-up commit to it,
 * so later evidence for that feature spins up a brand-new visible atomic
 * update instead of silently reappearing on this one.
 *
 * Only an open, UNLINKED update may be hidden: `status = 'open' AND
 * releaseId IS NULL`. One already claimed into a draft release must not be
 * hidden here — hiding a title mid-draft is a different, unhandled concern,
 * and `listAtomicUpdates` only ever shows unlinked-open updates in the first
 * place, so the UI never offers this action on a linked one anyway.
 */
export async function markAtomicUpdateHidden(id: string): Promise<{ ok: boolean }> {
  const session = await requireSession();

  const rows = await db
    .update(atomicUpdates)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.releaseId)
      )
    )
    .returning({ id: atomicUpdates.id });

  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}

/**
 * Reverses `markAtomicUpdateHidden`: flips a `hidden` atomic update back to
 * `open`, re-entering it into every candidate set (list, compose, resolver)
 * that filters on that status.
 */
export async function unhideAtomicUpdate(id: string): Promise<{ ok: boolean }> {
  const session = await requireSession();

  const rows = await db
    .update(atomicUpdates)
    .set({ status: "open", updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "hidden")
      )
    )
    .returning({ id: atomicUpdates.id });

  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}

/**
 * The tenant's hidden atomic updates, mirroring `listAtomicUpdates`'s shape
 * and batched event join exactly, but filtered to `status = 'hidden'`. No
 * `releaseId IS NULL` filter here — a hidden update is never linked to a
 * release (only an unlinked open one can be hidden in the first place), so
 * adding that condition would be a no-op at best and misleading at worst.
 */
export async function listHiddenAtomicUpdates(): Promise<AtomicUpdateRow[]> {
  const session = await requireSession();

  const atomics = await db
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
    })
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, session.user.tenantId), eq(atomicUpdates.status, "hidden")))
    .orderBy(desc(atomicUpdates.updatedAt));

  if (atomics.length === 0) return [];

  const atomicIds = atomics.map((a) => a.id);

  // Same batched join as listAtomicUpdates: one query for every event behind
  // every listed atomic update, tenant-scoped independently of the atomicIds
  // filter above.
  const events = await db
    .select({
      id: changeEvents.id,
      atomicUpdateId: changeEvents.atomicUpdateId,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      externalUrl: changeEvents.externalUrl,
    })
    .from(changeEvents)
    .where(
      and(eq(changeEvents.tenantId, session.user.tenantId), inArray(changeEvents.atomicUpdateId, atomicIds))
    )
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  const eventsByAtomicId = new Map<string, AtomicUpdateEvent[]>();
  for (const event of events) {
    if (!event.atomicUpdateId) continue;
    const label = event.type === "commit" ? (event.commitMessage ?? "").split("\n")[0] : (event.prTitle ?? "");
    const list = eventsByAtomicId.get(event.atomicUpdateId) ?? [];
    list.push({ id: event.id, type: event.type, label, externalUrl: event.externalUrl });
    eventsByAtomicId.set(event.atomicUpdateId, list);
  }

  return atomics.map((atomic) => ({
    ...atomic,
    events: eventsByAtomicId.get(atomic.id) ?? [],
  }));
}

export async function editAtomicUpdate(
  id: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const session = await requireSession();

  // Tenant scoping is enforced per-query in this codebase, not by RLS — the
  // where clause is the security boundary.
  await db
    .update(atomicUpdates)
    .set({
      title: patch.title,
      summary: patch.summary,
      // Freezes automatic regeneration: from here on, only the user rewrites this.
      summaryEditedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(atomicUpdates.id, id), eq(atomicUpdates.tenantId, session.user.tenantId)));

  revalidatePath("/atomic-updates");
}

export type SelectableEventRow = {
  id: string;
  type: (typeof changeEvents.$inferSelect)["type"];
  provider: (typeof changeEvents.$inferSelect)["provider"];
  title: string;
  externalUrl: string | null;
  atomicUpdateId: string | null;
  atomicUpdateTitle: string | null;
};

/**
 * Change events selectable as input for a brand-new atomic update (the "New
 * atomic update" modal): unassigned events, plus events currently sitting in
 * an OPEN atomic update (picking one pulls it out and, if that empties the
 * source, `createAtomicUpdateFromEvents` gates the deletion behind
 * confirmation). Events whose atomic update is `released` are frozen and
 * excluded — offering them here would just produce a rejection from the core
 * once submitted.
 *
 * This is deliberately a separate, simpler query rather than an extra filter
 * mode on `listChangeEvents` (`change-events/actions.ts`): that query's
 * "hidden by default" predicate answers a different question (what's noise
 * for the resolver), and overloading it with a third axis ("selectable for a
 * new atomic update") would make both harder to reason about. The row shape
 * and the tenant-scoped left-join to `atomicUpdates` are modeled on it
 * directly.
 */
export async function listSelectableEvents(): Promise<SelectableEventRow[]> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const rows = await db
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      provider: changeEvents.provider,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      externalUrl: changeEvents.externalUrl,
      atomicUpdateId: changeEvents.atomicUpdateId,
      atomicUpdateTitle: atomicUpdates.title,
    })
    .from(changeEvents)
    .leftJoin(atomicUpdates, eq(changeEvents.atomicUpdateId, atomicUpdates.id))
    .where(
      and(
        eq(changeEvents.tenantId, tenantId),
        or(isNull(changeEvents.atomicUpdateId), eq(atomicUpdates.status, "open"))
      )
    )
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
      atomicUpdateId: row.atomicUpdateId,
      atomicUpdateTitle: row.atomicUpdateTitle,
    };
  });
}

function parseEventIds(formData: FormData): string[] {
  return formData
    .getAll("eventIds")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

function parseConfirmEmptyDeletion(formData: FormData): boolean {
  return formData.get("confirmEmptyDeletion") === "true";
}

/**
 * Creates one brand-new open atomic update from a set of selected change
 * events (the "New atomic update" modal on `/atomic-updates`).
 *
 * tenantId and userId ALWAYS come from the session, never from formData —
 * mirrors `reassign` in `change-events/actions.ts`. `eventIds` is read as a
 * repeated formData field (`getAll`, populated via multiple
 * `formData.append("eventIds", id)` calls on the client) rather than a single
 * delimited string, so an id can never be mis-split.
 *
 * A `{ok:false}` outcome from the core (e.g. one of the selected events sits
 * in a released atomic update, or the move needs confirmation because it
 * would empty an open source atomic update) is returned to the caller, not
 * thrown — the client surfaces it as a toast, or in the needs-confirmation
 * case as a confirm dialog naming the atomic updates that would be emptied,
 * rather than an error boundary.
 */
export async function createFromEvents(formData: FormData): Promise<CreateFromEventsResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  const eventIds = parseEventIds(formData);
  const confirmEmptyDeletion = parseConfirmEmptyDeletion(formData);

  const result = await createAtomicUpdateFromEvents({ tenantId, userId, eventIds, confirmEmptyDeletion });
  revalidatePath("/atomic-updates");
  return result;
}

/**
 * Adds a BATCH of existing change events as evidence for `atomicUpdateId` (the
 * per-update "add evidence" editor, multi-select). Each event may currently be
 * unassigned or sitting in a DIFFERENT open atomic update; either way this is
 * `addEventsToExistingAtomicUpdate`'s job — it moves all of them in one
 * transaction with a single regeneration afterward, rather than regenerating
 * once per event. A move that would leave a source atomic update with zero
 * events is gated by the empty-source confirmation, same as everywhere else.
 *
 * The core always force-regenerates (clears `summaryEditedAt` on every
 * affected open update before the best-effort refresh): adding evidence must
 * reflect the new, larger evidence set even if a prior hand-edit had frozen
 * it — the owner's point in building this is that curation should reflect
 * the evidence, not a stale manual edit.
 *
 * tenantId/userId always come from the session, never a parameter — mirrors
 * every other action in this module and in `change-events/actions.ts`.
 */
export async function addEventsToAtomicUpdate(
  atomicUpdateId: string,
  eventIds: string[],
  confirmEmptyDeletion?: boolean
): Promise<AddEventsResult> {
  const session = await requireSession();
  const result = await addEventsToExistingAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId,
    eventIds,
    confirmEmptyDeletion,
  });
  revalidatePath("/atomic-updates");
  return result;
}

/**
 * Removes `eventId` from `atomicUpdateId` (the per-update "remove evidence"
 * editor): detaches it via `reassignChangeEvent`'s `detach` target, which
 * ends the event at `atomicUpdateId=null, status='excluded'`. `detach`
 * removes the event from whatever atomic update it is CURRENTLY in — so
 * before delegating, this checks the event actually belongs to
 * `atomicUpdateId` as given; a mismatch (e.g. a stale client removed it from
 * a different card, or reassigned it elsewhere first) is rejected here
 * rather than silently detaching it from wherever it really sits.
 *
 * Removing the last event leaves the atomic update empty — gated behind the
 * same `confirmEmptyDeletion` empty-source confirmation as every other
 * reassign path. `forceRegenerate: true` regenerates the SURVIVING update's
 * title/summary from its now-smaller evidence set, overriding any prior
 * hand-edit freeze, same rationale as `addEventsToAtomicUpdate`.
 */
export async function removeEventFromAtomicUpdate(
  atomicUpdateId: string,
  eventId: string,
  confirmEmptyDeletion?: boolean
): Promise<ReassignResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const userId = session.user.id;

  const [event] = await db
    .select({ atomicUpdateId: changeEvents.atomicUpdateId })
    .from(changeEvents)
    .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)))
    .limit(1);

  if (!event || event.atomicUpdateId !== atomicUpdateId) {
    return { ok: false, reason: "Change event does not belong to this atomic update." };
  }

  const result = await reassignChangeEvent({
    tenantId,
    userId,
    eventId,
    target: { kind: "detach" },
    confirmEmptyDeletion,
    forceRegenerate: true,
  });
  revalidatePath("/atomic-updates");
  return result;
}
