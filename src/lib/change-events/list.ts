import { and, desc, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents, repos } from "@/db/schema";
import { reassignChangeEvent } from "@/lib/change-events/reassign";

type Database = typeof defaultDb;

export type ImportRepo = { id: string; fullName: string; watchedBranch: string };

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
export async function listChangeEvents(
  tenantId: string,
  filters: ChangeEventFilters,
  database: Database = defaultDb
): Promise<ChangeEventRow[]> {
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

  const rows = await database
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      provider: changeEvents.provider,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      taskTitle: changeEvents.taskTitle,
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
    const title = row.prTitle ?? firstLine ?? row.taskTitle ?? "Untitled";
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

/**
 * Bulk reassignment for the change-events list. Only the two non-ambiguous
 * single-row targets are offered in bulk — move every selected event onto one
 * existing atomic update, or detach them all — deliberately NOT "split to
 * new" (which would mean one new atomic update per event, an unclear intent).
 *
 * Each event is run through `reassignChangeEvent` individually (its own
 * transaction) rather than in one statement, so the core's per-event tenant
 * checks, released-source rejection, and empty-source cleanup all still hold.
 * `confirmEmptyDeletion: true` is passed unconditionally: at this point the
 * user has chosen a bulk move, so a source atomic update left empty by it is
 * dissolved rather than bouncing back a per-event confirmation dialog the
 * bulk UI has no place to show. `failed` counts events the core rejected
 * (e.g. one sitting in a published atomic update), which are left untouched.
 */
export async function bulkReassignChangeEvents(input: {
  tenantId: string;
  userId: string;
  eventIds: string[];
  target: { kind: "existing"; atomicUpdateId: string } | { kind: "detach" };
}): Promise<{ succeeded: number; failed: number; deletedAtomicUpdates: number }> {
  const { tenantId, userId, eventIds, target } = input;

  let succeeded = 0;
  let failed = 0;
  let deletedAtomicUpdates = 0;

  for (const eventId of eventIds) {
    const result = await reassignChangeEvent({
      tenantId,
      userId,
      eventId,
      target,
      confirmEmptyDeletion: true,
    });
    if (result.ok) {
      succeeded += 1;
      if (result.deletedAtomicUpdate) deletedAtomicUpdates += 1;
    } else {
      failed += 1;
    }
  }

  return { succeeded, failed, deletedAtomicUpdates };
}

/**
 * Permanently deletes the selected change events (a hard DB row delete, unlike
 * "detach", which only sets a row aside). Tenant-scoped via the WHERE clause —
 * the session's tenantId is the security boundary, never client input.
 *
 * Events that belong to a PUBLISHED atomic update are excluded from the
 * delete (the `NOT EXISTS … status = 'released'` guard): they are shipped
 * history, and the reassign core likewise refuses to move an event out of a
 * released atomic update. A NULL `atomicUpdateId` (the common case for junk /
 * excluded events) satisfies the guard and is deleted. `count` reports how
 * many rows were actually removed, so a partial delete is visible to the UI.
 *
 * This intentionally does NOT prune an atomic update left empty by the delete:
 * silently deleting one that a draft release still references would be more
 * destructive than the request implies. An emptied open atomic update simply
 * remains on the atomic-updates page for the user to hide or handle there.
 */
export async function bulkDeleteChangeEvents(
  tenantId: string,
  eventIds: string[],
  database: Database = defaultDb
): Promise<{ count: number }> {
  if (eventIds.length === 0) return { count: 0 };

  const rows = await database
    .delete(changeEvents)
    .where(
      and(
        inArray(changeEvents.id, eventIds),
        eq(changeEvents.tenantId, tenantId),
        not(
          sql`EXISTS (SELECT 1 FROM ${atomicUpdates} WHERE ${atomicUpdates.id} = ${changeEvents.atomicUpdateId} AND ${atomicUpdates.status} = 'released')`
        )
      )
    )
    .returning({ id: changeEvents.id });

  return { count: rows.length };
}

export async function listImportRepos(
  tenantId: string,
  database: Database = defaultDb
): Promise<ImportRepo[]> {
  const tenantRepos = await database.select().from(repos).where(eq(repos.tenantId, tenantId));

  return tenantRepos.map((r) => ({
    id: r.id,
    fullName: r.githubRepoFullName,
    watchedBranch: r.watchedBranch,
  }));
}
