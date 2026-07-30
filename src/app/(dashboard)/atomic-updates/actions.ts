"use server";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reassignChangeEvent, type ReassignResult } from "@/lib/change-events/reassign";

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
  // events get on /change-events.
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
  filters: AtomicUpdateListFilters = {}
): Promise<AtomicUpdateRow[]> {
  const session = await requireSession();

  const atomics = await db
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
        eq(atomicUpdates.tenantId, session.user.tenantId),
        filters.showHidden
          ? inArray(atomicUpdates.status, ["open", "hidden"])
          : eq(atomicUpdates.status, "open"),
        // Compose candidate set: an atomic update already linked to a draft
        // release is spoken for and shows up on that draft instead — see
        // getOpenAtomicUpdates in release-claim.ts for the same rule. A no-op
        // for the hidden rows (only an unlinked update can be hidden), so it
        // costs nothing to leave it applying to both.
        isNull(atomicUpdates.releaseId),
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
export async function hasCuratableAtomicUpdates(): Promise<boolean> {
  const session = await requireSession();

  const [any] = await db
    .select({ id: atomicUpdates.id })
    .from(atomicUpdates)
    .where(
      and(
        eq(atomicUpdates.tenantId, session.user.tenantId),
        inArray(atomicUpdates.status, ["open", "hidden"]),
        isNull(atomicUpdates.releaseId)
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
 * releaseId IS NULL`. One already claimed into a draft release must not be
 * hidden here — hiding a title mid-draft is a different, unhandled concern,
 * and `listAtomicUpdates` only ever shows unlinked-open updates in the first
 * place, so the UI never offers this action on a linked one anyway.
 */
export async function hideAtomicUpdate(id: string): Promise<{ ok: boolean }> {
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
 * Bulk form of `hideAtomicUpdate`: hides every OPEN, unlinked atomic
 * update in `ids` in one statement. The WHERE guard is identical
 * (`status = 'open' AND releaseId IS NULL`, tenant-scoped), so ids that are
 * released, already linked to a draft, or belong to another tenant are
 * silently skipped rather than erroring — `count` reports how many actually
 * flipped, letting the caller distinguish a full from a partial hide.
 */
export async function bulkHideAtomicUpdates(ids: string[]): Promise<{ count: number }> {
  const session = await requireSession();
  if (ids.length === 0) return { count: 0 };

  const rows = await db
    .update(atomicUpdates)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(
      and(
        inArray(atomicUpdates.id, ids),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.releaseId)
      )
    )
    .returning({ id: atomicUpdates.id });

  revalidatePath("/atomic-updates");
  return { count: rows.length };
}

/**
 * Permanently deletes open, unlinked atomic updates (a hard DB row delete,
 * unlike `bulkHideAtomicUpdates`, which only flips them to `hidden`).
 * The WHERE guard matches the hide action's — `status = 'open' AND releaseId
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
export async function bulkDeleteAtomicUpdates(ids: string[]): Promise<{ count: number }> {
  const session = await requireSession();
  if (ids.length === 0) return { count: 0 };

  const rows = await db
    .delete(atomicUpdates)
    .where(
      and(
        inArray(atomicUpdates.id, ids),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.releaseId)
      )
    )
    .returning({ id: atomicUpdates.id });

  revalidatePath("/atomic-updates");
  return { count: rows.length };
}

/**
 * Reverses `hideAtomicUpdate`: flips a `hidden` atomic update back to
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

export async function setAtomicUpdateSize(
  id: string,
  size: "s" | "m" | "l" | "xl"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const rows = await db
    .update(atomicUpdates)
    .set({ size, sizeEditedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open")
      )
    )
    .returning({ id: atomicUpdates.id });
  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}

export async function setAtomicUpdateCategory(
  id: string,
  category: "new" | "improvement" | "fix" | "announcement"
): Promise<{ ok: boolean }> {
  const session = await requireSession();
  const rows = await db
    .update(atomicUpdates)
    // No freeze column: category is set once by the LLM and otherwise only by
    // a user; it is never auto-regenerated, so nothing needs to be protected.
    .set({ category, updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, session.user.tenantId),
        eq(atomicUpdates.status, "open")
      )
    )
    .returning({ id: atomicUpdates.id });
  revalidatePath("/atomic-updates");
  return { ok: rows.length > 0 };
}
