# Notion Task Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Notion as a third ingestion source (`type: "task"`, `provider: "notion"`) so that completing a task in a tenant's Notion database produces a `change_events` row that flows through the existing three-tier pipeline into an atomic update.

**Architecture:** A Notion **public OAuth integration** stores per-tenant encrypted tokens in a new `notion_connections` table (shaped like `webflow_connections`). A webhook route receives `page.properties_updated` events, routes them to a tenant by `workspace_id`, cheaply rejects non–status-property edits, reads the page to confirm the status is "done", and hands a task off to `ingestNotionTask` — which runs the already-existing tier-1 `filterTask`, the tier-2 enricher (extended here to understand tasks), upserts idempotently, and calls the shared `resolvePendingEvents` (tier 3, unchanged). Everything from `change_events` onward already exists.

**Tech Stack:** Next.js 16 App Router (Route Handlers + `after()`), Drizzle ORM + Postgres, Node built-in `crypto`, Vitest 4 against a real `_test` Postgres database, AI SDK (`ai` + `@ai-sdk/anthropic`) for enrichment.

**Spec:** `docs/superpowers/specs/2026-07-21-notion-task-source-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Already scaffolded — do NOT re-add.** The `change_event_type` enum already includes `"task"`; `change_event_provider` already includes `"notion"`; `filter_reason` already includes `"empty_task"`; `filterTask({ title, description })` (tier 1) already exists in `src/lib/change-events/filter.ts`; `ResolverEvent.type` (tier 3) already includes `"task"` and the resolver prompt already mentions tasks. Verify by reading before writing; never duplicate these.
- **Webhook responses are always fast 200s except on a signature mismatch (401).** All API round-trips (page fetch, enrichment, resolve) run inside Next's `after()`. A non-200 only wastes Notion's retry budget on something a retry won't fix.
- **Notion delivery is at-most-once and may arrive out of order.** Use payload timestamps, never arrival order. A dropped event is unrecoverable — this is an accepted gap; do not add polling/backfill (out of scope).
- **Idempotency is the `(tenantId, provider, externalId)` unique index.** `externalId` for a task is the Notion page id. Insert with `.onConflictDoNothing().returning({ id: changeEvents.id })`; only call `resolvePendingEvents` when a row id came back (an empty return means a duplicate delivery already resolved on the first arrival). Do not re-run the resolver on an already-assigned event.
- **Never store a token in plaintext.** Encrypt with `encryptSecret`/`decryptSecret` from `src/lib/credentials/encryption.ts` (AES-256-GCM, columns `<name>Ciphertext` / `<name>Iv` / `<name>AuthTag`). Requires `CREDENTIALS_ENCRYPTION_KEY` (already used by Webflow).
- **Tenant isolation.** Every query filters on `tenantId` explicitly; every new table's `tenantId` is `.references(() => tenants.id, { onDelete: "cascade" })`. The per-tenant advisory lock is owned entirely by `resolvePendingEvents` (`withTenantLock`); the Notion side adds no locking.
- **Connection gating mirrors Webflow.** A connection is `misconfigured` until the completion mapping is saved and `active` only then; ingestion ignores any non-`active` connection. A `401` from Notion triggers **one** refresh-and-retry, then flips the connection to `needs_reauth`.
- **`Notion-Version` header is `"2022-06-28"`** on every Notion REST call (the stable, fully-documented version; avoids the newer data-source object model).
- **Env vars** (read directly via `process.env` at point of use, throwing a clear error if missing — there is no central env module): `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_OAUTH_REDIRECT_URI`, `NOTION_WEBHOOK_VERIFICATION_TOKEN`. Add each to `.env.example`.
- **Verification commands:** `npm test` (Vitest, non-watch), `npm run typecheck`, `npm run lint`. Single file: `npx vitest run <path>`.
- **Migrations:** edit `src/db/schema.ts`, then `npm run db:generate`, then `npm run db:migrate` AND `npm run db:migrate:test` (the suite runs against the `_test` DB).
- **Tests** live under `tests/` mirroring `src/`, named `*.test.ts`, `environment: "node"`. Import source via relative paths. Stub HTTP with `vi.stubGlobal("fetch", vi.fn())` + `vi.unstubAllGlobals()`; use the real `node:crypto` for signature tests; `vi.mock(...)` internal modules. DB tests seed a uniquely-named tenant and delete it in `afterEach` (cascades clean up).

---

## Task 0 (GATE, not code): Confirm webhook fan-in before building the route

The spec flags an unresolved blocker: whether **one** subscription on the public integration fans in events from every installing workspace (routed by `workspace_id`), or whether **each** workspace needs its own subscription created manually in Notion's developer UI. Fan-in makes self-serve onboarding viable; per-workspace makes this design unviable as written (the fallback is on-demand reconciliation with no webhooks).

- [ ] **Step 1:** In Notion's developer UI (`app.notion.com/developers`), create the integration as a **public** integration and create one webhook subscription for `page.properties_updated`. Capture the one-time `verification_token` from the handshake (Task 10 logs it; or read it from the subscription setup UI).
- [ ] **Step 2:** Install the integration into a **second** Notion workspace (a throwaway is fine), share a database with it, and complete a task there.
- [ ] **Step 3:** Confirm the single subscription receives that second workspace's event (carrying its `workspace_id`). If it does → fan-in holds, proceed with this plan unchanged. If it does **not** → STOP and escalate: the webhook design is unviable and the team must decide between per-workspace manual setup or the reconciliation fallback. Do not build Tasks 10–12 until this is confirmed.
- [ ] **Step 4:** Also confirm the exact `X-Notion-Signature` header format against a real delivery (raw-body HMAC-SHA256 keyed by the verification token). Note whether the header value is bare hex or `sha256=<hex>` — Task 6 assumes `sha256=<hex>` and must be adjusted here if reality differs.

This gate produces no commit. Record the outcome in the PR description.

---

## Task 1: Schema — `notion_connections`, task columns, nullable `repoId`, migration

**Files:**
- Modify: `src/db/schema.ts` (add enums + table near the Webflow block ~line 314; add task columns to `change_events` ~line 105; relax `repoId` ~line 85)
- Create: `tests/db/notion-connections.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `notionConnections` table and `type NotionConnection = typeof notionConnections.$inferSelect`. New `change_events` columns `taskTitle: text`, `taskDescription: text` (both nullable). `change_events.repoId` becomes nullable.

- [ ] **Step 1: Add the status enum and table to `src/db/schema.ts`**

Place the enum next to the other enums (after `changeEventProviderEnum`, ~line 53) and the table next to `webflowConnections` (~line 350):

```ts
export const notionConnectionStatusEnum = pgEnum("notion_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);

export const notionConnections = pgTable("notion_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // OAuth access token (encrypted). Notion access tokens can expire when the
  // integration has token rotation enabled; a refresh token is then issued.
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenAuthTag: text("access_token_auth_tag").notNull(),
  // Refresh token (encrypted). Nullable: an integration without token rotation
  // issues no refresh token, and a 401 on such a connection can only flip it to
  // needs_reauth (there is nothing to refresh with).
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenIv: text("refresh_token_iv"),
  refreshTokenAuthTag: text("refresh_token_auth_tag"),
  // The routing key for inbound webhooks (payload.workspace_id). Indexed.
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id"),
  // Null until the tenant completes the corresponding wizard step.
  databaseId: text("database_id"),
  databaseName: text("database_name"),
  statusPropertyId: text("status_property_id"),
  statusPropertyName: text("status_property_name"),
  // Which values of the status property mean "done". Empty until step 3.
  doneValues: text("done_values").array().notNull().default([]),
  status: notionConnectionStatusEnum("status").notNull().default("misconfigured"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("notion_connections_workspace_idx").on(table.workspaceId),
]);

export type NotionConnection = typeof notionConnections.$inferSelect;
```

Ensure `index` is imported from `drizzle-orm/pg-core` at the top of the file (it already imports `uniqueIndex`, `pgTable`, `pgEnum`, `text`, `uuid`, `timestamp`, etc.; add `index` to that import list if absent).

- [ ] **Step 2: Add task columns and relax `repoId` on `change_events`**

In the `change_events` table definition, change `repoId` to nullable (drop `.notNull()`):

```ts
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
```

And add task-sourced columns after the commit-sourced block (after `releasedAt`, ~line 117), mirroring the existing "// pr-sourced fields" / "// commit-sourced fields" grouping:

```ts
    // task-sourced fields (e.g. a completed Notion task)
    taskTitle: text("task_title"),
    taskDescription: text("task_description"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
```

Leave the three unique indexes as-is: the two `repoId`-based ones sidestep null `repoId` rows (Postgres treats NULLs as distinct), and `change_events_tenant_provider_external_unique` is the idempotency key for Notion.

- [ ] **Step 3: Generate and apply the migration**

Run: `npm run db:generate`
Expected: a new `src/db/migrations/00NN_<slug>.sql` that `CREATE TYPE "notion_connection_status"`, `CREATE TABLE "notion_connections"` with the FK + unique(tenant_id) + workspace index, `ALTER TABLE "change_events" ADD COLUMN "task_title"/"task_description"/"completed_at"`, and `ALTER TABLE "change_events" ALTER COLUMN "repo_id" DROP NOT NULL`. Open the file and confirm all four changes are present.

Run: `npm run db:migrate` then `npm run db:migrate:test`
Expected: both apply cleanly.

- [ ] **Step 4: Write a round-trip test proving the shape**

```ts
// tests/db/notion-connections.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, notionConnections, changeEvents } from "../../src/db/schema";

const TENANT = "Notion Connections Schema Test Tenant";

async function seedTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return tenant.id;
}

describe("notion_connections schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a connection with encrypted-token columns and done values", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(notionConnections)
      .values({
        tenantId,
        accessTokenCiphertext: "aa",
        accessTokenIv: "bb",
        accessTokenAuthTag: "cc",
        workspaceId: "ws-1",
        databaseId: "db-1",
        databaseName: "Tasks",
        statusPropertyId: "prop-1",
        statusPropertyName: "Status",
        doneValues: ["Done", "Shipped"],
        status: "active",
      })
      .returning();
    expect(row.status).toBe("active");
    expect(row.doneValues).toEqual(["Done", "Shipped"]);
    expect(row.refreshTokenCiphertext).toBeNull();
  });

  it("allows a change_event with a null repoId (Notion task)", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(changeEvents)
      .values({
        tenantId,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-123",
        taskTitle: "Add dark mode",
        taskDescription: "Users can toggle a dark theme.",
      })
      .returning({ id: changeEvents.id, repoId: changeEvents.repoId });
    expect(row.repoId).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/db/notion-connections.test.ts`
Expected: PASS, 2 tests. (If it fails on a missing test-DB column, re-run `npm run db:migrate:test`.)

- [ ] **Step 6: Document env vars in `.env.example`**

Append:

```
# Notion public OAuth integration (developers.notion.com)
NOTION_CLIENT_ID=
NOTION_CLIENT_SECRET=
# The absolute callback URL registered on the integration, e.g.
# https://app.example.com/api/notion/callback
NOTION_OAUTH_REDIRECT_URI=
# The one-time verification_token from the webhook subscription handshake;
# used as the HMAC key to verify X-Notion-Signature.
NOTION_WEBHOOK_VERIFICATION_TOKEN=
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/db/schema.ts src/db/migrations tests/db/notion-connections.test.ts .env.example
git commit -m "feat: add notion_connections table and task columns to change_events"
```

---

## Task 2: Pipeline reads a task's title (tier 3 wiring)

The resolver needs a `title` for a task event. `resolvePendingEvents` currently derives `title` from `prTitle ?? commitMessage`; a task has neither. Extend its select and mapping to fall back to `taskTitle`.

**Files:**
- Modify: `src/lib/change-events/pipeline.ts:41-68`
- Create: `tests/lib/change-events/pipeline-task-title.test.ts`

**Interfaces:**
- Consumes: `changeEvents.taskTitle` (Task 1). Produces: no signature change — `resolvePendingEvents` still `(tenantId, eventIds, deps)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/change-events/pipeline-task-title.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, changeEvents } from "../../../src/db/schema";
import { resolvePendingEvents } from "../../../src/lib/change-events/pipeline";

const TENANT = "Pipeline Task Title Test Tenant";

describe("resolvePendingEvents (task title)", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("passes a task's taskTitle to the resolver as the event title", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    const [event] = await db
      .insert(changeEvents)
      .values({
        tenantId: tenant.id,
        repoId: null,
        type: "task",
        provider: "notion",
        externalId: "page-abc",
        taskTitle: "Add CSV export",
        taskDescription: "Export a report as CSV.",
        impactSummary: "Users can export reports to CSV.",
        userFacing: true,
      })
      .returning({ id: changeEvents.id });

    const resolve = vi.fn(async () => []); // no actions -> nothing applied
    const refresh = vi.fn(async () => {});

    await resolvePendingEvents(tenant.id, [event.id], { resolve, refresh });

    expect(resolve).toHaveBeenCalledTimes(1);
    const passed = resolve.mock.calls[0][0].events;
    expect(passed).toHaveLength(1);
    expect(passed[0].title).toBe("Add CSV export");
    expect(passed[0].type).toBe("task");
    expect(passed[0].summary).toBe("Users can export reports to CSV.");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/change-events/pipeline-task-title.test.ts`
Expected: FAIL — `passed[0].title` is `""` (falls back to `prTitle ?? commitMessage ?? ""`).

- [ ] **Step 3: Add `taskTitle` to the select and the fallback**

In `src/lib/change-events/pipeline.ts`, add to the `.select({...})` object (after `commitMessage`):

```ts
      taskTitle: changeEvents.taskTitle,
```

And change the title fallback in the `.map(...)`:

```ts
    title: r.prTitle ?? r.commitMessage ?? r.taskTitle ?? "",
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/change-events/pipeline-task-title.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-events/pipeline.ts tests/lib/change-events/pipeline-task-title.test.ts
git commit -m "feat: resolve tasks by taskTitle in the ingestion pipeline"
```

---

## Task 3: Teach the tier-2 enricher about tasks

`EnrichmentInput.type` is `"pull_request" | "commit"`; `buildEnrichmentPrompt` branches on those two. Add a `"task"` case so a Notion task gets classified for `userFacing`.

**Files:**
- Modify: `src/lib/ai/enrich-change-item.ts:13-52`
- Create: `tests/lib/ai/enrich-change-item-task.test.ts`

**Interfaces:**
- Produces: `EnrichmentInput` gains `type: "pull_request" | "commit" | "task"` and optional `taskTitle`/`taskDescription`. `buildEnrichmentPrompt` handles `"task"`. `EnrichmentResult` and `enrichChangeItem` signatures unchanged.

- [ ] **Step 1: Write the failing test (prompt builder only — no live model call)**

```ts
// tests/lib/ai/enrich-change-item-task.test.ts
import { describe, it, expect } from "vitest";
import { buildEnrichmentPrompt } from "../../../src/lib/ai/enrich-change-item";

describe("buildEnrichmentPrompt (task)", () => {
  it("includes the task title and description", () => {
    const prompt = buildEnrichmentPrompt({
      tenantId: "t1",
      type: "task",
      repoName: "",
      taskTitle: "Add dark mode",
      taskDescription: "Users can toggle a dark theme in settings.",
    });
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Users can toggle a dark theme in settings.");
    expect(prompt).toContain("Task");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/ai/enrich-change-item-task.test.ts`
Expected: FAIL — a `"task"` type is not assignable to `EnrichmentInput.type`, and the prompt lacks the task text.

- [ ] **Step 3: Extend the type and prompt builder**

In `src/lib/ai/enrich-change-item.ts`, change the `type` union and add task fields:

```ts
export type EnrichmentInput = {
  tenantId: string;
  type: "pull_request" | "commit" | "task";
  repoName: string;
  commitMessage?: string | null;
  diff?: string | null;
  prTitle?: string | null;
  prDescription?: string | null;
  taskTitle?: string | null;
  taskDescription?: string | null;
};
```

And extend `buildEnrichmentPrompt`:

```ts
export function buildEnrichmentPrompt(input: EnrichmentInput): string {
  let source: string;
  if (input.type === "pull_request") {
    source = `Pull request in ${input.repoName}:\nTitle: ${input.prTitle ?? ""}\nDescription: ${input.prDescription ?? ""}`;
  } else if (input.type === "task") {
    source = `Task:\nTitle: ${input.taskTitle ?? ""}\nDescription: ${input.taskDescription ?? ""}`;
  } else {
    source = `Commit in ${input.repoName}:\nMessage: ${input.commitMessage ?? ""}\nDiff:\n${input.diff ?? "(no diff available)"}`;
  }

  return `Classify the following code change.\n\n${source}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/ai/enrich-change-item-task.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/enrich-change-item.ts tests/lib/ai/enrich-change-item-task.test.ts
git commit -m "feat: classify Notion tasks in the tier-2 enricher"
```

---

## Task 4: Notion OAuth token exchange and refresh

**Files:**
- Create: `src/lib/integrations/notion/oauth.ts`
- Create: `tests/lib/integrations/notion/oauth.test.ts`

**Interfaces:**
- Produces:
  - `type NotionTokenResponse = { accessToken: string; refreshToken: string | null; workspaceId: string; botId: string | null }`
  - `buildAuthorizeUrl(state: string): string`
  - `exchangeCode(code: string): Promise<NotionTokenResponse>`
  - `refreshAccessToken(refreshToken: string): Promise<NotionTokenResponse>`
  - Throws `NotionOAuthError` (with `status: number`) on a non-OK token response.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/notion/oauth.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  NotionOAuthError,
} from "../../../../src/lib/integrations/notion/oauth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notion oauth", () => {
  beforeEach(() => {
    process.env.NOTION_CLIENT_ID = "cid";
    process.env.NOTION_CLIENT_SECRET = "csecret";
    process.env.NOTION_OAUTH_REDIRECT_URI = "https://app.example.com/api/notion/callback";
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds an authorize URL with client id, redirect, response_type and state", () => {
    const url = new URL(buildAuthorizeUrl("tenant-1|integrations"));
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/notion/callback");
    expect(url.searchParams.get("state")).toBe("tenant-1|integrations");
  });

  it("exchanges a code with HTTP Basic auth and maps the response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        workspace_id: "ws",
        bot_id: "bot",
      })
    );
    const result = await exchangeCode("the-code");
    expect(result).toEqual({ accessToken: "at", refreshToken: "rt", workspaceId: "ws", botId: "bot" });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/oauth/token");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app.example.com/api/notion/callback",
    });
  });

  it("maps a missing refresh_token to null", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at", workspace_id: "ws", bot_id: "bot" })
    );
    const result = await exchangeCode("c");
    expect(result.refreshToken).toBeNull();
  });

  it("refreshes with grant_type refresh_token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at2", refresh_token: "rt2", workspace_id: "ws", bot_id: "bot" })
    );
    const result = await refreshAccessToken("old-rt");
    expect(result.accessToken).toBe("at2");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-rt",
    });
  });

  it("throws NotionOAuthError with the status on a non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(exchangeCode("bad")).rejects.toMatchObject({ status: 400 });
    await expect(exchangeCode("bad")).rejects.toBeInstanceOf(NotionOAuthError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/integrations/notion/oauth.test.ts`
Expected: FAIL — cannot resolve `src/lib/integrations/notion/oauth`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/integrations/notion/oauth.ts
const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 10_000;

export type NotionTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  workspaceId: string;
  botId: string | null;
};

export class NotionOAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionOAuthError";
    this.status = status;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", required("NOTION_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", required("NOTION_OAUTH_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<NotionTokenResponse> {
  const basic = Buffer.from(`${required("NOTION_CLIENT_ID")}:${required("NOTION_CLIENT_SECRET")}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new NotionOAuthError(
      response.status,
      detail.error_description ?? detail.error ?? `Notion token endpoint returned HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string | null;
    workspace_id: string;
    bot_id?: string | null;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    workspaceId: data.workspace_id,
    botId: data.bot_id ?? null,
  };
}

export function exchangeCode(code: string): Promise<NotionTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: required("NOTION_OAUTH_REDIRECT_URI"),
  });
}

export function refreshAccessToken(refreshToken: string): Promise<NotionTokenResponse> {
  return postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/integrations/notion/oauth.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/notion/oauth.ts tests/lib/integrations/notion/oauth.test.ts
git commit -m "feat: add Notion OAuth token exchange and refresh"
```

---

## Task 5: Notion REST client (search databases, database schema, page)

**Files:**
- Create: `src/lib/integrations/notion/client.ts`
- Create: `tests/lib/integrations/notion/client.test.ts`

**Interfaces:**
- Produces (mirrors the Webflow client shape):
  - `class NotionApiError extends Error { status: number }`
  - `type NotionDatabase = { id: string; title: string }`
  - `type NotionPropertyOption = { id: string; name: string }`
  - `type NotionProperty = { id: string; name: string; type: string; options: NotionPropertyOption[] }` (options empty unless `status`/`select`)
  - `type NotionPageStatus = { title: string; description: string; url: string; statusValueByPropertyId: (propertyId: string) => string | null }`
  - `listDatabases(token: string): Promise<NotionDatabase[]>` — `POST /v1/search` filtered to databases
  - `getDatabaseProperties(token: string, databaseId: string): Promise<NotionProperty[]>` — `GET /v1/databases/{id}`, returns only `status`/`select` properties
  - `getPage(token: string, pageId: string): Promise<NotionPageContent>` where `NotionPageContent = { url: string; title: string; description: string; statusByPropertyId: Record<string, string> }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/notion/client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listDatabases,
  getDatabaseProperties,
  getPage,
  NotionApiError,
} from "../../../../src/lib/integrations/notion/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("notion client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("lists databases via search with a bearer token and version header", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ results: [{ id: "db1", title: [{ plain_text: "Tasks" }] }] })
    );
    const dbs = await listDatabases("tok");
    expect(dbs).toEqual([{ id: "db1", title: "Tasks" }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/search");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(init?.body as string)).toMatchObject({ filter: { value: "database", property: "object" } });
  });

  it("returns only status/select properties from a database schema", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        properties: {
          Status: { id: "s1", type: "status", status: { options: [{ id: "o1", name: "Done" }] } },
          Priority: { id: "p1", type: "select", select: { options: [{ id: "o2", name: "High" }] } },
          Name: { id: "t1", type: "title", title: {} },
        },
      })
    );
    const props = await getDatabaseProperties("tok", "db1");
    expect(props).toEqual([
      { id: "s1", name: "Status", type: "status", options: [{ id: "o1", name: "Done" }] },
      { id: "p1", name: "Priority", type: "select", options: [{ id: "o2", name: "High" }] },
    ]);
  });

  it("reads a page's title, description text and status keyed by property id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        url: "https://notion.so/page-123",
        properties: {
          Name: { id: "t1", type: "title", title: [{ plain_text: "Add dark mode" }] },
          Notes: { id: "n1", type: "rich_text", rich_text: [{ plain_text: "Toggle in settings." }] },
          Status: { id: "s1", type: "status", status: { name: "Done" } },
        },
      })
    );
    const page = await getPage("tok", "page-123");
    expect(page.url).toBe("https://notion.so/page-123");
    expect(page.title).toBe("Add dark mode");
    expect(page.description).toContain("Toggle in settings.");
    expect(page.statusByPropertyId["s1"]).toBe("Done");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.notion.com/v1/pages/page-123");
  });

  it("throws NotionApiError carrying the status on a non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    await expect(getPage("tok", "p")).rejects.toMatchObject({ status: 401 });
    await expect(getPage("tok", "p")).rejects.toBeInstanceOf(NotionApiError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/integrations/notion/client.test.ts`
Expected: FAIL — cannot resolve `src/lib/integrations/notion/client`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/integrations/notion/client.ts
const BASE_URL = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 10_000;

export type NotionDatabase = { id: string; title: string };
export type NotionPropertyOption = { id: string; name: string };
export type NotionProperty = { id: string; name: string; type: string; options: NotionPropertyOption[] };
export type NotionPageContent = {
  url: string;
  title: string;
  description: string;
  statusByPropertyId: Record<string, string>;
};

export class NotionApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "Notion-Version": NOTION_VERSION,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // Plain Error, NOT NotionApiError: a timeout is not a 401 and must not be
      // misrouted into needs_reauth handling.
      throw new Error(`Notion ${init.method ?? "GET"} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new NotionApiError(response.status, body.message ?? `Notion returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function plainText(rich: { plain_text?: string }[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? "").join("");
}

export async function listDatabases(token: string): Promise<NotionDatabase[]> {
  const data = await request<{ results: { id: string; title?: { plain_text?: string }[] }[] }>(
    token,
    "/v1/search",
    { method: "POST", body: JSON.stringify({ filter: { value: "database", property: "object" }, page_size: 100 }) }
  );
  return data.results.map((r) => ({ id: r.id, title: plainText(r.title) || "Untitled" }));
}

type RawProperty = {
  id: string;
  type: string;
  status?: { options?: NotionPropertyOption[]; name?: string };
  select?: { options?: NotionPropertyOption[]; name?: string };
  title?: { plain_text?: string }[];
  rich_text?: { plain_text?: string }[];
};

export async function getDatabaseProperties(token: string, databaseId: string): Promise<NotionProperty[]> {
  const data = await request<{ properties: Record<string, RawProperty> }>(token, `/v1/databases/${databaseId}`);
  const out: NotionProperty[] = [];
  for (const [name, prop] of Object.entries(data.properties)) {
    if (prop.type === "status" || prop.type === "select") {
      const options = (prop.type === "status" ? prop.status?.options : prop.select?.options) ?? [];
      out.push({ id: prop.id, name, type: prop.type, options });
    }
  }
  return out;
}

export async function getPage(token: string, pageId: string): Promise<NotionPageContent> {
  const data = await request<{ url: string; properties: Record<string, RawProperty> }>(token, `/v1/pages/${pageId}`);
  let title = "";
  const descriptionParts: string[] = [];
  const statusByPropertyId: Record<string, string> = {};

  for (const prop of Object.values(data.properties)) {
    if (prop.type === "title") {
      title = plainText(prop.title);
    } else if (prop.type === "rich_text") {
      // "Ingesting page content" is out of scope; the description is assembled
      // from the task's own text properties only (an underspecified point in
      // the spec — resolved here as: rich_text property values, joined).
      const text = plainText(prop.rich_text);
      if (text) descriptionParts.push(text);
    } else if (prop.type === "status" && prop.status?.name) {
      statusByPropertyId[prop.id] = prop.status.name;
    } else if (prop.type === "select" && prop.select?.name) {
      statusByPropertyId[prop.id] = prop.select.name;
    }
  }

  return { url: data.url, title, description: descriptionParts.join("\n"), statusByPropertyId };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/integrations/notion/client.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/notion/client.ts tests/lib/integrations/notion/client.test.ts
git commit -m "feat: add Notion REST client (databases, schema, page)"
```

---

## Task 6: Webhook signature verification and handshake detection

**Files:**
- Create: `src/lib/integrations/notion/notion-webhook.ts`
- Create: `tests/lib/integrations/notion/notion-webhook.test.ts`

**Interfaces:**
- Produces:
  - `verifyNotionSignature(rawBody: string, signatureHeader: string | null): boolean` — HMAC-SHA256 of `rawBody` keyed by `NOTION_WEBHOOK_VERIFICATION_TOKEN`, constant-time compared to the header value `sha256=<hex>`. Throws if the env var is missing.
  - `parseVerificationHandshake(rawBody: string): string | null` — returns the `verification_token` if the body is a handshake payload, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/notion/notion-webhook.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { verifyNotionSignature, parseVerificationHandshake } from "../../../../src/lib/integrations/notion/notion-webhook";

const TOKEN = "verif-token-abc";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", TOKEN).update(body).digest("hex");
}

describe("notion webhook signature", () => {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = TOKEN;
  });
  afterAll(() => {
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = original;
  });

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ type: "page.properties_updated" });
    expect(verifyNotionSignature(body + "x", sign(body))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyNotionSignature("{}", null)).toBe(false);
  });

  it("detects a verification handshake payload", () => {
    expect(parseVerificationHandshake(JSON.stringify({ verification_token: "vt-123" }))).toBe("vt-123");
  });

  it("returns null for a normal event payload", () => {
    expect(parseVerificationHandshake(JSON.stringify({ type: "page.properties_updated" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/integrations/notion/notion-webhook.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/integrations/notion/notion-webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";

// NOTE: Task 0 must confirm the real X-Notion-Signature format against a live
// delivery. This implements the documented scheme: HMAC-SHA256 of the raw body
// keyed by the verification token, header value "sha256=<hex>". If Task 0 finds
// the header is bare hex (no "sha256=" prefix), drop the prefix handling below.
export function verifyNotionSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const token = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  if (!token) throw new Error("NOTION_WEBHOOK_VERIFICATION_TOKEN is not set");

  const expected = "sha256=" + createHmac("sha256", token).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal lengths
  return timingSafeEqual(a, b);
}

export function parseVerificationHandshake(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { verification_token?: unknown };
    return typeof parsed.verification_token === "string" ? parsed.verification_token : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/integrations/notion/notion-webhook.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/notion/notion-webhook.ts tests/lib/integrations/notion/notion-webhook.test.ts
git commit -m "feat: add Notion webhook signature verification and handshake parsing"
```

---

## Task 7: Access-token accessor with refresh-on-401 and `needs_reauth`

A single helper used by both the connect-flow actions and the webhook ingest: run a function with the connection's decrypted access token; on a `401`/`403` `NotionApiError`, refresh once (if a refresh token exists), persist the new tokens, and retry; on a second failure or when no refresh token exists, flip the connection to `needs_reauth` and rethrow.

**Files:**
- Create: `src/lib/integrations/notion/connection.ts`
- Create: `tests/lib/integrations/notion/connection.test.ts`

**Interfaces:**
- Consumes: `NotionConnection` (Task 1), `refreshAccessToken` (Task 4), `NotionApiError` (Task 5), `encryptSecret`/`decryptSecret`.
- Produces:
  - `withFreshToken<T>(database: DbClient, connection: NotionConnection, fn: (token: string) => Promise<T>): Promise<T>`
  - `type DbClient = NodePgDatabase<typeof schema>` (same rationale as Webflow's `DbClient`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/notion/connection.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../../src/db";
import { tenants, notionConnections } from "../../../../src/db/schema";
import { encryptSecret } from "../../../../src/lib/credentials/encryption";
import { NotionApiError } from "../../../../src/lib/integrations/notion/client";
import { withFreshToken } from "../../../../src/lib/integrations/notion/connection";

const TENANT = "Notion Connection Refresh Test Tenant";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../src/lib/integrations/notion/oauth", () => ({
  refreshAccessToken: vi.fn(),
}));
import { refreshAccessToken } from "../../../../src/lib/integrations/notion/oauth";

async function seedConnection(overrides: Partial<typeof notionConnections.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  const at = encryptSecret("old-access");
  const rt = encryptSecret("the-refresh");
  const [conn] = await db
    .insert(notionConnections)
    .values({
      tenantId: tenant.id,
      accessTokenCiphertext: at.ciphertext,
      accessTokenIv: at.iv,
      accessTokenAuthTag: at.authTag,
      refreshTokenCiphertext: rt.ciphertext,
      refreshTokenIv: rt.iv,
      refreshTokenAuthTag: rt.authTag,
      workspaceId: "ws-1",
      status: "active",
      ...overrides,
    })
    .returning();
  return conn;
}

describe("withFreshToken", () => {
  afterEach(async () => {
    vi.mocked(refreshAccessToken).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("passes the current access token when the call succeeds", async () => {
    const conn = await seedConnection();
    const result = await withFreshToken(db, conn, async (token) => token);
    expect(result).toBe("old-access");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const conn = await seedConnection();
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      workspaceId: "ws-1",
      botId: null,
    });
    let calls = 0;
    const result = await withFreshToken(db, conn, async (token) => {
      calls += 1;
      if (calls === 1) throw new NotionApiError(401, "unauthorized");
      return token;
    });
    expect(result).toBe("new-access");
    expect(refreshAccessToken).toHaveBeenCalledWith("the-refresh");
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("active");
  });

  it("flips to needs_reauth and rethrows when the retry still 401s", async () => {
    const conn = await seedConnection();
    vi.mocked(refreshAccessToken).mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      workspaceId: "ws-1",
      botId: null,
    });
    await expect(
      withFreshToken(db, conn, async () => {
        throw new NotionApiError(401, "still unauthorized");
      })
    ).rejects.toBeInstanceOf(NotionApiError);
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("needs_reauth");
  });

  it("flips to needs_reauth immediately when there is no refresh token", async () => {
    const conn = await seedConnection({
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      refreshTokenAuthTag: null,
    });
    await expect(
      withFreshToken(db, conn, async () => {
        throw new NotionApiError(401, "unauthorized");
      })
    ).rejects.toBeInstanceOf(NotionApiError);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    const [row] = await db.select().from(notionConnections).where(eq(notionConnections.id, conn.id));
    expect(row.status).toBe("needs_reauth");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/integrations/notion/connection.test.ts`
Expected: FAIL — cannot resolve `src/lib/integrations/notion/connection`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/integrations/notion/connection.ts
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { encryptSecret, decryptSecret } from "@/lib/credentials/encryption";
import { refreshAccessToken } from "./oauth";
import { NotionApiError } from "./client";

export type DbClient = NodePgDatabase<typeof schema>;

function isAuthFailure(error: unknown): boolean {
  return error instanceof NotionApiError && (error.status === 401 || error.status === 403);
}

async function markNeedsReauth(database: DbClient, connectionId: string): Promise<void> {
  try {
    await database.update(notionConnections).set({ status: "needs_reauth" }).where(eq(notionConnections.id, connectionId));
  } catch (updateError) {
    console.error(`Failed to mark Notion connection ${connectionId} as needs_reauth:`, updateError);
  }
}

export async function withFreshToken<T>(
  database: DbClient,
  connection: NotionConnection,
  fn: (token: string) => Promise<T>
): Promise<T> {
  const accessToken = decryptSecret({
    ciphertext: connection.accessTokenCiphertext,
    iv: connection.accessTokenIv,
    authTag: connection.accessTokenAuthTag,
  });

  try {
    return await fn(accessToken);
  } catch (error) {
    if (!isAuthFailure(error)) throw error;

    const canRefresh =
      connection.refreshTokenCiphertext && connection.refreshTokenIv && connection.refreshTokenAuthTag;
    if (!canRefresh) {
      await markNeedsReauth(database, connection.id);
      throw error;
    }

    const refreshToken = decryptSecret({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      authTag: connection.refreshTokenAuthTag,
    });

    let refreshed;
    try {
      refreshed = await refreshAccessToken(refreshToken);
    } catch (refreshError) {
      await markNeedsReauth(database, connection.id);
      throw refreshError;
    }

    const newAccess = encryptSecret(refreshed.accessToken);
    const newRefresh = refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : null;
    await database
      .update(notionConnections)
      .set({
        accessTokenCiphertext: newAccess.ciphertext,
        accessTokenIv: newAccess.iv,
        accessTokenAuthTag: newAccess.authTag,
        ...(newRefresh
          ? {
              refreshTokenCiphertext: newRefresh.ciphertext,
              refreshTokenIv: newRefresh.iv,
              refreshTokenAuthTag: newRefresh.authTag,
            }
          : {}),
      })
      .where(eq(notionConnections.id, connection.id));

    try {
      return await fn(refreshed.accessToken);
    } catch (retryError) {
      if (isAuthFailure(retryError)) await markNeedsReauth(database, connection.id);
      throw retryError;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/integrations/notion/connection.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/notion/connection.ts tests/lib/integrations/notion/connection.test.ts
git commit -m "feat: refresh Notion tokens on 401 with needs_reauth fallback"
```

---

## Task 8: OAuth authorize + callback routes

**Files:**
- Create: `src/app/api/notion/connect/route.ts` (redirect to Notion's consent screen)
- Create: `src/app/api/notion/callback/route.ts` (exchange code, store encrypted tokens, status `misconfigured`)
- Create: `tests/app/api/notion/callback/route.test.ts`

**Interfaces:**
- Consumes: `buildAuthorizeUrl`, `exchangeCode` (Task 4), `encryptSecret`, `requireSession`, `notionConnections`.
- Produces: a connection row with `status: "misconfigured"`, tokens, `workspaceId`, `botId` set; `databaseId`/`statusPropertyId`/`doneValues` still empty.

- [ ] **Step 1: Write the `connect` route (no test — a thin redirect)**

```ts
// src/app/api/notion/connect/route.ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/notion/oauth";

export async function GET() {
  const session = await requireSession();
  // state carries the tenant id (verified in the callback against the session)
  // and where to return the user, mirroring the GitHub setup route's state.
  return NextResponse.redirect(buildAuthorizeUrl(`${session.user.tenantId}|integrations`));
}
```

- [ ] **Step 2: Write the failing callback test**

```ts
// tests/app/api/notion/callback/route.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../../../src/db";
import { tenants, notionConnections } from "../../../../../src/db/schema";
import { decryptSecret } from "../../../../../src/lib/credentials/encryption";

const TENANT = "Notion Callback Test Tenant";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("../../../../../src/lib/integrations/notion/oauth", () => ({
  exchangeCode: vi.fn(async () => ({
    accessToken: "at",
    refreshToken: "rt",
    workspaceId: "ws-xyz",
    botId: "bot-1",
  })),
}));

import { GET } from "../../../../../src/app/api/notion/callback/route";

function request(params: Record<string, string>) {
  const url = new URL("https://app.example.com/api/notion/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url);
}

describe("notion callback route", () => {
  beforeEach(async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    currentTenantId = tenant.id;
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores an encrypted, misconfigured connection and redirects to integrations", async () => {
    const res = await GET(request({ code: "the-code", state: `${currentTenantId}|integrations` }) as never);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/integrations");

    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.status).toBe("misconfigured");
    expect(conn.workspaceId).toBe("ws-xyz");
    expect(conn.botId).toBe("bot-1");
    expect(decryptSecret({ ciphertext: conn.accessTokenCiphertext, iv: conn.accessTokenIv, authTag: conn.accessTokenAuthTag })).toBe("at");
    expect(conn.accessTokenCiphertext).not.toContain("at");
  });

  it("redirects with an error when state's tenant does not match the session", async () => {
    const res = await GET(request({ code: "c", state: "someone-else|integrations" }) as never);
    expect(res.headers.get("location")).toContain("notion_connect=error");
    const rows = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/app/api/notion/callback/route.test.ts`
Expected: FAIL — cannot resolve the callback route module.

- [ ] **Step 4: Write the callback route**

```ts
// src/app/api/notion/callback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";
import { exchangeCode } from "@/lib/integrations/notion/oauth";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const [tenantIdFromState] = (state ?? "").split("|");

  if (!code || tenantIdFromState !== session.user.tenantId) {
    return NextResponse.redirect(new URL("/integrations?notion_connect=error", request.url));
  }

  try {
    const tokens = await exchangeCode(code);
    const access = encryptSecret(tokens.accessToken);
    const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;

    const values = {
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenIv: refresh?.iv ?? null,
      refreshTokenAuthTag: refresh?.authTag ?? null,
      workspaceId: tokens.workspaceId,
      botId: tokens.botId,
      // Re-authorizing must not silently keep a stale, half-finished mapping.
      // Reset to misconfigured; the tenant re-picks database + completion.
      status: "misconfigured" as const,
    };

    const [existing] = await db
      .select()
      .from(notionConnections)
      .where(eq(notionConnections.tenantId, session.user.tenantId))
      .limit(1);

    if (existing) {
      await db.update(notionConnections).set(values).where(eq(notionConnections.id, existing.id));
    } else {
      await db.insert(notionConnections).values({ tenantId: session.user.tenantId, ...values });
    }

    return NextResponse.redirect(new URL("/integrations?notion_connect=success", request.url));
  } catch (error) {
    console.error("Notion OAuth callback failed:", error);
    return NextResponse.redirect(new URL("/integrations?notion_connect=error", request.url));
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/app/api/notion/callback/route.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/notion/connect/route.ts src/app/api/notion/callback/route.ts tests/app/api/notion/callback/route.test.ts
git commit -m "feat: add Notion OAuth connect and callback routes"
```

---

## Task 9: Connect-flow server actions (select database, map completion, disconnect)

**Files:**
- Create: `src/app/(dashboard)/integrations/notion-actions.ts`
- Create: `tests/app/notion-actions.test.ts`

**Interfaces:**
- Consumes: `withFreshToken` (Task 7), `listDatabases`/`getDatabaseProperties` (Task 5), `requireSession`, `notionConnections`.
- Produces (all `"use server"`, mutating ones return `ActionResult`):
  - `type ActionResult = { ok: true } | { ok: false; error: string }`
  - `fetchNotionDatabases(): Promise<{ id: string; title: string }[]>`
  - `saveNotionDatabase(formData: FormData): Promise<ActionResult>` — sets `databaseId`/`databaseName`, clears `statusPropertyId`/`statusPropertyName`/`doneValues`, sets `status: "misconfigured"`.
  - `fetchNotionStatusProperties(): Promise<{ id: string; name: string; options: { id: string; name: string }[] }[]>`
  - `saveNotionCompletion(formData: FormData): Promise<ActionResult>` — sets `statusPropertyId`/`statusPropertyName`/`doneValues`, flips `status: "active"`.
  - `disconnectNotion(): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/notion-actions.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, notionConnections } from "../../src/db/schema";
import { encryptSecret } from "../../src/lib/credentials/encryption";

const TENANT = "Notion Actions Test Tenant";
let currentTenantId = "";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../../src/lib/integrations/notion/client", () => ({
  getDatabaseProperties: vi.fn(async () => [
    { id: "s1", name: "Status", type: "status", options: [{ id: "o1", name: "Done" }, { id: "o2", name: "In progress" }] },
  ]),
  listDatabases: vi.fn(async () => [{ id: "db1", title: "Tasks" }]),
}));

import { saveNotionDatabase, saveNotionCompletion, disconnectNotion } from "../../src/app/(dashboard)/integrations/notion-actions";

async function seed(status: "misconfigured" | "active" = "misconfigured", overrides = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: "ws-1",
    status,
    ...overrides,
  });
}

function formData(entries: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) v.forEach((item) => fd.append(k, item));
    else fd.set(k, v);
  }
  return fd;
}

describe("notion connect-flow actions", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("saves the selected database and clears any prior completion mapping", async () => {
    await seed("active", { databaseId: "old", statusPropertyId: "old-prop", doneValues: ["X"] });
    const result = await saveNotionDatabase(formData({ databaseId: "db1", databaseName: "Tasks" }));
    expect(result).toEqual({ ok: true });
    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.databaseId).toBe("db1");
    expect(conn.statusPropertyId).toBeNull();
    expect(conn.doneValues).toEqual([]);
    expect(conn.status).toBe("misconfigured");
  });

  it("saves the completion mapping and flips the connection to active", async () => {
    await seed("misconfigured", { databaseId: "db1", databaseName: "Tasks" });
    const result = await saveNotionCompletion(
      formData({ statusPropertyId: "s1", statusPropertyName: "Status", doneValues: ["Done"] })
    );
    expect(result).toEqual({ ok: true });
    const [conn] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(conn.statusPropertyId).toBe("s1");
    expect(conn.doneValues).toEqual(["Done"]);
    expect(conn.status).toBe("active");
  });

  it("rejects a completion save with no done values", async () => {
    await seed("misconfigured", { databaseId: "db1", databaseName: "Tasks" });
    const result = await saveNotionCompletion(formData({ statusPropertyId: "s1", statusPropertyName: "Status" }));
    expect(result.ok).toBe(false);
  });

  it("disconnect deletes the connection", async () => {
    await seed("active", { databaseId: "db1" });
    await disconnectNotion();
    const rows = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, currentTenantId));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/notion-actions.test.ts`
Expected: FAIL — cannot resolve `notion-actions`.

- [ ] **Step 3: Write the actions**

```ts
// src/app/(dashboard)/integrations/notion-actions.ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listDatabases, getDatabaseProperties } from "@/lib/integrations/notion/client";
import { withFreshToken } from "@/lib/integrations/notion/connection";

export type ActionResult = { ok: true } | { ok: false; error: string };

function requiredField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${name}" is required.`);
  }
  return value.trim();
}

function failure(error: unknown, fallback: string): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : fallback };
}

async function loadConnection(tenantId: string): Promise<NotionConnection> {
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.tenantId, tenantId))
    .limit(1);
  if (!connection) throw new Error("No Notion connection");
  return connection;
}

export async function fetchNotionDatabases(): Promise<{ id: string; title: string }[]> {
  const session = await requireSession();
  const connection = await loadConnection(session.user.tenantId);
  return withFreshToken(db, connection, (token) => listDatabases(token));
}

export async function saveNotionDatabase(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const databaseId = requiredField(formData, "databaseId");
    const databaseName = requiredField(formData, "databaseName");
    const connection = await loadConnection(session.user.tenantId);

    // Changing the database invalidates the completion mapping; reset it and
    // return to misconfigured until the tenant re-maps completion.
    await db
      .update(notionConnections)
      .set({
        databaseId,
        databaseName,
        statusPropertyId: null,
        statusPropertyName: null,
        doneValues: [],
        status: "misconfigured",
      })
      .where(eq(notionConnections.id, connection.id));

    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the selected database");
  }
}

export async function fetchNotionStatusProperties(): Promise<
  { id: string; name: string; options: { id: string; name: string }[] }[]
> {
  const session = await requireSession();
  const connection = await loadConnection(session.user.tenantId);
  if (!connection.databaseId) return [];
  return withFreshToken(db, connection, (token) => getDatabaseProperties(token, connection.databaseId!));
}

export async function saveNotionCompletion(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  try {
    const statusPropertyId = requiredField(formData, "statusPropertyId");
    const statusPropertyName = requiredField(formData, "statusPropertyName");
    const doneValues = formData.getAll("doneValues").filter((v): v is string => typeof v === "string" && v.trim() !== "");
    if (doneValues.length === 0) throw new Error("Pick at least one value that means the task is done.");

    const connection = await loadConnection(session.user.tenantId);
    if (!connection.databaseId) throw new Error("Select a database first.");

    await db
      .update(notionConnections)
      .set({ statusPropertyId, statusPropertyName, doneValues, status: "active" })
      .where(eq(notionConnections.id, connection.id));

    revalidatePath("/integrations");
    return { ok: true };
  } catch (error) {
    return failure(error, "Could not save the completion mapping");
  }
}

export async function disconnectNotion(): Promise<void> {
  const session = await requireSession();
  await db.delete(notionConnections).where(eq(notionConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/app/notion-actions.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/integrations/notion-actions.ts" tests/app/notion-actions.test.ts
git commit -m "feat: add Notion connect-flow server actions"
```

---

## Task 10: NotionForm wizard UI + wire into the integrations page

Mirror the Webflow wizard: an async Server Component that derives its step from which connection columns are populated, plus small client forms. No new automated tests (the actions are covered in Task 9; this is presentation). Verify by typecheck + lint and a manual render note.

**Files:**
- Create: `src/app/(dashboard)/integrations/notion-form.tsx`
- Create: `src/app/(dashboard)/integrations/notion-database-form.tsx`
- Create: `src/app/(dashboard)/integrations/notion-completion-form.tsx`
- Create: `src/app/(dashboard)/integrations/notion-disconnect-button.tsx`
- Modify: `src/app/(dashboard)/integrations/page.tsx`

**Interfaces:**
- Consumes: `notionConnections`, `fetchNotionStatusProperties`, `saveNotionDatabase`, `saveNotionCompletion`, `disconnectNotion` (Task 9), `NotionApiError`.
- Produces: `<NotionForm />` (async Server Component, default export not required — named export used by the page).

- [ ] **Step 1: Write the disconnect button (mirror `webflow-disconnect-button.tsx`)**

```tsx
// src/app/(dashboard)/integrations/notion-disconnect-button.tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { disconnectNotion } from "./notion-actions";
import { Button } from "@/components/ui/button";

export function NotionDisconnectButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      await disconnectNotion();
      toast.success("Notion disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect Notion");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button type="button" variant="destructive" onClick={handleDisconnect} disabled={submitting}>
      {submitting ? "Disconnecting…" : "Disconnect"}
    </Button>
  );
}
```

- [ ] **Step 2: Write the database picker (mirror `webflow-site-form.tsx`)**

```tsx
// src/app/(dashboard)/integrations/notion-database-form.tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveNotionDatabase } from "./notion-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function NotionDatabaseForm({
  databases,
  currentDatabaseId,
}: {
  databases: { id: string; title: string }[];
  currentDatabaseId?: string | null;
}) {
  const [databaseId, setDatabaseId] = useState(currentDatabaseId ?? databases[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);
  const selectedName = databases.find((d) => d.id === databaseId)?.title ?? "";

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    formData.set("databaseName", selectedName);
    const result = await saveNotionDatabase(formData);
    if (result.ok) toast.success("Notion database selected");
    else toast.error(result.error);
    setSubmitting(false);
  }

  if (databases.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No databases are shared with this integration yet. In Notion, share your tasks database with the app, then reload.
      </p>
    );
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Tasks database</Label>
        <Select name="databaseId" value={databaseId} onValueChange={(value) => setDatabaseId(value as string)}>
          <SelectTrigger>
            <SelectValue>{selectedName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {databases.map((db) => (
              <SelectItem key={db.id} value={db.id}>
                <span className="flex items-center gap-2">
                  {db.title}
                  {db.id === currentDatabaseId && (
                    <Badge variant="secondary" className="pointer-events-none">Current</Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Use this database"}
      </Button>
    </form>
  );
}
```

- [ ] **Step 3: Write the completion-mapping form**

The tenant picks a status/select property and checks which of its option values mean "done". The property `<Select>` posts `statusPropertyId`; the form looks up the name and re-renders the option checkboxes for the chosen property client-side.

```tsx
// src/app/(dashboard)/integrations/notion-completion-form.tsx
"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveNotionCompletion } from "./notion-actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Property = { id: string; name: string; options: { id: string; name: string }[] };

export function NotionCompletionForm({
  properties,
  currentStatusPropertyId,
  currentDoneValues,
}: {
  properties: Property[];
  currentStatusPropertyId?: string | null;
  currentDoneValues: string[];
}) {
  const [propertyId, setPropertyId] = useState(currentStatusPropertyId ?? properties[0]?.id ?? "");
  const [done, setDone] = useState<Set<string>>(new Set(currentDoneValues));
  const [submitting, setSubmitting] = useState(false);

  const property = properties.find((p) => p.id === propertyId);

  function toggle(value: string, checked: boolean) {
    setDone((prev) => {
      const next = new Set(prev);
      if (checked) next.add(value);
      else next.delete(value);
      return next;
    });
  }

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    formData.set("statusPropertyId", propertyId);
    formData.set("statusPropertyName", property?.name ?? "");
    for (const value of done) formData.append("doneValues", value);
    const result = await saveNotionCompletion(formData);
    if (result.ok) toast.success("Completion mapping saved");
    else toast.error(result.error);
    setSubmitting(false);
  }

  if (properties.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This database has no status or select property to signal completion.
      </p>
    );
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Completion property</Label>
        <Select
          value={propertyId}
          onValueChange={(value) => {
            setPropertyId(value as string);
            setDone(new Set()); // done values belong to a specific property
          }}
        >
          <SelectTrigger>
            <SelectValue>{property?.name ?? ""}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {properties.map((p) => (
              <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>Values that mean “done”</Label>
        <div className="space-y-1">
          {property?.options.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={done.has(option.name)}
                onCheckedChange={(checked) => toggle(option.name, checked === true)}
              />
              {option.name}
            </label>
          ))}
        </div>
      </div>
      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save completion mapping"}
      </Button>
    </form>
  );
}
```

If `@/components/ui/checkbox` does not exist, add it with the shadcn CLI (`npx shadcn@latest add checkbox`) before this step, or substitute native `<input type="checkbox">`. Verify the import resolves during typecheck.

- [ ] **Step 4: Write the wizard orchestrator (mirror `webflow-form.tsx`)**

```tsx
// src/app/(dashboard)/integrations/notion-form.tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { listDatabases, getDatabaseProperties, NotionApiError } from "@/lib/integrations/notion/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotionDatabaseForm } from "./notion-database-form";
import { NotionCompletionForm } from "./notion-completion-form";
import { NotionDisconnectButton } from "./notion-disconnect-button";

function describeError(error: unknown): string {
  if (error instanceof NotionApiError) {
    if (error.status === 401 || error.status === 403) {
      return `Notion rejected the stored token (${error.status}). Reconnect your Notion workspace below.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to Notion.";
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

export async function NotionForm() {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.tenantId, session.user.tenantId))
    .limit(1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Notion tasks</CardTitle>
        {connection && connection.status !== "active" && (
          <Badge variant={connection.status === "needs_reauth" ? "destructive" : "outline"}>
            {connection.status === "needs_reauth" ? "Needs reconnect" : "Setup incomplete"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {await renderStep(connection)}
        {connection && (
          <div className="pt-2">
            <NotionDisconnectButton />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function renderStep(connection: NotionConnection | undefined) {
  // Step 1: not connected, or the token needs replacing — send to OAuth.
  if (!connection || connection.status === "needs_reauth") {
    return (
      <div className="space-y-3">
        {connection?.status === "needs_reauth" && (
          <ErrorBanner message="Your Notion connection needs to be reconnected." />
        )}
        <p className="text-sm text-muted-foreground">
          Connect Notion to turn completed tasks into product updates.
        </p>
        <Button variant="outline" render={<a href="/api/notion/connect" />}>
          Connect Notion
        </Button>
      </div>
    );
  }

  // Step 2: connected but no database chosen.
  if (!connection.databaseId) {
    try {
      const databases = await withFreshToken(db, connection, (token) => listDatabases(token));
      return <NotionDatabaseForm databases={databases} />;
    } catch (error) {
      return <ErrorBanner message={describeError(error)} />;
    }
  }

  // Step 3: database chosen — map completion.
  try {
    const properties = await withFreshToken(db, connection, (token) =>
      getDatabaseProperties(token, connection.databaseId!)
    );
    return (
      <NotionCompletionForm
        properties={properties}
        currentStatusPropertyId={connection.statusPropertyId}
        currentDoneValues={connection.doneValues}
      />
    );
  } catch (error) {
    return <ErrorBanner message={describeError(error)} />;
  }
}
```

Confirm the `<Button render={<a .../>}>` prop pattern matches the codebase (it is used in `page.tsx` for the "Connect GitHub" button).

- [ ] **Step 5: Wire it into the integrations page**

In `src/app/(dashboard)/integrations/page.tsx`, import and render `NotionForm` inside a `Suspense` boundary right after the Webflow one (the fetch inside can take up to 10s, exactly like Webflow — never let it block the page):

```tsx
import { NotionForm } from "./notion-form";

function NotionFormSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notion tasks</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading Notion…</p>
      </CardContent>
    </Card>
  );
}
```

And in the JSX, after the existing Webflow `<Suspense>`:

```tsx
        <Suspense fallback={<NotionFormSkeleton />}>
          <NotionForm />
        </Suspense>
```

- [ ] **Step 6: Typecheck, lint, and manual render check**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

Manually: `npm run dev`, open `/integrations`, confirm the "Notion tasks" card renders with a "Connect Notion" button (no connection state). Full OAuth requires real Notion credentials — verify the card renders and the button links to `/api/notion/connect`.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/integrations/notion-form.tsx" "src/app/(dashboard)/integrations/notion-database-form.tsx" "src/app/(dashboard)/integrations/notion-completion-form.tsx" "src/app/(dashboard)/integrations/notion-disconnect-button.tsx" "src/app/(dashboard)/integrations/page.tsx"
git commit -m "feat: add Notion connect wizard to the integrations page"
```

---

## Task 11: `ingestNotionTask` — tier 1 → tier 2 → upsert → tier 3

**Files:**
- Create: `src/lib/change-events/ingest-notion-task.ts`
- Create: `tests/lib/change-events/ingest-notion-task.test.ts`

**Interfaces:**
- Consumes: `filterTask` (existing), `enrichChangeItem`/`EnrichChangeItem` (Task 3), `resolvePendingEvents` (existing), `changeEvents`.
- Produces:
  - `type NotionTaskInput = { tenantId: string; pageId: string; title: string; description: string | null; url: string; completedAt: Date }`
  - `type IngestNotionTaskDeps = { enrich?: EnrichChangeItem; resolvePending?: typeof resolvePendingEvents; database?: typeof defaultDb }`
  - `ingestNotionTask(input: NotionTaskInput, deps?: IngestNotionTaskDeps): Promise<void>`

Mirrors `ingestMergedPullRequest` exactly, but the tenant is already known (the webhook resolved it by `workspace_id`), `externalId` is the page id, and there is no repo (`repoId` stays null).

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/change-events/ingest-notion-task.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, changeEvents } from "../../../src/db/schema";
import { ingestNotionTask } from "../../../src/lib/change-events/ingest-notion-task";

const TENANT = "Ingest Notion Task Test Tenant";

async function tenantId(): Promise<string> {
  const [t] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return t.id;
}

function baseInput(tid: string, over: Partial<Parameters<typeof ingestNotionTask>[0]> = {}) {
  return {
    tenantId: tid,
    pageId: "page-1",
    title: "Add CSV export",
    description: "Export a report as CSV.",
    url: "https://notion.so/page-1",
    completedAt: new Date("2026-07-24T10:00:00Z"),
    ...over,
  };
}

describe("ingestNotionTask", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("drops a task with no description in tier 1 and never enriches or resolves", async () => {
    const tid = await tenantId();
    const enrich = vi.fn();
    const resolvePending = vi.fn();
    await ingestNotionTask(baseInput(tid, { description: null }), { enrich, resolvePending });

    expect(enrich).not.toHaveBeenCalled();
    expect(resolvePending).not.toHaveBeenCalled();
    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tid));
    expect(row.status).toBe("ignored");
    expect(row.filterReason).toBe("empty_task");
  });

  it("enriches, stores a task event with null repoId, and resolves when user-facing", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: true, impactSummary: "Export to CSV.", suggestedCategory: "new" as const, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });

    const [row] = await db.select().from(changeEvents).where(eq(changeEvents.tenantId, tid));
    expect(row.type).toBe("task");
    expect(row.provider).toBe("notion");
    expect(row.repoId).toBeNull();
    expect(row.externalId).toBe("page-1");
    expect(row.taskTitle).toBe("Add CSV export");
    expect(row.userFacing).toBe(true);
    expect(resolvePending).toHaveBeenCalledWith(tid, [row.id]);
  });

  it("is idempotent: a second delivery inserts no new row and does not re-resolve", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: true, impactSummary: "s", suggestedCategory: "new" as const, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });

    const rows = await db
      .select()
      .from(changeEvents)
      .where(and(eq(changeEvents.tenantId, tid), eq(changeEvents.externalId, "page-1")));
    expect(rows).toHaveLength(1);
    expect(resolvePending).toHaveBeenCalledTimes(1);
  });

  it("does not resolve when the enricher says not user-facing", async () => {
    const tid = await tenantId();
    const enrich = vi.fn(async () => ({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.9 }));
    const resolvePending = vi.fn(async () => {});
    await ingestNotionTask(baseInput(tid), { enrich, resolvePending });
    expect(resolvePending).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/change-events/ingest-notion-task.test.ts`
Expected: FAIL — cannot resolve `ingest-notion-task`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/change-events/ingest-notion-task.ts
import { db as defaultDb } from "@/db";
import { changeEvents } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { filterTask } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

export type NotionTaskInput = {
  tenantId: string;
  pageId: string;
  title: string;
  description: string | null;
  url: string;
  completedAt: Date;
};

export type IngestNotionTaskDeps = {
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

export async function ingestNotionTask(input: NotionTaskInput, deps: IngestNotionTaskDeps = {}): Promise<void> {
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  const database = deps.database ?? defaultDb;

  const base = {
    tenantId: input.tenantId,
    repoId: null,
    type: "task" as const,
    provider: "notion" as const,
    externalId: input.pageId,
    externalUrl: input.url,
    taskTitle: input.title,
    taskDescription: input.description,
    completedAt: input.completedAt,
  };

  // Tier 1.
  const verdict = filterTask({ title: input.title, description: input.description });
  if (verdict.drop) {
    await database
      .insert(changeEvents)
      .values({ ...base, status: "ignored", filterReason: verdict.reason })
      .onConflictDoNothing();
    return;
  }

  // Tier 2.
  const enrichment = await enrich({
    tenantId: input.tenantId,
    type: "task",
    repoName: "",
    taskTitle: input.title,
    taskDescription: input.description,
  });

  const [row] = await database
    .insert(changeEvents)
    .values({
      ...base,
      userFacing: enrichment.userFacing,
      impactSummary: enrichment.impactSummary,
      suggestedCategory: enrichment.suggestedCategory,
      enrichmentConfidence: enrichment.confidence,
      enrichedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: changeEvents.id });

  // Tier 3. `row` is undefined when the unique (tenantId, provider, externalId)
  // conflict swallowed a duplicate delivery — the task already resolved on the
  // first arrival, so do not resolve again.
  if (row && enrichment.userFacing) {
    await resolvePending(input.tenantId, [row.id]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/change-events/ingest-notion-task.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-events/ingest-notion-task.ts tests/lib/change-events/ingest-notion-task.test.ts
git commit -m "feat: add ingestNotionTask (tier 1-3 for Notion tasks)"
```

---

## Task 12: Webhook route `/api/webhooks/notion`

**Files:**
- Create: `src/app/api/webhooks/notion/route.ts`
- Create: `tests/app/api/webhooks/notion/route.test.ts`

**Interfaces:**
- Consumes: `verifyNotionSignature`/`parseVerificationHandshake` (Task 6), `notionConnections`, `withFreshToken` (Task 7), `getPage` (Task 5), `ingestNotionTask` (Task 11).
- Produces: `POST(request): Promise<NextResponse>`. Always 200 except a signature mismatch (401). Page fetch + ingest run in `after()`.

Route logic (spec steps 1–9): verify signature → handle handshake → ignore non-`page.properties_updated` → route by `workspace_id` (unknown → 200 drop) → cheap reject if `updated_properties` lacks `statusPropertyId` → in `after()`: `getPage` → if status value not in `doneValues` stop → `ingestNotionTask`.

- [ ] **Step 1: Write the failing test**

The `after()` work is hard to await in a route test, so this task splits the deferred logic into an exported, directly-testable `processNotionEvent(payload, deps)` and keeps `POST` thin (signature/handshake/shape only). Test both.

```ts
// tests/app/api/webhooks/notion/route.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../../src/db";
import { tenants, notionConnections } from "../../../../../src/db/schema";
import { encryptSecret } from "../../../../../src/lib/credentials/encryption";

const TOKEN = "verif-token";
const TENANT = "Notion Webhook Route Test Tenant";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../../src/lib/change-events/ingest-notion-task", () => ({
  ingestNotionTask: vi.fn(async () => {}),
}));
vi.mock("../../../../../src/lib/integrations/notion/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/integrations/notion/client")>();
  return { ...actual, getPage: vi.fn() };
});

import { POST, processNotionEvent } from "../../../../../src/app/api/webhooks/notion/route";
import { ingestNotionTask } from "../../../../../src/lib/change-events/ingest-notion-task";
import { getPage } from "../../../../../src/lib/integrations/notion/client";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", TOKEN).update(body).digest("hex");
}
function post(body: string, signed = true): Request {
  return new Request("https://app.example.com/api/webhooks/notion", {
    method: "POST",
    body,
    headers: signed ? { "x-notion-signature": sign(body) } : {},
  });
}

async function seedConnection(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: "ws-1",
    databaseId: "db-1",
    statusPropertyId: "prop-status",
    statusPropertyName: "Status",
    doneValues: ["Done"],
    status: "active",
  });
  return tenant.id;
}

describe("notion webhook route", () => {
  beforeAll(() => {
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = TOKEN;
  });
  afterAll(() => {
    delete process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  });
  afterEach(async () => {
    vi.mocked(ingestNotionTask).mockClear();
    vi.mocked(getPage).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rejects a bad signature with 401", async () => {
    const res = await POST(post("{}", false) as never);
    expect(res.status).toBe(401);
  });

  it("200s and logs on a verification handshake", async () => {
    const res = await POST(post(JSON.stringify({ verification_token: "vt" })) as never);
    expect(res.status).toBe(200);
  });

  it("200s and ignores a non page.properties_updated event", async () => {
    await seedConnection();
    const res = await POST(post(JSON.stringify({ type: "page.created", workspace_id: "ws-1" })) as never);
    expect(res.status).toBe(200);
  });

  // processNotionEvent covers steps 4-9 (the deferred body).
  it("drops an unknown workspace without calling getPage", async () => {
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-unknown",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("cheap-rejects when the status property was not among updated_properties (no getPage)", async () => {
    await seedConnection();
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["some-other-prop"] },
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("stops when the status value is not in doneValues", async () => {
    await seedConnection();
    vi.mocked(getPage).mockResolvedValue({
      url: "https://notion.so/page-1",
      title: "T",
      description: "d",
      statusByPropertyId: { "prop-status": "In progress" },
    });
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
    });
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("ingests a completed task", async () => {
    const tid = await seedConnection();
    vi.mocked(getPage).mockResolvedValue({
      url: "https://notion.so/page-1",
      title: "Add dark mode",
      description: "Toggle a dark theme.",
      statusByPropertyId: { "prop-status": "Done" },
    });
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
      timestamp: "2026-07-24T10:00:00.000Z",
    });
    expect(ingestNotionTask).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(ingestNotionTask).mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: tid, pageId: "page-1", title: "Add dark mode", url: "https://notion.so/page-1" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/api/webhooks/notion/route.test.ts`
Expected: FAIL — cannot resolve the route module.

- [ ] **Step 3: Write the route**

```ts
// src/app/api/webhooks/notion/route.ts
import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections } from "@/db/schema";
import { verifyNotionSignature, parseVerificationHandshake } from "@/lib/integrations/notion/notion-webhook";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { getPage } from "@/lib/integrations/notion/client";
import { ingestNotionTask } from "@/lib/change-events/ingest-notion-task";

type NotionEvent = {
  type?: string;
  workspace_id?: string;
  entity?: { id?: string };
  data?: { updated_properties?: string[] };
  timestamp?: string;
};

// Steps 4-9 of the spec. Exported for direct testing; the route runs it inside
// after() so the webhook response is never blocked on Notion API round-trips.
export async function processNotionEvent(payload: NotionEvent): Promise<void> {
  const workspaceId = payload.workspace_id;
  const pageId = payload.entity?.id;
  if (!workspaceId || !pageId) return;

  // Step 4: route to a tenant by workspace_id. Unknown workspace → drop.
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.workspaceId, workspaceId))
    .limit(1);
  if (!connection || connection.status !== "active" || !connection.statusPropertyId) return;

  // Step 5: cheap rejection — most property edits are not status changes.
  const updated = payload.data?.updated_properties ?? [];
  if (!updated.includes(connection.statusPropertyId)) return;

  // Step 6: read current property values (refreshing the token on a 401).
  const page = await withFreshToken(db, connection, (token) => getPage(token, pageId));

  // Step 7: only ingest when the status value means "done".
  const statusValue = page.statusByPropertyId[connection.statusPropertyId];
  if (!statusValue || !connection.doneValues.includes(statusValue)) return;

  // Steps 8-9: hand off to the shared ingestion pipeline. Out-of-order-safe:
  // use the payload timestamp for completedAt, not arrival time.
  const completedAt = payload.timestamp ? new Date(payload.timestamp) : new Date();
  await ingestNotionTask({
    tenantId: connection.tenantId,
    pageId,
    title: page.title,
    description: page.description || null,
    url: page.url,
    completedAt,
  });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Step 2: the one-time verification handshake is not a signed event. Log the
  // token so it can be copied into NOTION_WEBHOOK_VERIFICATION_TOKEN, then 200.
  const handshakeToken = parseVerificationHandshake(rawBody);
  if (handshakeToken) {
    console.log("[notion-webhook] verification_token:", handshakeToken);
    return NextResponse.json({ ok: true });
  }

  // Step 1: verify the signature over the raw body before doing any work.
  if (!verifyNotionSignature(rawBody, request.headers.get("x-notion-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: NotionEvent;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Step 3: only page.properties_updated is relevant.
  if (payload.type !== "page.properties_updated") {
    return NextResponse.json({ ok: true });
  }

  after(async () => {
    try {
      await processNotionEvent(payload);
    } catch (error) {
      console.error("Deferred Notion event processing failed:", error);
    }
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/app/api/webhooks/notion/route.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/webhooks/notion/route.ts tests/app/api/webhooks/notion/route.test.ts
git commit -m "feat: add Notion webhook route feeding the ingestion pipeline"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Covered by |
| --- | --- |
| `notion_connections` data model (encrypted tokens, workspaceId indexed, databaseId, statusPropertyId, doneValues, status) | Task 1 |
| Connect flow — Authorize (OAuth) | Task 8 (`connect` + `callback`) |
| Connect flow — Select database | Tasks 9 + 10 |
| Connect flow — Map completion | Tasks 9 + 10 |
| `misconfigured` until step 3; ingestion ignores non-`active` | Tasks 1 (default), 9 (flip to active), 12 (route gates on `active`) |
| Token refresh on 401, retry once, then `needs_reauth` | Task 7 |
| Webhook route steps 1–9 | Tasks 6 (sig/handshake) + 12 (route + `processNotionEvent`) |
| Cheap rejection (no API call when status prop absent) | Task 12 + test asserting `getPage` not called |
| Idempotency via `(tenantId, provider, externalId)` | Tasks 1 (index) + 11 (`onConflictDoNothing().returning`) |
| Deferred work in `after()`, fast 200s | Task 12 |
| Tier 1 task rules (empty title / missing description) | Existing `filterTask`, exercised in Task 11 |
| Tiers 2–3 unchanged, task-aware | Tasks 2 (title) + 3 (enricher); resolver already task-aware |
| Per-tenant advisory lock unchanged | Existing `resolvePendingEvents` (Task 11 calls it) |
| Testing checklist (sig valid/invalid/handshake; filtering; idempotency; tier-1 rules; gating; refresh; encryption round-trip) | Tasks 1, 6, 7, 8, 11, 12 |
| Fan-in blocker | Task 0 (gate) |
| Accepted gaps (no backfill, drops unrecoverable) / out of scope (polling, page content, re-open) | Not built, by design; noted in Global Constraints |

**Placeholder scan:** none — every code step contains full source; every test step contains full test code; every run step states the command and expected result.

**Type consistency:** `NotionTokenResponse` (Task 4) is consumed by Tasks 7 & 8; `NotionConnection`/`NotionApiError`/`NotionPageContent` shapes are consistent across Tasks 5, 7, 10, 12; `withFreshToken(database, connection, fn)` signature is identical at every call site (Tasks 9, 10, 12); `ingestNotionTask(input, deps)` input shape matches what `processNotionEvent` passes (Task 12) and what the test asserts (Task 11). `EnrichmentResult` fields (`userFacing`, `impactSummary`, `suggestedCategory`, `confidence`) are used consistently in Task 11's mocks and Task 3's type.

**Open interpretation flagged for the implementer:** the spec says a task has a "description" but the connect flow only maps a status property, leaving the description source unspecified. Task 5's `getPage` resolves this by assembling the description from the page's `rich_text` property values (title excluded, page *content* out of scope). If the team prefers a different source (e.g. a tenant-mapped description property), adjust `getPage` and the `NotionCompletionForm`; nothing else changes.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-24-notion-task-source.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints.

Which approach?
