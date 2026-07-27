# Import Notion Tasks as Change Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the **Tasks** source in the change-events Import modal so a tenant can manually pull their connected Notion database's completed (Done) tasks into the pipeline, as a backfill/recovery path for tasks whose webhooks were missed.

**Architecture:** Two new Notion REST client functions (resolve the connection's data source, list its Done tasks via the `2025-09-03` data-source query API) → a `listImportableTasks`/`importTasks` server-action pair mirroring the existing commit/PR import seam, where import reuses the webhook's `ingestNotionTask` per selected task → the shared `EventMultiSelect` gains a `"task"` type and `ImportDialog` wires task listing/selection/submit, gated on an active Notion connection. Import flow only; the two other selector reuses (New atomic update / Add events) stay commit+PR.

**Tech Stack:** Next.js 16 App Router (server actions + server-component page), Drizzle ORM + Postgres, Vitest 4 against a real `_test` Postgres DB, React client components, `sonner` toasts.

**Spec:** `docs/superpowers/specs/2026-07-27-import-notion-tasks-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Candidate set = Done tasks only**: tasks currently at the connection's `doneValues`, not already imported. No non-Done tasks, no status override.
- **Reuse the webhook pipeline**: import ingests each selected task via the existing `ingestNotionTask(input)` (`src/lib/change-events/ingest-notion-task.ts`) — do NOT build a second pipeline. Idempotency is its `(tenantId, provider, externalId=pageId)` unique constraint; re-importing is a no-op.
- **Listing uses the data-source query**: `POST /v1/data_sources/{id}/query` with `Notion-Version: 2025-09-03`, and resolve the `data_source_id` from `connection.databaseId` at query time (`GET /v1/databases/{id}`, same version). The older `2022-06-28` DB-query endpoint returns the wrong data source. `getPage`/`getPageBodyText` stay on `2022-06-28` (page-id based, already correct).
- **`completedAt` = `last_edited_time`**: Notion has no "reached Done" timestamp; use `last_edited_time` as the sort key, the After/Before filter key, and the ingested `completedAt`.
- **Gating**: task import requires an `active` `notion_connections` row with `databaseId`, `statusPropertyId`, `statusPropertyName`, and non-empty `doneValues`. No connection → empty list, no task tab payoff (show a connect hint).
- **Scope = the main Import flow only**: the `ImportDialog` usage on `/change-events`. The "New atomic update" and "Add events to atomic update" reuses of the selector stay `enabledTypes={["commit","pull_request"]}`.
- **Tenant isolation**: every query filters on `session.user.tenantId`; tenant/user come from the session, never from input.
- **Tests**: Vitest, real `_test` Postgres DB, source imported via relative paths, `fetch` stubbed with `vi.stubGlobal`, internal modules mocked with `vi.mock`, unique tenant seeded and deleted in `afterEach`. Run one file: `npx vitest run <path>`.
- **Verification commands**: `npx vitest run` (full suite), `npm run typecheck`, `npm run lint`.

---

## File Structure

**Modified:**

| File | Change |
| --- | --- |
| `src/lib/integrations/notion/client.ts` | Add `resolveDataSourceId`, `listDoneTasks`, `NotionTaskSummary`; give the private `request` an optional Notion-version arg. |
| `src/app/(dashboard)/change-events/import-actions.ts` | Add `ImportableTask`, `TaskSelection`, `listImportableTasks`, `importTasks`, `isNotionConnected`. |
| `src/app/(dashboard)/_components/event-multi-select.tsx` | Add `"task"` to `PickerType` + `TYPE_LABEL`; remove the hardcoded disabled "Tasks — soon" item. |
| `src/app/(dashboard)/change-events/import-dialog.tsx` | Task listing/rows/selection/submit; per-type filters; `enableTasks` + `notionConnected` props; drop the "Notion tasks are next" copy. |
| `src/app/(dashboard)/change-events/page.tsx` | Pass `enableTasks` + `notionConnected` to the default `ImportDialog`. |

**Test files:** `tests/lib/integrations/notion/client.test.ts` (extend), `tests/app/import-actions-tasks.test.ts` (new).

---

## Task 1: Notion client — resolve data source + list Done tasks

**Files:**
- Modify: `src/lib/integrations/notion/client.ts`
- Test: `tests/lib/integrations/notion/client.test.ts` (extend)

**Interfaces:**
- Consumes: the existing private `request<T>` and `plainText` helpers, `NotionApiError`.
- Produces:
  - `type NotionTaskSummary = { pageId: string; title: string; url: string; status: string | null; lastEditedTime: string | null }`
  - `resolveDataSourceId(token: string, databaseId: string): Promise<string>`
  - `listDoneTasks(token: string, dataSourceId: string, statusPropertyName: string, doneValues: string[]): Promise<NotionTaskSummary[]>`

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/integrations/notion/client.test.ts`. First extend the import at the top of the file to include the new symbols:

```ts
import {
  listDatabases,
  getDatabaseProperties,
  getPage,
  getPageBodyText,
  resolveDataSourceId,
  listDoneTasks,
  NotionApiError,
} from "../../../../src/lib/integrations/notion/client";
```

Then add these tests inside the top-level `describe("notion client", ...)` block (the file already defines a `jsonResponse` helper and stubs `fetch` in `beforeEach`/`afterEach`):

```ts
  it("resolves the data source id from a database (2025-09-03)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data_sources: [{ id: "ds-1", name: "Tasks" }] }));
    const id = await resolveDataSourceId("tok", "db-1");
    expect(id).toBe("ds-1");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/databases/db-1");
    expect((init?.headers as Record<string, string>)["Notion-Version"]).toBe("2025-09-03");
  });

  it("throws NotionApiError when a database has no data sources", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data_sources: [] }));
    await expect(resolveDataSourceId("tok", "db-1")).rejects.toBeInstanceOf(NotionApiError);
  });

  it("lists Done tasks via the data-source query, filtered by doneValues", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: "page-1",
            url: "https://notion.so/page-1",
            last_edited_time: "2026-07-25T18:03:00.000Z",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Fix SSO 502" }] },
              Status: { type: "status", status: { name: "Done" } },
            },
          },
        ],
      })
    );
    const tasks = await listDoneTasks("tok", "ds-1", "Status", ["Done", "Shipped"]);
    expect(tasks).toEqual([
      {
        pageId: "page-1",
        title: "Fix SSO 502",
        url: "https://notion.so/page-1",
        status: "Done",
        lastEditedTime: "2026-07-25T18:03:00.000Z",
      },
    ]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
    expect((init?.headers as Record<string, string>)["Notion-Version"]).toBe("2025-09-03");
    const body = JSON.parse(init?.body as string);
    expect(body.filter).toEqual({
      or: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Status", status: { equals: "Shipped" } },
      ],
    });
    expect(body.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
  });

  it("returns [] for empty doneValues without calling fetch", async () => {
    expect(await listDoneTasks("tok", "ds-1", "Status", [])).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/lib/integrations/notion/client.test.ts`
Expected: FAIL — `resolveDataSourceId` / `listDoneTasks` are not exported.

- [ ] **Step 3: Give `request` an optional version, then add the functions**

In `src/lib/integrations/notion/client.ts`, change the `request` signature and the header line so callers can override the Notion version (existing callers keep the default `2022-06-28`):

```ts
async function request<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  notionVersion: string = NOTION_VERSION
): Promise<T> {
```

and inside its `headers` object change:

```ts
        "Notion-Version": NOTION_VERSION,
```
to
```ts
        "Notion-Version": notionVersion,
```

Then append the new version constant, type, and functions to the end of the file (after `getPageBodyText`):

```ts
const DATA_SOURCE_VERSION = "2025-09-03";

export type NotionTaskSummary = {
  pageId: string;
  title: string;
  url: string;
  status: string | null;
  lastEditedTime: string | null;
};

// A Notion database currently maps to one data source in this app's workspaces.
// The 2025-09-03 API exposes them; the older DB-query endpoint returns the wrong
// one, so listing must go through the data source.
export async function resolveDataSourceId(token: string, databaseId: string): Promise<string> {
  const data = await request<{ data_sources?: { id: string; name?: string }[] }>(
    token,
    `/v1/databases/${databaseId}`,
    {},
    DATA_SOURCE_VERSION
  );
  const first = data.data_sources?.[0];
  if (!first) throw new NotionApiError(404, `Notion database ${databaseId} has no data sources`);
  return first.id;
}

type RawTaskResult = {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, RawProperty>;
};

export async function listDoneTasks(
  token: string,
  dataSourceId: string,
  statusPropertyName: string,
  doneValues: string[]
): Promise<NotionTaskSummary[]> {
  if (doneValues.length === 0) return [];
  const body = {
    // Notion's status filter takes a single `equals`; OR them for multiple done values.
    filter: { or: doneValues.map((value) => ({ property: statusPropertyName, status: { equals: value } })) },
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    // Single page (spec: no deep pagination in v1).
    page_size: 100,
  };
  const data = await request<{ results: RawTaskResult[] }>(
    token,
    `/v1/data_sources/${dataSourceId}/query`,
    { method: "POST", body: JSON.stringify(body) },
    DATA_SOURCE_VERSION
  );
  return data.results.map((r) => {
    let title = "";
    let status: string | null = null;
    for (const [name, prop] of Object.entries(r.properties ?? {})) {
      if (prop.type === "title") title = plainText(prop.title);
      if (name === statusPropertyName) status = prop.status?.name ?? prop.select?.name ?? null;
    }
    return { pageId: r.id, title, url: r.url ?? "", status, lastEditedTime: r.last_edited_time ?? null };
  });
}
```

Note: `RawProperty` and `plainText` already exist in this file (used by `getPage`); reuse them — do not redefine.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/lib/integrations/notion/client.test.ts`
Expected: PASS (all prior tests plus the 4 new ones).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/lib/integrations/notion/client.ts tests/lib/integrations/notion/client.test.ts
git commit -m "feat: Notion client — resolve data source and list Done tasks"
```

---

## Task 2: Server actions — list + import Notion tasks

**Files:**
- Modify: `src/app/(dashboard)/change-events/import-actions.ts`
- Test: `tests/app/import-actions-tasks.test.ts`

**Interfaces:**
- Consumes: `resolveDataSourceId`, `listDoneTasks`, `getPageBodyText` (Task 1 + existing), `withFreshToken` (`src/lib/integrations/notion/connection.ts`), `ingestNotionTask` (`src/lib/change-events/ingest-notion-task.ts`), `notionConnections` (`@/db/schema`), `requireSession`.
- Produces:
  - `type ImportableTask = { pageId: string; title: string; url: string; completedAt: string | null; status: string | null; imported: boolean }`
  - `type TaskSelection = { pageId: string; title: string; url: string; completedAt: string | null }`
  - `listImportableTasks(input: { since?: string; until?: string }): Promise<{ tasks: ImportableTask[] }>`
  - `importTasks(input: { selections: TaskSelection[] }): Promise<{ importedCount: number }>`
  - `isNotionConnected(): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

Create `tests/app/import-actions-tasks.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, notionConnections, changeEvents } from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/credentials/encryption";

const TENANT = "Import Tasks Actions Test Tenant";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../src/lib/integrations/notion/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/integrations/notion/client")>();
  return {
    ...actual,
    resolveDataSourceId: vi.fn(async () => "ds-1"),
    listDoneTasks: vi.fn(async () => [
      { pageId: "page-1", title: "Fix SSO 502", url: "https://notion.so/page-1", status: "Done", lastEditedTime: "2026-07-25T18:03:00.000Z" },
      { pageId: "page-2", title: "Dark mode", url: "https://notion.so/page-2", status: "Done", lastEditedTime: "2026-07-20T10:00:00.000Z" },
    ]),
    getPageBodyText: vi.fn(async () => "Body detail."),
  };
});
vi.mock("../../src/lib/change-events/ingest-notion-task", () => ({
  ingestNotionTask: vi.fn(async () => {}),
}));

import {
  listImportableTasks,
  importTasks,
  isNotionConnected,
} from "../../src/app/(dashboard)/change-events/import-actions";
import { ingestNotionTask } from "../../src/lib/change-events/ingest-notion-task";

async function seedConnection(overrides: Partial<typeof notionConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: "ws-1",
    databaseId: "db-1",
    databaseName: "Tasks",
    statusPropertyId: "prop-status",
    statusPropertyName: "Status",
    doneValues: ["Done"],
    status: "active",
    ...overrides,
  });
  return tenant.id;
}

describe("import Notion tasks actions", () => {
  afterEach(async () => {
    vi.mocked(ingestNotionTask).mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns [] when there is no active Notion connection", async () => {
    await seedConnection({ status: "misconfigured" });
    expect(await listImportableTasks({})).toEqual({ tasks: [] });
  });

  it("lists Done tasks and flags already-imported ones", async () => {
    const tid = await seedConnection();
    // page-1 already ingested as a (non-excluded) change_event
    await db.insert(changeEvents).values({
      tenantId: tid, repoId: null, type: "task", provider: "notion",
      externalId: "page-1", taskTitle: "Fix SSO 502",
    });
    const { tasks } = await listImportableTasks({});
    expect(tasks.map((t) => t.pageId)).toEqual(["page-1", "page-2"]);
    expect(tasks.find((t) => t.pageId === "page-1")!.imported).toBe(true);
    expect(tasks.find((t) => t.pageId === "page-2")!.imported).toBe(false);
  });

  it("applies the since filter against lastEditedTime", async () => {
    await seedConnection();
    const { tasks } = await listImportableTasks({ since: "2026-07-22T00:00:00Z" });
    expect(tasks.map((t) => t.pageId)).toEqual(["page-1"]); // page-2 (07-20) filtered out
  });

  it("imports selected tasks via ingestNotionTask and counts them", async () => {
    const tid = await seedConnection();
    const { importedCount } = await importTasks({
      selections: [{ pageId: "page-2", title: "Dark mode", url: "https://notion.so/page-2", completedAt: "2026-07-20T10:00:00.000Z" }],
    });
    expect(importedCount).toBe(1);
    expect(ingestNotionTask).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(ingestNotionTask).mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: tid, pageId: "page-2", title: "Dark mode", description: "Body detail.", url: "https://notion.so/page-2" });
    expect(arg.completedAt).toBeInstanceOf(Date);
  });

  it("skips a task whose ingest throws and still counts the rest", async () => {
    await seedConnection();
    vi.mocked(ingestNotionTask).mockRejectedValueOnce(new Error("boom"));
    const { importedCount } = await importTasks({
      selections: [
        { pageId: "page-1", title: "A", url: "u1", completedAt: null },
        { pageId: "page-2", title: "B", url: "u2", completedAt: null },
      ],
    });
    expect(importedCount).toBe(1);
    expect(ingestNotionTask).toHaveBeenCalledTimes(2);
  });

  it("isNotionConnected reflects an active connection", async () => {
    await seedConnection();
    expect(await isNotionConnected()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/import-actions-tasks.test.ts`
Expected: FAIL — `listImportableTasks` / `importTasks` / `isNotionConnected` are not exported.

- [ ] **Step 3: Add the actions**

Append to `src/app/(dashboard)/change-events/import-actions.ts`. First extend its imports (add these alongside the existing ones at the top of the file):

```ts
import { ne } from "drizzle-orm"; // already imported for commits — confirm; add if absent
import { notionConnections } from "@/db/schema";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { resolveDataSourceId, listDoneTasks, getPageBodyText } from "@/lib/integrations/notion/client";
import { ingestNotionTask } from "@/lib/change-events/ingest-notion-task";
```

(The file already imports `and, eq, inArray, ne` from `drizzle-orm`, `db`, `changeEvents`, `requireSession`, and `revalidatePath` — reuse those. Do not duplicate.)

Then append the actions:

```ts
export type ImportableTask = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null; // last_edited_time proxy
  status: string | null;
  imported: boolean;
};

export type TaskSelection = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null;
};

async function activeNotionConnection(tenantId: string) {
  const [conn] = await db
    .select()
    .from(notionConnections)
    .where(and(eq(notionConnections.tenantId, tenantId), eq(notionConnections.status, "active")))
    .limit(1);
  return conn ?? null;
}

export async function isNotionConnected(): Promise<boolean> {
  const session = await requireSession();
  return (await activeNotionConnection(session.user.tenantId)) !== null;
}

export async function listImportableTasks(input: {
  since?: string;
  until?: string;
}): Promise<{ tasks: ImportableTask[] }> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  if (!conn || !conn.databaseId || !conn.statusPropertyName || conn.doneValues.length === 0) {
    return { tasks: [] };
  }

  // A Notion API failure here throws; the dialog's load() catches it and shows
  // "Couldn't load tasks." No active connection is NOT an error — it returns [].
  const summaries = await withFreshToken(db, conn, async (token) => {
    const dataSourceId = await resolveDataSourceId(token, conn.databaseId!);
    return listDoneTasks(token, dataSourceId, conn.statusPropertyName!, conn.doneValues);
  });

  const since = input.since ? Date.parse(input.since) : null;
  const until = input.until ? Date.parse(input.until) : null;
  const filtered = summaries.filter((t) => {
    if (!t.lastEditedTime) return true; // keep undated
    const ts = Date.parse(t.lastEditedTime);
    if (since !== null && ts < since) return false;
    if (until !== null && ts > until) return false;
    return true;
  });

  const pageIds = filtered.map((t) => t.pageId);
  const existing = pageIds.length
    ? await db
        .select({ externalId: changeEvents.externalId })
        .from(changeEvents)
        .where(
          and(
            eq(changeEvents.tenantId, session.user.tenantId),
            eq(changeEvents.provider, "notion"),
            inArray(changeEvents.externalId, pageIds),
            ne(changeEvents.status, "excluded")
          )
        )
    : [];
  const importedIds = new Set(existing.map((e) => e.externalId));

  const tasks = filtered.map((t) => ({
    pageId: t.pageId,
    title: t.title,
    url: t.url,
    completedAt: t.lastEditedTime,
    status: t.status,
    imported: importedIds.has(t.pageId),
  }));
  return { tasks };
}

export async function importTasks(input: {
  selections: TaskSelection[];
}): Promise<{ importedCount: number }> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  if (!conn) return { importedCount: 0 };

  let importedCount = 0;
  for (const sel of input.selections) {
    try {
      const body = await withFreshToken(db, conn, (token) => getPageBodyText(token, sel.pageId));
      await ingestNotionTask({
        tenantId: session.user.tenantId,
        pageId: sel.pageId,
        title: sel.title,
        description: body || null,
        url: sel.url,
        completedAt: sel.completedAt ? new Date(sel.completedAt) : new Date(),
      });
      importedCount += 1;
    } catch (error) {
      // One bad page must not abort the batch (mirrors the webhook's per-item
      // fail-safe). ingestNotionTask is idempotent, so a duplicate is a no-op.
      console.error(`Failed to import Notion task ${sel.pageId}:`, error);
    }
  }

  revalidatePath("/change-events");
  revalidatePath("/atomic-updates");
  return { importedCount };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/app/import-actions-tasks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

```bash
git add "src/app/(dashboard)/change-events/import-actions.ts" tests/app/import-actions-tasks.test.ts
git commit -m "feat: server actions to list and import Notion tasks"
```

---

## Task 3: EventMultiSelect — add the `task` picker type

**Files:**
- Modify: `src/app/(dashboard)/_components/event-multi-select.tsx`

**Interfaces:**
- Produces: `PickerType` becomes `"commit" | "pull_request" | "task"`; `TYPE_LABEL` gains `task: "Tasks"`. The hardcoded disabled "Tasks — soon" `SelectItem` is removed (task now shows only when a caller includes it in `enabledTypes`).

No new tests — this is a presentational type change consumed by Task 4; it is verified by typecheck + lint + the full suite staying green.

- [ ] **Step 1: Widen `PickerType` and the label map**

In `src/app/(dashboard)/_components/event-multi-select.tsx`:

```ts
export type PickerType = "commit" | "pull_request" | "task";
```

and

```ts
const TYPE_LABEL: Record<PickerType, string> = { commit: "Commits", pull_request: "PRs", task: "Tasks" };
```

- [ ] **Step 2: Remove the hardcoded disabled task item**

Delete these lines from the `<SelectContent>` (the task option is now driven entirely by `enabledTypes`):

```tsx
            <SelectItem value="task" disabled>
              Tasks — soon
            </SelectItem>
```

- [ ] **Step 3: Verify nothing else broke**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all PASS. (`Record<PickerType, string>` now requires the `task` key — present; existing callers still pass `enabledTypes={["commit","pull_request"]}`, so the dropdown is unchanged for them.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/_components/event-multi-select.tsx"
git commit -m "feat: add task picker type to EventMultiSelect"
```

---

## Task 4: ImportDialog + page — wire task import into the modal

**Files:**
- Modify: `src/app/(dashboard)/change-events/import-dialog.tsx`
- Modify: `src/app/(dashboard)/change-events/page.tsx`

**Interfaces:**
- Consumes: `listImportableTasks`, `importTasks`, `ImportableTask`, `TaskSelection`, `isNotionConnected` (Task 2); `PickerType` incl. `"task"` (Task 3).
- Produces: `ImportDialog` gains `enableTasks?: boolean` and `notionConnected?: boolean` props; the `/change-events` page passes both.

No new unit tests (presentational wiring; the actions are covered in Task 2). Verified by typecheck + lint + full suite + a manual render check.

- [ ] **Step 1: Extend imports and props in `import-dialog.tsx`**

Add to the import from `./import-actions`:

```ts
import {
  listImportableCommits,
  importCommits,
  listImportablePullRequests,
  importPullRequests,
  listImportableTasks,
  importTasks,
  type ImportableCommit,
  type ImportablePullRequest,
  type ImportableTask,
  type TaskSelection,
} from "./import-actions";
```

Add the two props (with defaults) to the `ImportDialog` function's destructured params and its type:

```ts
  enableTasks = false,
  notionConnected = false,
}: {
  repos: ImportRepo[];
  // ...existing prop types unchanged...
  enableTasks?: boolean;
  notionConnected?: boolean;
}) {
```

Change the default description to drop the "Notion tasks are next" clause:

```ts
  description = "From commits, PRs, or Notion tasks.",
```

- [ ] **Step 2: Add task state and clear it on type change**

Add alongside the existing state:

```ts
  const [tasks, setTasks] = useState<ImportableTask[]>([]);
  const [selectedTasks, setSelectedTasks] = useState<Map<string, TaskSelection>>(new Map());
```

In `reset()`, add:

```ts
    setSelectedTasks(new Map());
```

In the `<EventMultiSelect onTypeChange={...}>` handler (Step 6), clearing all three selections is covered there.

- [ ] **Step 3: Load tasks when the task tab is active**

In `load()`, add a `task` branch (before the existing `pull_request` / else branches) and include it in the try/catch:

```ts
      if (pickerType === "task") {
        const { tasks } = await listImportableTasks({
          since: after ? `${after}T00:00:00Z` : undefined,
          until: before ? `${before}T23:59:59Z` : undefined,
        });
        setTasks(tasks);
      } else if (pickerType === "pull_request") {
        // ...existing...
```

and in its `catch`, add:

```ts
      if (pickerType === "task") {
        setTasks([]);
        setError("Couldn't load tasks. Try again.");
      } else if (pickerType === "pull_request") {
        // ...existing...
```

- [ ] **Step 4: Task rows, submit, and enabled types**

Add a `taskRows` mapping next to `commitRows`/`prRows`:

```ts
  const taskRows: PickerRow[] = tasks.map((t) => ({
    key: t.pageId,
    title: t.title || "(untitled task)",
    meta: (
      <>
        {t.status && <>{t.status} · </>}
        {t.completedAt &&
          new Date(t.completedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
      </>
    ),
    externalUrl: t.url || null,
    locked: t.imported,
    badge: t.imported ? "Imported" : undefined,
  }));
```

Change the `rows` and `selectedCount` derivations to include tasks:

```ts
  const rows: PickerRow[] =
    pickerType === "task" ? taskRows : pickerType === "pull_request" ? prRows : commitRows;
  const selectedCount =
    pickerType === "task" ? selectedTasks.size : pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;
```

Add a task submit default next to `doCommitSubmit`/`doPullRequestSubmit`:

```ts
  const doTaskSubmit = async (sel: TaskSelection[]) => {
    await importTasks({ selections: sel });
  };
```

In `onImport()`, add the task branch first:

```ts
    if (pickerType === "task") {
      await doTaskSubmit(Array.from(selectedTasks.values()));
    } else if (pickerType === "pull_request") {
      // ...existing...
```

and change `selectedCount` at the top of `onImport` to the type-aware version already defined (or compute inline):

```ts
    const selectedCount =
      pickerType === "task" ? selectedTasks.size : pickerType === "pull_request" ? selectedPRs.size : selectedCommits.size;
    if (selectedCount === 0) return;
```

Compute the enabled types from the prop:

```ts
  const enabledTypes: PickerType[] = enableTasks ? ["commit", "pull_request", "task"] : ["commit", "pull_request"];
```

(Import `PickerType` from the multi-select module if not already: it's re-exported via `import { EventMultiSelect, type PickerRow, type PickerType } from "../_components/event-multi-select";` — that import already brings `PickerType`.)

- [ ] **Step 5: Task submit label and empty/hint copy**

Extend the default `labelFor` to handle tasks:

```ts
  const labelFor =
    submitLabel ??
    (({ type, count, submitting: isSubmitting }: { type: PickerType; count: number; submitting: boolean }) =>
      isSubmitting
        ? "Importing…"
        : type === "task"
          ? `Import ${count} task${count === 1 ? "" : "s"}`
          : type === "pull_request"
            ? `Import ${count} PR${count === 1 ? "" : "s"}`
            : `Import ${count} commit${count === 1 ? "" : "s"}`);
```

- [ ] **Step 6: Wire the EventMultiSelect props for tasks**

Update the `<EventMultiSelect ... />` usage:

- `enabledTypes={enabledTypes}`
- `onTypeChange`: also clear task selection:

```tsx
          onTypeChange={(t) => {
            setPickerType(t);
            setSelectedCommits(new Map());
            setSelectedPRs(new Map());
            setSelectedTasks(new Map());
          }}
```

- `emptyLabel`: type-aware, with the connect hint for tasks:

```tsx
          emptyLabel={
            pickerType === "task"
              ? notionConnected
                ? "No completed tasks found."
                : "Connect Notion to import tasks."
              : pickerType === "pull_request"
                ? "No pull requests found."
                : "No commits found."
          }
```

- `selected` / `onSelectedChange`: add the task branch. `selected`:

```tsx
          selected={
            new Set(
              pickerType === "task"
                ? selectedTasks.keys()
                : pickerType === "pull_request"
                  ? selectedPRs.keys()
                  : selectedCommits.keys()
            )
          }
```

  and at the top of `onSelectedChange`, handle tasks (mirror the PR branch, keyed by `pageId`):

```tsx
            if (pickerType === "task") {
              setSelectedTasks((prev) => {
                const byKey = new Map<string, TaskSelection>();
                for (const t of tasks) {
                  byKey.set(t.pageId, { pageId: t.pageId, title: t.title, url: t.url, completedAt: t.completedAt });
                }
                const next = new Map<string, TaskSelection>();
                for (const key of nextKeys) {
                  const entry = prev.get(key) ?? byKey.get(key);
                  if (entry) next.set(key, entry);
                }
                return next;
              });
            } else if (pickerType === "pull_request") {
              // ...existing PR branch...
```

- `searchPlaceholder`: `pickerType === "task" ? "Search task titles…" : ...` (extend the existing ternary).
- `filtersSlot`: render the repo tabs only for non-task types (tasks come from one Notion source, not repos):

```tsx
          filtersSlot={
            pickerType === "task" ? null : (
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as string)}>
                {/* ...existing TabsList unchanged... */}
              </Tabs>
            )
          }
```

The `inlineFilters` (After/Before) stay as-is for all types.

- [ ] **Step 7: Wire the page**

In `src/app/(dashboard)/change-events/page.tsx`, import `isNotionConnected` and include it in the `Promise.all`, then pass the props:

```ts
import { listChangeEvents, listImportRepos, type ChangeEventFilters } from "./actions";
import { isNotionConnected } from "./import-actions";
```

```ts
  const [rows, openAtomicUpdates, importRepos, notionConnected] = await Promise.all([
    listChangeEvents(filters),
    openAtomicUpdatesForReassign(session.user.tenantId),
    listImportRepos(),
    isNotionConnected(),
  ]);
```

```tsx
        <ImportDialog repos={importRepos} enableTasks notionConnected={notionConnected} />
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all PASS (no test count change; existing suite green).

Manual: `npm run dev`, open `/change-events`, click **Import**, switch the type dropdown to **Tasks**. With an active Notion connection you should see the connected database's Done tasks (already-imported ones checked+locked with an "Imported" badge, no repo tabs, After/Before still present); selecting some and clicking **Import N tasks** creates change events. With no connection, the list shows "Connect Notion to import tasks."

- [ ] **Step 9: Commit**

```bash
git add "src/app/(dashboard)/change-events/import-dialog.tsx" "src/app/(dashboard)/change-events/page.tsx"
git commit -m "feat: import Notion tasks from the change-events Import modal"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
| --- | --- |
| Candidate set = Done tasks not yet imported | Task 1 (`listDoneTasks` filter) + Task 2 (`imported` flag) |
| Reuse `ingestNotionTask` per selected task | Task 2 (`importTasks`) |
| Data-source query (`2025-09-03`), resolve `data_source_id` from `databaseId` | Task 1 (`resolveDataSourceId` + `listDoneTasks`) |
| `last_edited_time` as `completedAt` / sort / filter key | Task 1 (sort + mapping) + Task 2 (since/until filter, `completedAt`) |
| Gating on active connection + db/status/doneValues | Task 2 (`listImportableTasks`/`importTasks` guards, `isNotionConnected`) |
| Import flow only; reuses stay commit+PR | Task 4 (`enableTasks` prop; only the `/change-events` usage passes it) |
| Per-task failure skipped, batch continues | Task 2 (`importTasks` try/catch) |
| No-connection → empty list + connect hint | Task 2 (empty list) + Task 4 (`emptyLabel` hint) |
| Filters differ by type (no repo tabs for tasks; keep search + After/Before) | Task 4 (`filtersSlot` null for task) |
| Drop "Notion tasks are next" copy | Task 4 (description) |
| Idempotent re-import | Task 2 (via `ingestNotionTask`'s unique constraint) |
| Accepted gap: single page ≤100 | Task 1 (`page_size: 100`, no pagination) |

**Placeholder scan:** none — every code step contains full source; every test step contains full test code; every run step names the command and expected result.

**Type consistency:** `NotionTaskSummary` (Task 1) is consumed by `listImportableTasks` (Task 2), which maps it to `ImportableTask` (Task 2) → `taskRows` (Task 4). `TaskSelection` is identical in Task 2 (produced) and Task 4 (consumed): `{ pageId, title, url, completedAt: string | null }`. `ingestNotionTask` input in Task 2 matches its real `NotionTaskInput` (`{ tenantId, pageId, title, description: string|null, url, completedAt: Date }`). `PickerType` gains `"task"` in Task 3 and is used in Task 4. `resolveDataSourceId`/`listDoneTasks`/`getPageBodyText` signatures match between Task 1 and Task 2.

**One implementation note for the engineer:** in Task 2, confirm `import-actions.ts` already imports `ne` from `drizzle-orm` (it does, for the commit path) — do not add a duplicate import. Likewise `and`, `eq`, `inArray`, `db`, `changeEvents`, `requireSession`, `revalidatePath` are already imported.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-import-notion-tasks.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints.

Which approach?
