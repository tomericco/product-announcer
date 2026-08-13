import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { reassignChangeEvent, type ReassignResult } from "@/lib/change-events/reassign";
import { eventLabel } from "@/lib/change-events/event-label";

type Database = typeof defaultDb;

export type AtomicUpdateEvent = {
  id: string;
  type: "commit" | "pull_request" | "task";
  // A commit's first message line, a PR's title, or a task's title. Never
  // empty — the label is the only thing identifying a piece of evidence on the
  // card now that the type chip is gone from view mode.
  label: string;
  externalUrl: string | null;
};

export type AtomicUpdateRow = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improvement" | "fix" | "announcement" | null;
  size: "s" | "m" | "l" | "xl" | null;
  events: AtomicUpdateEvent[];
  summaryEditedAt: Date | null;
  updatedAt: Date;
  // Drives the month grouping in the list; stable, unlike updatedAt.
  createdAt: Date;
  // `status = 'hidden'`. Only ever true when the caller asked for hidden rows;
  // the list renders these inline with the open ones, set apart by a dashed
  // outline and offering nothing but "Unhide" — same treatment hidden change
  // events get in the Company page's change-events section.
  hidden: boolean;
};

export type AtomicUpdateListFilters = {
  category?: "new" | "improvement" | "fix" | "announcement";
  size?: "s" | "m" | "l" | "xl";
  // Include `hidden` updates alongside the open ones, interleaved by createdAt
  // rather than segregated into their own section (mirrors `showHidden` in
  // `listChangeEvents`). The category/size filters apply to them too.
  showHidden?: boolean;
};

export async function listAtomicUpdates(
  tenantId: string,
  filters: AtomicUpdateListFilters = {},
  database: Database = defaultDb
): Promise<AtomicUpdateRow[]> {
  const atomics = await database
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      size: atomicUpdates.size,
      summaryEditedAt: atomicUpdates.summaryEditedAt,
      updatedAt: atomicUpdates.updatedAt,
      createdAt: atomicUpdates.createdAt,
      status: atomicUpdates.status,
    })
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, tenantId),
        filters.showHidden
          ? inArray(atomicUpdates.status, ["open", "hidden"])
          : eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for and shows up on that draft instead — see
        // getOpenAtomicUpdates in release-claim.ts for the same rule. A no-op
        // for the hidden rows (only an unlinked update can be hidden), so it
        // costs nothing to leave it applying to both.
        isNull(atomicUpdates.contentPieceId),
        // Optional list filters; `and` drops the undefined ones.
        filters.category ? eq(atomicUpdates.category, filters.category) : undefined,
        filters.size ? eq(atomicUpdates.size, filters.size) : undefined
      )
    )
    // Ordered by creation, NOT updatedAt: an in-place edit (e.g. picking a
    // size) bumps updatedAt, and a mutable sort key would make the card jump
    // to the top of the list mid-edit. createdAt is stable; id breaks ties for
    // updates created in the same batch so the order is deterministic.
    .orderBy(desc(atomicUpdates.createdAt), asc(atomicUpdates.id));

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
  const events = await database
    .select({
      id: changeEvents.id,
      atomicUpdateId: changeEvents.atomicUpdateId,
      type: changeEvents.type,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      taskTitle: changeEvents.taskTitle,
      externalUrl: changeEvents.externalUrl,
    })
    .from(changeEvents)
    .where(
      and(eq(changeEvents.tenantId, tenantId), inArray(changeEvents.atomicUpdateId, atomicIds))
    )
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  const eventsByAtomicId = new Map<string, AtomicUpdateEvent[]>();
  for (const event of events) {
    // TS-nullability guard, not a reachable branch: inArray(atomicUpdateId, atomicIds)
    // can never match a null atomicUpdateId.
    if (!event.atomicUpdateId) continue;
    const list = eventsByAtomicId.get(event.atomicUpdateId) ?? [];
    list.push({ id: event.id, type: event.type, label: eventLabel(event), externalUrl: event.externalUrl });
    eventsByAtomicId.set(event.atomicUpdateId, list);
  }

  // `status` is projected down to the `hidden` flag rather than passed through:
  // it's the only distinction the list UI draws, and the row type is a client
  // component's prop — no reason to ship a wider enum than that.
  return atomics.map(({ status, ...atomic }) => ({
    ...atomic,
    hidden: status === "hidden",
    events: eventsByAtomicId.get(atomic.id) ?? [],
  }));
}

/**
 * Whether the tenant has any atomic update the curation list could show —
 * open or hidden, unlinked. Backs the page's onboarding empty state, which
 * must NOT appear for a workspace whose only updates are hidden: that would
 * swallow the filter bar and leave them unreachable.
 */
export async function hasCuratableAtomicUpdates(
  tenantId: string,
  database: Database = defaultDb
): Promise<boolean> {
  const [any] = await database
    .select({ id: atomicUpdates.id })
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, tenantId),
        inArray(atomicUpdates.status, ["open", "hidden"]),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .limit(1);

  return any !== undefined;
}

/**
 * Hides an OPEN, unlinked atomic update (the user-facing verb is "hide"; the
 * stored state is `status = 'hidden'`, which also means non-user-facing). This
 * is a third status alongside `open`/`released`, not a boolean flag — every
 * candidate/list/resolver query in the codebase already filters
 * `status = 'open'` (see `loadOpenAtomicUpdates` in apply-resolution.ts,
 * `getOpenAtomicUpdates` in release-claim.ts, `listAtomicUpdates` above,
 * etc.), so a `hidden` update falls out of all of them automatically: it
 * drops out of the curation list (unless "Show hidden" asks for it back, and
 * then only as a read-only card), can't be claimed into a release, and —
 * load-bearing — the resolver can no longer attach a follow-up commit to it,
 * so later evidence for that feature spins up a brand-new visible atomic
 * update instead of silently reappearing on this one.
 *
 * Only an open, UNLINKED update may be hidden: `status = 'open' AND
 * contentPieceId IS NULL`. One already claimed into a draft release must not be
 * hidden here — hiding a title mid-draft is a different, unhandled concern,
 * and `listAtomicUpdates` only ever shows unlinked-open updates in the first
 * place, so the UI never offers this action on a linked one anyway.
 */
export async function hideAtomicUpdate(
  tenantId: string,
  id: string,
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .returning({ id: atomicUpdates.id });

  return { ok: rows.length > 0 };
}

/**
 * Bulk form of `hideAtomicUpdate`: hides every OPEN, unlinked atomic
 * update in `ids` in one statement. The WHERE guard is identical
 * (`status = 'open' AND contentPieceId IS NULL`, tenant-scoped), so ids that are
 * released, already linked to a draft, or belong to another tenant are
 * silently skipped rather than erroring — `count` reports how many actually
 * flipped, letting the caller distinguish a full from a partial hide.
 */
export async function bulkHideAtomicUpdates(
  tenantId: string,
  ids: string[],
  database: Database = defaultDb
): Promise<{ count: number }> {
  if (ids.length === 0) return { count: 0 };

  const rows = await database
    .update(atomicUpdates)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(
      and(
        inArray(atomicUpdates.id, ids),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .returning({ id: atomicUpdates.id });

  return { count: rows.length };
}

/**
 * Permanently deletes open, unlinked atomic updates (a hard DB row delete,
 * unlike `bulkHideAtomicUpdates`, which only flips them to `hidden`).
 * The WHERE guard matches the hide action's — `status = 'open' AND contentPieceId
 * IS NULL`, tenant-scoped — so a released update or one already in a draft is
 * skipped rather than erroring; `count` reports how many rows were removed.
 *
 * The `change_events.atomicUpdateId` FK is `ON DELETE set null`, so a deleted
 * update's evidence is detached (returned to the unassigned pool), not
 * cascade-deleted. Note this differs from hiding: a hidden update is a
 * tombstone the resolver won't re-cluster onto, whereas after a delete the
 * now-unassigned events are eligible to be clustered into a fresh update
 * again.
 */
export async function bulkDeleteAtomicUpdates(
  tenantId: string,
  ids: string[],
  database: Database = defaultDb
): Promise<{ count: number }> {
  if (ids.length === 0) return { count: 0 };

  const rows = await database
    .delete(atomicUpdates)
    .where(
      and(
        inArray(atomicUpdates.id, ids),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .returning({ id: atomicUpdates.id });

  return { count: rows.length };
}

/**
 * Reverses `hideAtomicUpdate`: flips a `hidden` atomic update back to
 * `open`, re-entering it into every candidate set (list, compose, resolver)
 * that filters on that status.
 */
export async function unhideAtomicUpdate(
  tenantId: string,
  id: string,
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    .set({ status: "open", updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "hidden")
      )
    )
    .returning({ id: atomicUpdates.id });

  return { ok: rows.length > 0 };
}

/**
 * Rewrites an OPEN atomic update's title and summary.
 *
 * The `status = 'open'` guard matches `setAtomicUpdateSize` and
 * `setAtomicUpdateCategory` exactly, and that symmetry is the point: both the
 * curation card and the evidence drawer save title/summary and size/category
 * as one "Save", through three separate actions (size stamps its own freeze
 * column, so they can't be folded into one statement). Without the guard here
 * that Save half-succeeded on a released update — the title was rewritten
 * while the size/category calls came back `{ok:false}` and toasted a failure,
 * leaving the user with no coherent account of what happened. All three now
 * refuse together.
 *
 * NOT guarded on `contentPieceId IS NULL`, unlike `hideAtomicUpdate`: an
 * atomic update claimed into an unpublished draft is still `open`, and this
 * codebase treats those as live and editable (`openAtomicUpdatesForReassign`
 * deliberately offers them as reassign targets for the same reason). The
 * `updatedAt` bump here is what fires the draft's catch-up "evidence delta",
 * so the edit surfaces on the draft rather than being lost. Hiding is the odd
 * one out because a hidden title mid-draft is a different, unhandled concern.
 *
 * Tenant scoping is enforced per-query in this codebase, not by RLS — the
 * where clause is the security boundary.
 */
export async function editAtomicUpdate(
  tenantId: string,
  id: string,
  patch: { title: string; summary: string },
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    .set({
      title: patch.title,
      summary: patch.summary,
      // Freezes automatic regeneration: from here on, only the user rewrites this.
      summaryEditedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open")
      )
    )
    .returning({ id: atomicUpdates.id });

  return { ok: rows.length > 0 };
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
 * hand-edit freeze, same rationale as the import-based add actions.
 */
export async function removeEventFromAtomicUpdate(input: {
  tenantId: string;
  userId: string;
  atomicUpdateId: string;
  eventId: string;
  confirmEmptyDeletion?: boolean;
  database?: Database;
}): Promise<ReassignResult> {
  const { tenantId, userId, atomicUpdateId, eventId, confirmEmptyDeletion } = input;
  const database = input.database ?? defaultDb;

  const [event] = await database
    .select({ atomicUpdateId: changeEvents.atomicUpdateId })
    .from(changeEvents)
    .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)))
    .limit(1);

  if (!event || event.atomicUpdateId !== atomicUpdateId) {
    return { ok: false, reason: "Change event does not belong to this atomic update." };
  }

  return reassignChangeEvent({
    tenantId,
    userId,
    eventId,
    target: { kind: "detach" },
    confirmEmptyDeletion,
    forceRegenerate: true,
  });
}

export async function setAtomicUpdateSize(
  tenantId: string,
  id: string,
  size: "s" | "m" | "l" | "xl",
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    .set({ size, sizeEditedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open")
      )
    )
    .returning({ id: atomicUpdates.id });
  return { ok: rows.length > 0 };
}

export async function setAtomicUpdateCategory(
  tenantId: string,
  id: string,
  category: "new" | "improvement" | "fix" | "announcement",
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    // No freeze column: category is set once by the LLM and otherwise only by
    // a user; it is never auto-regenerated, so nothing needs to be protected.
    .set({ category, updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open")
      )
    )
    .returning({ id: atomicUpdates.id });
  return { ok: rows.length > 0 };
}
