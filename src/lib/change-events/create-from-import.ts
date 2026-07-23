import { db as defaultDb } from "@/db";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { getCommitDiff as defaultGetCommitDiff } from "@/lib/integrations/github/github";
import { importSelectedCommits, type CommitSelection, type GetCommitDiff } from "./import-commits";
import { importSelectedPullRequests, type PullRequestSelection } from "./import-pull-requests";
import { createAtomicUpdateFromEvents, type CreateFromEventsResult } from "./create-from-events";

type Database = typeof defaultDb;

// A no-op stand-in for the auto-clustering resolver. When importing a
// selection the user is explicitly grouping into ONE atomic update, the
// per-event auto-resolver must NOT run — it would scatter the freshly imported
// events across generated updates. They land unassigned, then get grouped by
// createAtomicUpdateFromEvents below.
const NO_RESOLVE = async () => {};

/**
 * Imports the selected commits and groups ALL of them into ONE new atomic
 * update — the "New atomic update" flow that shares the import selector.
 * Auto-resolution is skipped (NO_RESOLVE) so the events land unassigned first,
 * then `createAtomicUpdateFromEvents` folds them into a single new update.
 * There are no source atomic updates to empty (the events are freshly
 * imported and unassigned), so this never returns `needsConfirmation`.
 */
export async function createAtomicUpdateFromImportedCommits(
  input: { tenantId: string; userId: string; selections: CommitSelection[] },
  deps: {
    getCommitDiff?: GetCommitDiff;
    enrich?: EnrichChangeItem;
    database?: Database;
    createFromEvents?: typeof createAtomicUpdateFromEvents;
  } = {}
): Promise<CreateFromEventsResult> {
  const database = deps.database ?? defaultDb;
  const getCommitDiff = deps.getCommitDiff ?? defaultGetCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
  const createFromEvents = deps.createFromEvents ?? createAtomicUpdateFromEvents;

  const { eventIds } = await importSelectedCommits(
    { tenantId: input.tenantId, selections: input.selections },
    getCommitDiff,
    enrich,
    database,
    NO_RESOLVE
  );
  if (eventIds.length === 0) return { ok: false, reason: "No change events were imported." };

  return createFromEvents(
    { tenantId: input.tenantId, userId: input.userId, eventIds, confirmEmptyDeletion: true },
    { database }
  );
}

/** Pull-request sibling of `createAtomicUpdateFromImportedCommits`. */
export async function createAtomicUpdateFromImportedPullRequests(
  input: { tenantId: string; userId: string; selections: PullRequestSelection[] },
  deps: {
    enrich?: EnrichChangeItem;
    database?: Database;
    createFromEvents?: typeof createAtomicUpdateFromEvents;
  } = {}
): Promise<CreateFromEventsResult> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const createFromEvents = deps.createFromEvents ?? createAtomicUpdateFromEvents;

  const { eventIds } = await importSelectedPullRequests(
    { tenantId: input.tenantId, selections: input.selections },
    { enrich, database, resolvePending: NO_RESOLVE }
  );
  if (eventIds.length === 0) return { ok: false, reason: "No change events were imported." };

  return createFromEvents(
    { tenantId: input.tenantId, userId: input.userId, eventIds, confirmEmptyDeletion: true },
    { database }
  );
}
