import { db as defaultDb } from "@/db";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { getCommitDiff as defaultGetCommitDiff } from "@/lib/integrations/github/github";
import { importSelectedCommits, type CommitSelection, type GetCommitDiff } from "./import-commits";
import { importSelectedPullRequests, type PullRequestSelection } from "./import-pull-requests";
import { importSelectedTasks, type TaskImportSelection } from "./import-notion-tasks";
import { createAtomicUpdateFromEvents, type CreateFromEventsResult } from "./create-from-events";
import { addEventsToExistingAtomicUpdate, type AddEventsResult } from "./add-events-to-atomic-update";

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

/**
 * Notion-task sibling of `createAtomicUpdateFromImportedCommits`.
 *
 * `getBody` is threaded through rather than defaulted because fetching a page's
 * text needs a live, possibly-refreshed Notion token, which only the caller
 * holding the connection can supply.
 */
export async function createAtomicUpdateFromImportedTasks(
  input: { tenantId: string; userId: string; selections: TaskImportSelection[] },
  getBody: (pageId: string) => Promise<string>,
  deps: {
    enrich?: EnrichChangeItem;
    database?: Database;
    createFromEvents?: typeof createAtomicUpdateFromEvents;
  } = {}
): Promise<CreateFromEventsResult> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const createFromEvents = deps.createFromEvents ?? createAtomicUpdateFromEvents;

  const { eventIds } = await importSelectedTasks(
    { tenantId: input.tenantId, selections: input.selections },
    getBody,
    { enrich, database, resolvePending: NO_RESOLVE }
  );
  if (eventIds.length === 0) return { ok: false, reason: "No change events were imported." };

  return createFromEvents(
    { tenantId: input.tenantId, userId: input.userId, eventIds, confirmEmptyDeletion: true },
    { database }
  );
}

/**
 * Imports the selected commits and adds ALL of them as evidence to an EXISTING
 * atomic update — the per-card "Add change events" flow that shares the import
 * selector. Auto-resolution is skipped (the events belong to a specific
 * update, not the auto-clusterer), then `addEventsToExistingAtomicUpdate`
 * attaches them and regenerates the update's summary from the new evidence.
 * The freshly imported events are unassigned, so there are no source updates to
 * empty — this never returns `needsConfirmation`.
 */
export async function addImportedCommitsToAtomicUpdate(
  input: { tenantId: string; userId: string; atomicUpdateId: string; selections: CommitSelection[] },
  deps: {
    getCommitDiff?: GetCommitDiff;
    enrich?: EnrichChangeItem;
    database?: Database;
    addEvents?: typeof addEventsToExistingAtomicUpdate;
  } = {}
): Promise<AddEventsResult> {
  const database = deps.database ?? defaultDb;
  const getCommitDiff = deps.getCommitDiff ?? defaultGetCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
  const addEvents = deps.addEvents ?? addEventsToExistingAtomicUpdate;

  const { eventIds } = await importSelectedCommits(
    { tenantId: input.tenantId, selections: input.selections },
    getCommitDiff,
    enrich,
    database,
    NO_RESOLVE
  );
  if (eventIds.length === 0) return { ok: false, reason: "No change events were imported." };

  return addEvents(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      atomicUpdateId: input.atomicUpdateId,
      eventIds,
      confirmEmptyDeletion: true,
    },
    { database }
  );
}

/** Pull-request sibling of `addImportedCommitsToAtomicUpdate`. */
export async function addImportedPullRequestsToAtomicUpdate(
  input: { tenantId: string; userId: string; atomicUpdateId: string; selections: PullRequestSelection[] },
  deps: {
    enrich?: EnrichChangeItem;
    database?: Database;
    addEvents?: typeof addEventsToExistingAtomicUpdate;
  } = {}
): Promise<AddEventsResult> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const addEvents = deps.addEvents ?? addEventsToExistingAtomicUpdate;

  const { eventIds } = await importSelectedPullRequests(
    { tenantId: input.tenantId, selections: input.selections },
    { enrich, database, resolvePending: NO_RESOLVE }
  );
  if (eventIds.length === 0) return { ok: false, reason: "No change events were imported." };

  return addEvents(
    {
      tenantId: input.tenantId,
      userId: input.userId,
      atomicUpdateId: input.atomicUpdateId,
      eventIds,
      confirmEmptyDeletion: true,
    },
    { database }
  );
}
