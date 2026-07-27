# Import Notion tasks as change events

Enable the **Tasks** source in the change-events **Import** modal so a tenant can
manually pull completed Notion tasks into the pipeline — the same pipeline the
Notion webhook feeds — as a backfill / recovery path for tasks whose webhooks
were missed.

## Problem

The Import modal (`src/app/(dashboard)/change-events/import-dialog.tsx`) already
supports importing GitHub commits and pull requests, and its description says
*"From commits or PRs for now — Notion tasks are next."* Task import is disabled:
`enabledTypes={["commit", "pull_request"]}`.

Meanwhile the Notion webhook is at-most-once — a completed task whose delivery
was dropped (server down, tunnel down, or an event Notion never resent) silently
never becomes a change event, with no way to recover it. There is no backfill.

## Goal

Add a third importable source — Notion **tasks** — to the Import flow only,
listing the connected database's Done tasks that aren't already imported, and
running the selected ones through the existing `ingestNotionTask` pipeline.

## Scope

**In scope:** the main change-events **Import** flow (the default `ImportDialog`
usage on `/change-events`).

**Out of scope (deliberately, for a later change):** the two *other* callers that
reuse the same selector — the "New atomic update" flow
(`createAtomicUpdateFrom*`) and the per-card "Add events to atomic update" flow
(`addImported*ToAtomicUpdate`). They stay commit/PR only. Task support there is a
follow-up; nothing in this design blocks it.

Also out of scope: importing non-Done tasks, a status filter/override,
auto-backfill on connect, and any change to the webhook path.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Candidate set | Tasks currently at the connection's `doneValues`, not already imported | Consistent with the webhook; a manually-imported not-done task would be a misleading "shipped" change event |
| Ingest path | Reuse `ingestNotionTask` per selected task | Identical enrichment/resolution to the webhook; idempotent; no second pipeline |
| Listing query | `POST /v1/data_sources/{id}/query`, `Notion-Version: 2025-09-03` | The older `POST /v1/databases/{id}/query` returned the *wrong* data source's rows in testing; the data-source query is authoritative |
| "Completed at" | `last_edited_time` proxy | Notion has no timestamp for when a task reached Done; `last_edited_time` is the only available signal — used for `completedAt`, sort order, and the After/Before filter |
| Gating | Requires an `active` Notion connection with a `databaseId` + `statusPropertyId` + non-empty `doneValues` | Same gate as the webhook; no connection → empty list |

## Data flow

```
listImportableTasks({since?, until?})
  → active notion_connections row (tenant-scoped)
  → resolve data_source_id from connection.databaseId
  → query data source: Status ∈ doneValues, newest first, bounded page size
  → flag imported = pageId already a non-excluded change_event
  → ImportableTask[] { pageId, title, url, completedAt, status, imported }

importTasks({selections})
  → for each TaskSelection { pageId, title, url, completedAt }:
       getPageBodyText(token, pageId)         // description = page body
       ingestNotionTask({ tenantId, pageId, title, description, url, completedAt })
         // filterTask → enrich → onConflictDoNothing upsert → resolvePendingEvents
  → revalidatePath("/change-events"), revalidatePath("/atomic-updates")
  → { importedCount }
```

Idempotency rests on the existing `(tenantId, provider, externalId=pageId)` unique
index inside `ingestNotionTask`; re-importing an already-imported task is a no-op
that resolves nothing new.

## Components

### New: `src/lib/integrations/notion/client.ts` additions

- `resolveDataSourceId(token, databaseId): Promise<string>` — `GET /v1/databases/{id}`
  (`2025-09-03`), returns `data_sources[0].id`. (A Notion database currently maps
  to one data source in this workspace; if multiple ever appear, take the first
  and log — out of scope to disambiguate.)
- `listDoneTasks(token, dataSourceId, doneValues, statusPropertyName, opts?): Promise<NotionTaskSummary[]>`
  — `POST /v1/data_sources/{id}/query` (`2025-09-03`) filtered to
  `Status ∈ doneValues`, sorted by `last_edited_time desc`, `page_size` bounded
  (e.g. 100, single page — no deep pagination in v1). Returns
  `{ pageId, title, url, status, lastEditedTime }[]`.

`getPageBodyText` and `getPage` are unchanged and reused.

### New: server actions in `src/app/(dashboard)/change-events/import-actions.ts`

Mirror the commit/PR pair, tenant-scoped, session-derived:

```ts
export type ImportableTask = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null; // last_edited_time
  status: string;
  imported: boolean;
};
export type TaskSelection = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null;
};

export async function listImportableTasks(input: { since?: string; until?: string }): Promise<{ tasks: ImportableTask[] }>;
export async function importTasks(input: { selections: TaskSelection[] }): Promise<{ importedCount: number }>;
```

- `listImportableTasks`: load the tenant's `active` `notion_connections` row; if
  none (or missing database/status/doneValues), return `{ tasks: [] }`. Resolve
  the data source, `listDoneTasks`, apply `since`/`until` against
  `lastEditedTime` in code, flag `imported` via a single `change_events` query
  (`provider="notion"`, `externalId ∈ pageIds`, `status != "excluded"`), sort
  newest first.
- `importTasks`: for each selection, `withFreshToken` → `getPageBodyText` →
  `ingestNotionTask(...)`; count successes; revalidate. A per-task failure is
  logged and skipped (one bad page must not abort the batch), mirroring the
  webhook's per-connection fail-safe.

The file header comment already names this seam ("new sources get their own
list/import actions here").

### Modified: `import-dialog.tsx` (the shared selector)

- Add a `taskSubmit?: (selections: TaskSelection[]) => Promise<void>` prop and a
  `notionConnected: boolean` prop (passed by the page).
- Task selection state (`Map<string, TaskSelection>` keyed by `pageId`), task
  rows, and task load via `listImportableTasks`.
- The default `ImportDialog` usage on `/change-events` passes `taskSubmit`
  (`importTasks`) and enables `"task"` in `enabledTypes`. The two reuse callers
  do **not** pass it and keep their current `enabledTypes` → their Tasks tab
  never appears.
- **Filters differ by type:** for `task`, the repo tab bar is replaced by the
  single Notion source (no repo tabs); keep the search box (task title) and the
  After/Before date filters (on `completedAt`). For `commit`/`pull_request`,
  unchanged.
- **Empty/disabled state:** when `pickerType === "task"` and `!notionConnected`,
  show a hint ("Connect Notion to import tasks") instead of the picker.
- Drop the "— Notion tasks are next" clause from the default `description`.

### Modified: the `/change-events` page

Pass `notionConnected` (an `active` `notion_connections` row exists for the
tenant) into the default `ImportDialog`.

## Error handling

- Notion API failures during listing → empty task list + inline "Couldn't load
  tasks. Try again." (mirrors the commit/PR catch), never blanks the modal.
- `importTasks` per-task failure → logged, skipped; the action returns the count
  that succeeded. A resolution/enrichment error inside `ingestNotionTask` is
  already handled by the existing pipeline.
- No active connection → empty list + the connect hint; the action returns
  `{ tasks: [] }` / imports nothing.

## Testing

- `listDoneTasks` / `resolveDataSourceId` — `fetch` stubbed: correct endpoint +
  `2025-09-03` version + bearer, done-value filter in the request body, mapping
  of results, single-page behavior.
- `listImportableTasks` — no connection → empty; done tasks returned; `imported`
  flag set from existing non-excluded `change_events`; tenant scoping;
  since/until applied to `lastEditedTime`.
- `importTasks` — ingests each selection via `ingestNotionTask` (mocked or real
  `_test` DB); re-importing an already-imported page is a no-op (one row);
  per-task failure is skipped and counted correctly; revalidation called.
- UI — the Tasks tab appears only when enabled + `taskSubmit` provided; the
  no-connection hint renders; task filters swap in.

## Accepted gaps

- **Single page of results (≤100).** No deep pagination in v1; a tenant with
  >100 Done tasks sees the most recent 100. Documented; add pagination later if
  needed.
- **`last_edited_time` is an imperfect `completedAt`.** A task edited after
  completion carries a later timestamp than when it actually shipped. Acceptable
  for a manual backfill.
