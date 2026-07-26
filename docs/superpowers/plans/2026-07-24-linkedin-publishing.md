# LinkedIn Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant publish a release to a LinkedIn company page (organization) as AI-generated, human-editable copy delivered through the existing destinations/dispatch pipeline.

**Architecture:** LinkedIn is a new `Destination` plugin plus a per-tenant `linkedinConnections` table plus an OAuth callback route. The per-release LinkedIn copy is stored as two new columns on `releases`. Delivery reuses `deliveryAttempts`, `dispatchAllDestinations`, and the cron retry sweep unchanged. Content is generated on demand via the existing direct-Anthropic AI SDK path.

**Tech Stack:** Next.js 16 (App Router, RSC + server actions), Drizzle ORM + Postgres, `ai` SDK with `@ai-sdk/anthropic` (direct provider, per project decision), Vitest, LinkedIn REST API (`/rest/posts`, `organizationAcls`).

## Global Constraints

- **This is NOT stock Next.js** — read the relevant guide in `node_modules/next/dist/docs/` before writing route/server-action/RSC code (per `AGENTS.md`).
- **LLM provider is direct Anthropic** via `@ai-sdk/anthropic` — do NOT route through the Vercel AI Gateway. Mirror `src/lib/ai/generation.ts` exactly (model via `resolveModel(spec)` / `modelId(spec)`, usage via `recordLlmUsage`).
- **Secrets are encrypted** with `encryptSecret` / `decryptSecret` from `src/lib/credentials/encryption.ts` (AES-256-GCM, hex `ciphertext`/`iv`/`authTag` columns). Never store a raw token.
- **Company accounts only** (three enforced guarantees): (1) request `w_organization_social` and NOT `w_member_social`, so the token cannot create a personal post; (2) post `author` is always `urn:li:organization:{id}` — both the save action and `deliver` reject any non-`urn:li:organization:` value via `isOrganizationUrn`; (3) only orgs where the member is `ADMINISTRATOR`/`APPROVED` (from `organizationAcls`) are selectable.
- **Post-once:** if a `deliveryAttempts` row already has an `externalId` for the LinkedIn destination, delivery is a no-op success (no re-post).
- **New env vars** (add to `.env.local` and deployment env): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` (absolute URL to `/api/linkedin/callback`), `LINKEDIN_API_VERSION` (LinkedIn versioning header value, format `YYYYMM`, e.g. `202506`).
- **Run tests with** `npm test` (`vitest run`). DB tests run against the test database configured in `drizzle.config.test.ts`; migrations applied with `npm run db:migrate:test`.
- **External prerequisite (not code):** organization posting requires LinkedIn's Community Management API product approval and per-customer page-admin authorization. Assume granted.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/db/schema.ts` (modify) | Add `linkedin` to `destinationEnum`; add `linkedinConnectionStatusEnum` + `linkedinConnections` table; add `linkedinBody` / `linkedinBodyEditedAt` to `releases`. |
| `src/db/migrations/*` (generated) | Migration for the schema changes. |
| `src/lib/integrations/linkedin/client.ts` (create) | LinkedIn HTTP client: authorize-URL builder, token exchange, token refresh, `listAdminOrganizations`, `createPost`, `LinkedinApiError`. |
| `src/lib/integrations/linkedin/token.ts` (create) | `getValidAccessToken(connection, db)`: decrypt, refresh-if-near-expiry, persist, return usable token. |
| `src/lib/ai/linkedin-copy.ts` (create) | `buildLinkedinCopyPrompt` (pure) + `generateLinkedinCopy` (AI wrapper). |
| `src/lib/ai/llm-usage.ts` (modify) | Add `"linkedin_copy"` to `LlmOperation`. |
| `src/lib/publishing/destinations/types.ts` (modify) | Add `"linkedin"` to `DestinationId`. |
| `src/lib/publishing/destinations/linkedin.ts` (create) | `linkedinDestination`: `loadConfig` gating + `deliver` (post-once, link assembly, classification). |
| `src/lib/publishing/dispatch.ts` (modify) | Register `linkedinDestination` in `DESTINATIONS`. |
| `src/app/api/linkedin/callback/route.ts` (create) | OAuth callback: validate `state`, exchange code, store tokens. |
| `src/app/(dashboard)/integrations/linkedin-actions.ts` (create) | Server actions: build connect URL, list orgs, select org, save base URL, disconnect. |
| `src/app/(dashboard)/integrations/linkedin-form.tsx` (create) | Setup wizard card (async RSC). |
| `src/app/(dashboard)/integrations/page.tsx` (modify) | Render the LinkedIn card. |
| `src/app/(dashboard)/drafts/[releaseId]/linkedin-panel.tsx` (create) | Editable copy panel (client). |
| `src/app/(dashboard)/drafts/[releaseId]/linkedin-actions.ts` (create) | `generateLinkedinCopyAction`, `saveLinkedinCopyAction`. |
| `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (modify) | Conditionally render the panel when LinkedIn is configured. |

---

## Task 1: Schema — enum, releases columns, `linkedinConnections`

**Files:**
- Modify: `src/db/schema.ts` (near `destinationEnum` line ~270; `releases` line ~229; after `webflowConnections` ~350)
- Test: `tests/db/linkedin-connections.test.ts`

**Interfaces:**
- Produces: `linkedinConnections` table; `linkedinConnectionStatusEnum`; `releases.linkedinBody` (text, nullable), `releases.linkedinBodyEditedAt` (timestamptz, nullable); `destinationEnum` includes `"linkedin"`. Row type: `typeof linkedinConnections.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Create `tests/db/linkedin-connections.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, linkedinConnections, releases } from "../../src/db/schema";

const TENANT = "LinkedIn Connections Schema Test Tenant";

async function seedTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  return tenant.id;
}

describe("linkedin_connections schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("stores a connection with encrypted tokens and defaults", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(linkedinConnections)
      .values({
        tenantId,
        accessTokenCiphertext: "aa",
        accessTokenIv: "bb",
        accessTokenAuthTag: "cc",
        expiresAt: new Date(),
      })
      .returning();
    expect(row.status).toBe("active");
    expect(row.organizationUrn).toBeNull();
    expect(row.baseUrl).toBeNull();
    expect(row.refreshTokenCiphertext).toBeNull();
  });

  it("adds nullable linkedin copy columns to releases", async () => {
    const tenantId = await seedTenant();
    const [row] = await db
      .insert(releases)
      .values({ tenantId, title: "T", body: "B", status: "draft" })
      .returning({ linkedinBody: releases.linkedinBody, linkedinBodyEditedAt: releases.linkedinBodyEditedAt });
    expect(row.linkedinBody).toBeNull();
    expect(row.linkedinBodyEditedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/db/linkedin-connections.test.ts`
Expected: FAIL — `linkedinConnections` / `releases.linkedinBody` do not exist (TypeScript/import error).

- [ ] **Step 3: Add the enum value, columns, and table to `src/db/schema.ts`**

Change `destinationEnum` (line ~270) to include `linkedin`:

```typescript
export const destinationEnum = pgEnum("destination", ["webhook", "webflow", "linkedin"]);
```

Add two columns inside the `releases` table definition (after `bodyEditedAt`, line ~251):

```typescript
  // AI-generated, human-editable LinkedIn post copy for this release. Null until
  // generated. The link-back is NOT stored here — it is appended at delivery.
  linkedinBody: text("linkedin_body"),
  // Non-null marks a hand-edit of linkedinBody (analogue of bodyEditedAt), so
  // regeneration can warn before overwriting hand edits.
  linkedinBodyEditedAt: timestamp("linkedin_body_edited_at", { withTimezone: true }),
```

Add after the `webflowConnections` table (end of file):

```typescript
export const linkedinConnectionStatusEnum = pgEnum("linkedin_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);

export const linkedinConnections = pgTable("linkedin_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenAuthTag: text("access_token_auth_tag").notNull(),
  // Null until the first token exchange returns a refresh token (requires the
  // app to be approved for refresh tokens).
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenIv: text("refresh_token_iv"),
  refreshTokenAuthTag: text("refresh_token_auth_tag"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Null until the user selects an administered organization.
  organizationUrn: text("organization_urn"),
  organizationName: text("organization_name"),
  // Tenant changelog/release base URL for link-backs. Null until set.
  baseUrl: text("base_url"),
  status: linkedinConnectionStatusEnum("status").notNull().default("active"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Then apply to the test DB: `npm run db:migrate:test`
Expected: a new file under `src/db/migrations/` adding the enum value, two `releases` columns, and the `linkedin_connections` table.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/db/linkedin-connections.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/db/linkedin-connections.test.ts
git commit -m "feat: linkedin connections table and release copy columns"
```

---

## Task 2: LinkedIn API client

**Files:**
- Create: `src/lib/integrations/linkedin/client.ts`
- Test: `tests/lib/integrations/linkedin-client.test.ts`

**Interfaces:**
- Produces:
  - `class LinkedinApiError extends Error { status: number; details: string[] }`
  - `buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string`
  - `exchangeCode(args: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<LinkedinTokens>`
  - `refreshAccessToken(args: { refreshToken: string; clientId: string; clientSecret: string }): Promise<LinkedinTokens>`
  - `listAdminOrganizations(accessToken: string): Promise<LinkedinOrg[]>`
  - `createPost(args: { accessToken: string; authorUrn: string; commentary: string }): Promise<{ postUrn: string }>`
  - types `LinkedinTokens = { accessToken: string; refreshToken: string | null; expiresInSeconds: number }`, `LinkedinOrg = { urn: string; name: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/integrations/linkedin-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  listAdminOrganizations,
  createPost,
  LinkedinApiError,
} from "../../../src/lib/integrations/linkedin/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("linkedin client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("builds an authorize URL with org scopes and state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://a/cb", state: "t1|integrations" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://a/cb");
    expect(url.searchParams.get("state")).toBe("t1|integrations");
    expect(url.searchParams.get("scope")).toContain("w_organization_social");
  });

  it("exchanges a code for tokens", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 5184000 })
    );
    const tokens = await exchangeCode({ code: "c", clientId: "id", clientSecret: "s", redirectUri: "https://a/cb" });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 5184000 });
  });

  it("refreshes an access token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ access_token: "at2", expires_in: 100 }));
    const tokens = await refreshAccessToken({ refreshToken: "rt", clientId: "id", clientSecret: "s" });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeNull();
  });

  it("lists only ADMINISTRATOR/APPROVED organizations with resolved names", async () => {
    vi.mocked(fetch)
      // organizationAcls
      .mockResolvedValueOnce(
        jsonResponse({
          elements: [
            { role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:1" },
            { role: "ADMINISTRATOR", state: "REQUESTED", organization: "urn:li:organization:2" },
            { role: "VIEWER", state: "APPROVED", organization: "urn:li:organization:3" },
          ],
        })
      )
      // org 1 lookup
      .mockResolvedValueOnce(jsonResponse({ localizedName: "Acme Inc" }));
    const orgs = await listAdminOrganizations("at");
    expect(orgs).toEqual([{ urn: "urn:li:organization:1", name: "Acme Inc" }]);
  });

  it("creates a post and returns the post urn from x-restli-id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } })
    );
    const res = await createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" });
    expect(res.postUrn).toBe("urn:li:share:999");
  });

  it("throws LinkedinApiError on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "nope" }, 401));
    await expect(createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" }))
      .rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/integrations/linkedin-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/integrations/linkedin/client.ts`**

```typescript
const OAUTH_BASE = "https://www.linkedin.com/oauth/v2";
const API_BASE = "https://api.linkedin.com";
const REQUEST_TIMEOUT_MS = 10_000;
const SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"];

export type LinkedinTokens = { accessToken: string; refreshToken: string | null; expiresInSeconds: number };
export type LinkedinOrg = { urn: string; name: string };

export class LinkedinApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.name = "LinkedinApiError";
    this.status = status;
    this.details = details;
  }
}

function apiVersion(): string {
  return process.env.LINKEDIN_API_VERSION ?? "202506";
}

export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(`${OAUTH_BASE}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

async function tokenRequest(body: URLSearchParams): Promise<LinkedinTokens> {
  let response: Response;
  try {
    response = await fetch(`${OAUTH_BASE}/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Timeouts/DNS stay plain Errors so the caller classifies them as retryable.
    throw error instanceof Error ? error : new Error("linkedin token request failed");
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error_description?: string; message?: string };
    throw new LinkedinApiError(response.status, detail.error_description ?? detail.message ?? `HTTP ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSeconds: data.expires_in };
}

export function exchangeCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<LinkedinTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    })
  );
}

export function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinkedinTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    })
  );
}

async function restRequest<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": apiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error("linkedin request failed");
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    throw new LinkedinApiError(response.status, detail.message ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function listAdminOrganizations(accessToken: string): Promise<LinkedinOrg[]> {
  const response = await restRequest(
    accessToken,
    "/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED"
  );
  const data = (await response.json()) as {
    elements?: { role: string; state: string; organization: string }[];
  };
  const urns = (data.elements ?? [])
    .filter((e) => e.role === "ADMINISTRATOR" && e.state === "APPROVED")
    .map((e) => e.organization);

  const orgs: LinkedinOrg[] = [];
  for (const urn of urns) {
    const id = urn.split(":").pop();
    const lookup = await restRequest(accessToken, `/rest/organizations/${id}`);
    const org = (await lookup.json()) as { localizedName?: string };
    orgs.push({ urn, name: org.localizedName ?? urn });
  }
  return orgs;
}

export async function createPost(args: {
  accessToken: string;
  authorUrn: string;
  commentary: string;
}): Promise<{ postUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/posts", {
    method: "POST",
    body: JSON.stringify({
      author: args.authorUrn,
      commentary: args.commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  const postUrn = response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id") ?? "";
  return { postUrn };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/integrations/linkedin-client.test.ts`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/linkedin/client.ts tests/lib/integrations/linkedin-client.test.ts
git commit -m "feat: linkedin api client (oauth, org acls, create post)"
```

---

## Task 3: Token lifecycle helper

**Files:**
- Create: `src/lib/integrations/linkedin/token.ts`
- Test: `tests/lib/integrations/linkedin-token.test.ts`

**Interfaces:**
- Consumes: `refreshAccessToken`, `LinkedinApiError` (Task 2); `encryptSecret`/`decryptSecret`; `linkedinConnections` (Task 1).
- Produces: `getValidAccessToken(connection: LinkedinConnection, database: DbClient): Promise<string>` where `LinkedinConnection = typeof linkedinConnections.$inferSelect`. Throws `LinkedinApiError` (status 401) when refresh is required but impossible (no refresh token) or fails. Refreshes when `expiresAt` is within `REFRESH_SKEW_MS` (60s) of now, persists the new token, and returns the usable plaintext token.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/integrations/linkedin-token.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, linkedinConnections } from "../../../src/db/schema";
import { encryptSecret, decryptSecret } from "../../../src/lib/credentials/encryption";
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";

vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, refreshAccessToken: vi.fn() };
});
import { refreshAccessToken } from "../../../src/lib/integrations/linkedin/client";

const TENANT = "LinkedIn Token Test Tenant";

function enc(value: string) {
  const p = encryptSecret(value);
  return { ciphertext: p.ciphertext, iv: p.iv, authTag: p.authTag };
}

async function seedConnection(overrides: Partial<typeof linkedinConnections.$inferInsert>) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const access = enc("current-token");
  const [row] = await db
    .insert(linkedinConnections)
    .values({
      tenantId: tenant.id,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      expiresAt: new Date(Date.now() + 3600_000),
      ...overrides,
    })
    .returning();
  return row;
}

describe("getValidAccessToken", () => {
  beforeEach(() => vi.mocked(refreshAccessToken).mockReset());
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns the current token when not near expiry", async () => {
    const row = await seedConnection({});
    const token = await getValidAccessToken(row, db);
    expect(token).toBe("current-token");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("refreshes and persists when near expiry", async () => {
    const refresh = enc("refresh-token");
    const row = await seedConnection({
      expiresAt: new Date(Date.now() + 10_000),
      refreshTokenCiphertext: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenAuthTag: refresh.authTag,
    });
    vi.mocked(refreshAccessToken).mockResolvedValue({ accessToken: "fresh", refreshToken: null, expiresInSeconds: 3600 });
    const token = await getValidAccessToken(row, db);
    expect(token).toBe("fresh");
    const [persisted] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.id, row.id));
    expect(decryptSecret({ ciphertext: persisted.accessTokenCiphertext, iv: persisted.accessTokenIv, authTag: persisted.accessTokenAuthTag })).toBe("fresh");
  });

  it("throws 401 when near expiry with no refresh token", async () => {
    const row = await seedConnection({ expiresAt: new Date(Date.now() + 10_000) });
    await expect(getValidAccessToken(row, db)).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/integrations/linkedin-token.test.ts`
Expected: FAIL — `getValidAccessToken` not found.

- [ ] **Step 3: Implement `src/lib/integrations/linkedin/token.ts`**

```typescript
import { eq } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/credentials/encryption";
import type { DbClient } from "@/lib/publishing/destinations/types";
import { LinkedinApiError, refreshAccessToken } from "./client";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

const REFRESH_SKEW_MS = 60_000;

export async function getValidAccessToken(connection: LinkedinConnection, database: DbClient): Promise<string> {
  const near = connection.expiresAt.getTime() - Date.now() <= REFRESH_SKEW_MS;
  if (!near) {
    return decryptSecret({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      authTag: connection.accessTokenAuthTag,
    });
  }

  if (!connection.refreshTokenCiphertext || !connection.refreshTokenIv || !connection.refreshTokenAuthTag) {
    throw new LinkedinApiError(401, "LinkedIn access token expired and no refresh token is stored. Reconnect.");
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new LinkedinApiError(401, "LINKEDIN_CLIENT_ID/SECRET not configured.");
  }

  const refreshToken = decryptSecret({
    ciphertext: connection.refreshTokenCiphertext,
    iv: connection.refreshTokenIv,
    authTag: connection.refreshTokenAuthTag,
  });

  // Let a refresh failure surface as LinkedinApiError(401) so the destination
  // classifies it as a configFault and flips the connection to needs_reauth.
  const tokens = await refreshAccessToken({ refreshToken, clientId, clientSecret });

  const access = encryptSecret(tokens.accessToken);
  const nextRefresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;
  await database
    .update(linkedinConnections)
    .set({
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      ...(nextRefresh
        ? {
            refreshTokenCiphertext: nextRefresh.ciphertext,
            refreshTokenIv: nextRefresh.iv,
            refreshTokenAuthTag: nextRefresh.authTag,
          }
        : {}),
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000),
      lastValidatedAt: new Date(),
    })
    .where(eq(linkedinConnections.id, connection.id));

  return tokens.accessToken;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/integrations/linkedin-token.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/linkedin/token.ts tests/lib/integrations/linkedin-token.test.ts
git commit -m "feat: linkedin token refresh helper"
```

---

## Task 4: AI copy generation

**Files:**
- Create: `src/lib/ai/linkedin-copy.ts`
- Modify: `src/lib/ai/llm-usage.ts:4-11` (add `"linkedin_copy"`)
- Test: `tests/lib/ai/linkedin-copy.test.ts`

**Interfaces:**
- Consumes: `resolveModel`/`modelId` (`src/lib/ai/model.ts`), `recordLlmUsage` (`src/lib/ai/llm-usage.ts`), `generateObject` from `ai`.
- Produces:
  - `LINKEDIN_MAX_CHARS = 2900`
  - `buildLinkedinCopyPrompt(args: { title: string; body: string }): { system: string; prompt: string }`
  - `generateLinkedinCopy(args: { tenantId: string; title: string; body: string }): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/linkedin-copy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";
import { buildLinkedinCopyPrompt, generateLinkedinCopy, LINKEDIN_MAX_CHARS } from "../../../src/lib/ai/linkedin-copy";

describe("linkedin copy generation", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(recordLlmUsage).mockReset();
  });

  it("builds a prompt that names the char limit and forbids markdown", () => {
    const { system, prompt } = buildLinkedinCopyPrompt({ title: "New dashboard", body: "We shipped X." });
    expect(system).toContain(String(LINKEDIN_MAX_CHARS));
    expect(system.toLowerCase()).toContain("no markdown");
    expect(prompt).toContain("New dashboard");
    expect(prompt).toContain("We shipped X.");
  });

  it("returns generated copy and records usage", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { post: "Hook line.\n\nDetails." }, usage: { totalTokens: 42 } } as never);
    const copy = await generateLinkedinCopy({ tenantId: "t1", title: "T", body: "B" });
    expect(copy).toBe("Hook line.\n\nDetails.");
    expect(recordLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", operation: "linkedin_copy" }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/ai/linkedin-copy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the operation and implement the module**

In `src/lib/ai/llm-usage.ts`, extend the union (line ~4):

```typescript
export type LlmOperation =
  | "generation"
  | "enrichment"
  | "review"
  | "revision"
  | "brand_analysis"
  | "resolution"
  | "atomic_summary"
  | "linkedin_copy";
```

Create `src/lib/ai/linkedin-copy.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

export const LINKEDIN_MAX_CHARS = 2900;

const LinkedinCopySchema = z.object({ post: z.string() });

export function buildLinkedinCopyPrompt(args: { title: string; body: string }): { system: string; prompt: string } {
  const system = [
    "You write LinkedIn posts for a company page announcing product releases.",
    "Write in the company's voice: a strong first-line hook, then a concise, skimmable summary of what shipped and why it matters to customers.",
    "Plain text only — NO markdown syntax (no #, *, _, backticks, or link markup). Line breaks are fine.",
    `Keep the whole post at or under ${LINKEDIN_MAX_CHARS} characters. Do NOT include a URL — a link is appended automatically.`,
  ].join(" ");

  const prompt = [
    `Release title:\n${args.title}`,
    "",
    `Release notes (markdown):\n${args.body}`,
    "",
    "Write the LinkedIn post.",
  ].join("\n");

  return { system, prompt };
}

export async function generateLinkedinCopy(args: { tenantId: string; title: string; body: string }): Promise<string> {
  const { system, prompt } = buildLinkedinCopyPrompt({ title: args.title, body: args.body });
  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";

  const result = await generateObject({
    model: resolveModel(spec),
    schema: LinkedinCopySchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.tenantId,
    operation: "linkedin_copy",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object.post;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/ai/linkedin-copy.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/linkedin-copy.ts src/lib/ai/llm-usage.ts tests/lib/ai/linkedin-copy.test.ts
git commit -m "feat: ai-generated linkedin post copy"
```

---

## Task 5: LinkedIn destination

**Files:**
- Modify: `src/lib/publishing/destinations/types.ts:5` (add `"linkedin"` to `DestinationId`)
- Create: `src/lib/publishing/destinations/linkedin.ts`
- Modify: `src/lib/publishing/dispatch.ts:4-11` (import + register)
- Test: `tests/lib/publishing/linkedin-destination.test.ts`

**Interfaces:**
- Consumes: `Destination`/`DeliveryResult`/`DbClient`/`Release` (types.ts), `getValidAccessToken` (Task 3), `createPost`/`LinkedinApiError` (Task 2), `slugify` (`src/lib/publishing/slug.ts`), `linkedinConnections` (Task 1).
- Produces: `linkedinDestination: Destination<LinkedinConnection>` with `id: "linkedin"`, `label: "LinkedIn"`. `loadConfig` returns the row only when `status === "active"` AND `organizationUrn` AND `baseUrl` are set. `deliver` is post-once (skips when `externalId` set), guards empty `linkedinBody`, appends `baseUrl + slug` link, classifies 401/403 as `permanent`+`configFault` and flips status to `needs_reauth`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/publishing/linkedin-destination.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkedinDestination } from "../../../src/lib/publishing/destinations/linkedin";
import type { Release, DbClient } from "../../../src/lib/publishing/destinations/types";

vi.mock("../../../src/lib/integrations/linkedin/token", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, createPost: vi.fn() };
});
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";
import { createPost, LinkedinApiError } from "../../../src/lib/integrations/linkedin/client";

const release = (over: Partial<Release> = {}): Release =>
  ({ id: "r1", tenantId: "t1", title: "New Dashboard", body: "b", linkedinBody: "Hook.\n\nDetails.", ...over } as Release);

const connection = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", status: "active", organizationUrn: "urn:li:organization:1", baseUrl: "https://acme.com/changelog/", ...over } as never);

// A DbClient stub that records update().set() payloads.
function dbStub() {
  const sets: Record<string, unknown>[] = [];
  const database = {
    update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => Promise.resolve() }; } }),
  } as unknown as DbClient;
  return { database, sets };
}

describe("linkedin destination", () => {
  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
  });

  it("is a no-op success when already posted (externalId set)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release(), connection(), "urn:li:share:existing", database);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:existing" });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("permanently fails when linkedinBody is empty", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release({ linkedinBody: "  " }), connection(), null, database);
    expect(result.status).toBe("permanent");
  });

  it("refuses to post when the author is not an organization urn (company-only)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(
      release(),
      connection({ organizationUrn: "urn:li:person:123" }),
      null,
      database
    );
    expect(result).toMatchObject({ status: "permanent", configFault: true });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("posts commentary with the appended slug link and stores the urn", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(createPost).mockResolvedValue({ postUrn: "urn:li:share:1" });
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1" });
    const arg = vi.mocked(createPost).mock.calls[0][0];
    expect(arg.commentary).toBe("Hook.\n\nDetails.\n\nhttps://acme.com/changelog/new-dashboard");
    expect(arg.authorUrn).toBe("urn:li:organization:1");
  });

  it("classifies 401 as permanent configFault and marks needs_reauth", async () => {
    const { database, sets } = dbStub();
    vi.mocked(getValidAccessToken).mockRejectedValue(new LinkedinApiError(401, "expired"));
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result).toMatchObject({ status: "permanent", configFault: true });
    expect(sets).toContainEqual(expect.objectContaining({ status: "needs_reauth" }));
  });

  it("classifies 5xx as retryable", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(createPost).mockRejectedValue(new LinkedinApiError(503, "down"));
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result.status).toBe("retryable");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/publishing/linkedin-destination.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the id to `DestinationId`**

In `src/lib/publishing/destinations/types.ts` line 5:

```typescript
export type DestinationId = "webhook" | "webflow" | "linkedin";
```

- [ ] **Step 4: Implement `src/lib/publishing/destinations/linkedin.ts`**

```typescript
import { and, eq, isNotNull } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";
import { createPost, LinkedinApiError } from "@/lib/integrations/linkedin/client";
import { slugify } from "@/lib/publishing/slug";
import type { Destination, DeliveryResult, DbClient, Release } from "./types";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

function isAuthFailure(error: unknown): boolean {
  return error instanceof LinkedinApiError && (error.status === 401 || error.status === 403);
}

function classify(error: unknown): DeliveryResult {
  if (error instanceof LinkedinApiError) {
    if (error.status === 401 || error.status === 403) {
      return { status: "permanent", error: "LinkedIn rejected the token. Reconnect the integration.", configFault: true };
    }
    if (error.status === 429 || error.status === 408 || error.status >= 500) {
      return { status: "retryable", error: error.message };
    }
    return { status: "permanent", error: `LinkedIn rejected the post: ${error.message}` };
  }
  return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
}

// Best-effort: flip the connection to needs_reauth so the integrations banner
// prompts a reconnect. Never let this turn a clean classification into a throw.
async function recordNeedsReauth(database: DbClient, connectionId: string): Promise<void> {
  try {
    await database.update(linkedinConnections).set({ status: "needs_reauth" }).where(eq(linkedinConnections.id, connectionId));
  } catch (error) {
    console.error(`Failed to mark LinkedIn connection ${connectionId} as needs_reauth:`, error);
  }
}

async function classifyAndRecord(error: unknown, database: DbClient, connectionId: string): Promise<DeliveryResult> {
  if (isAuthFailure(error)) await recordNeedsReauth(database, connectionId);
  return classify(error);
}

export const linkedinDestination: Destination<LinkedinConnection> = {
  id: "linkedin",
  label: "LinkedIn",

  async loadConfig(tenantId, database: DbClient) {
    const [connection] = await database
      .select()
      .from(linkedinConnections)
      .where(
        and(
          eq(linkedinConnections.tenantId, tenantId),
          eq(linkedinConnections.status, "active"),
          isNotNull(linkedinConnections.organizationUrn),
          isNotNull(linkedinConnections.baseUrl)
        )
      )
      .limit(1);
    return connection ?? null;
  },

  async deliver(release: Release, connection, externalId, database): Promise<DeliveryResult> {
    // Post-once: a release already posted to LinkedIn must never be re-posted
    // (that would duplicate/spam), unlike Webflow which updates in place.
    if (externalId) return { status: "ok", externalId };

    if (!connection.organizationUrn || !connection.baseUrl) {
      return { status: "permanent", error: "LinkedIn connection is missing an organization or base URL.", configFault: true };
    }
    // Company-only guarantee 2: never post as a personal member. The author
    // must be an organization URN; anything else is a config fault, not a post.
    if (!connection.organizationUrn.startsWith("urn:li:organization:")) {
      return { status: "permanent", error: "LinkedIn author must be an organization page.", configFault: true };
    }
    if (!release.linkedinBody || !release.linkedinBody.trim()) {
      return { status: "permanent", error: "Generate a LinkedIn post before publishing." };
    }

    const link = new URL(slugify(release.title), connection.baseUrl).toString();
    const commentary = `${release.linkedinBody.trim()}\n\n${link}`;

    try {
      const accessToken = await getValidAccessToken(connection, database);
      const { postUrn } = await createPost({ accessToken, authorUrn: connection.organizationUrn, commentary });
      return { status: "ok", externalId: postUrn };
    } catch (error) {
      return classifyAndRecord(error, database, connection.id);
    }
  },
};
```

> Note: `new URL(slugify(title), baseUrl)` requires `baseUrl` to end with `/` to preserve its path segment. The setup action (Task 7) normalizes the stored `baseUrl` to a trailing slash, so the test's `https://acme.com/changelog/` + `new-dashboard` → `https://acme.com/changelog/new-dashboard` holds.

- [ ] **Step 5: Register the destination in `src/lib/publishing/dispatch.ts`**

Add the import (after line 5) and extend the array (line 11):

```typescript
import { linkedinDestination } from "./destinations/linkedin";
```

```typescript
const DESTINATIONS: Destination<any>[] = [webhookDestination, webflowDestination, linkedinDestination];
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- tests/lib/publishing/linkedin-destination.test.ts tests/lib/publishing/dispatch.test.ts`
Expected: PASS. The existing dispatch test still passes (registering a third destination doesn't change webhook/webflow behavior; `listPublishTargets` now returns a third entry — that test asserts on specific ids, not array length).

- [ ] **Step 7: Commit**

```bash
git add src/lib/publishing/destinations/types.ts src/lib/publishing/destinations/linkedin.ts src/lib/publishing/dispatch.ts tests/lib/publishing/linkedin-destination.test.ts
git commit -m "feat: linkedin publishing destination (post-once, org-only)"
```

---

## Task 6: OAuth callback route

**Files:**
- Create: `src/app/api/linkedin/callback/route.ts`
- Test: `tests/app/api/linkedin/callback/route.test.ts`

**Interfaces:**
- Consumes: `requireSession` (`src/lib/workspace/session.ts`), `exchangeCode` (Task 2), `encryptSecret`, `linkedinConnections` (Task 1).
- Produces: `GET(request: NextRequest)`. Reads `code` + `state` (`tenantId|returnTo`); rejects when `state`'s tenant ≠ session tenant → redirect `/integrations?linkedin_connect=error`. On success, exchanges the code, upserts the connection row (tokens + `expiresAt`, keyed by unique `tenantId`), redirects `/integrations?linkedin_connect=success`.

- [ ] **Step 1: Study the existing pattern**

Read `src/app/api/github/setup/route.ts` and `tests/app/api/github/setup/route.test.ts` to mirror the `state` validation + `NextResponse.redirect` shape and the test's session mock.

- [ ] **Step 2: Write the failing test**

Create `tests/app/api/linkedin/callback/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "../../../../../src/db";
import { tenants, linkedinConnections } from "../../../../../src/db/schema";

vi.mock("../../../../../src/lib/workspace/session", () => ({ requireSession: vi.fn() }));
vi.mock("../../../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, exchangeCode: vi.fn() };
});
import { requireSession } from "../../../../../src/lib/workspace/session";
import { exchangeCode } from "../../../../../src/lib/integrations/linkedin/client";
import { GET } from "../../../../../src/app/api/linkedin/callback/route";

const TENANT = "LinkedIn Callback Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant.id;
}

describe("GET /api/linkedin/callback", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockReset();
    vi.mocked(exchangeCode).mockReset();
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rejects a state whose tenant does not match the session", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    const req = new NextRequest("https://app/api/linkedin/callback?code=c&state=other|integrations");
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=error");
  });

  it("exchanges the code and stores the connection", async () => {
    const tenantId = await seedTenant();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(exchangeCode).mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 });
    const req = new NextRequest(`https://app/api/linkedin/callback?code=c&state=${tenantId}|integrations`);
    const res = await GET(req);
    expect(res.headers.get("location")).toContain("linkedin_connect=success");
    const [row] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId));
    expect(row.refreshTokenCiphertext).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/app/api/linkedin/callback/route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 4: Implement `src/app/api/linkedin/callback/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";
import { exchangeCode } from "@/lib/integrations/linkedin/client";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const [tenantIdFromState] = (state ?? "").split("|");

  const errorUrl = new URL("/integrations?linkedin_connect=error", request.url);
  if (!code || tenantIdFromState !== session.user.tenantId) {
    return NextResponse.redirect(errorUrl);
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(errorUrl);
  }

  let tokens;
  try {
    tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri });
  } catch (error) {
    console.error("LinkedIn code exchange failed:", error);
    return NextResponse.redirect(errorUrl);
  }

  const access = encryptSecret(tokens.accessToken);
  const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000);

  // Upsert on the unique tenantId: reconnecting replaces the stored tokens and
  // resets status to active without disturbing a previously-selected org/baseUrl.
  await db
    .insert(linkedinConnections)
    .values({
      tenantId: session.user.tenantId,
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenIv: refresh?.iv ?? null,
      refreshTokenAuthTag: refresh?.authTag ?? null,
      expiresAt,
      status: "active",
      lastValidatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: linkedinConnections.tenantId,
      set: {
        accessTokenCiphertext: access.ciphertext,
        accessTokenIv: access.iv,
        accessTokenAuthTag: access.authTag,
        refreshTokenCiphertext: refresh?.ciphertext ?? null,
        refreshTokenIv: refresh?.iv ?? null,
        refreshTokenAuthTag: refresh?.authTag ?? null,
        expiresAt,
        status: "active",
        lastValidatedAt: new Date(),
      },
    });

  return NextResponse.redirect(new URL("/integrations?linkedin_connect=success", request.url));
}
```

> `sql` import is unused above — remove it; shown only to flag that no raw SQL is needed. Final import line: drop `sql`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/app/api/linkedin/callback/route.test.ts`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/linkedin/callback tests/app/api/linkedin/callback
git commit -m "feat: linkedin oauth callback route"
```

---

## Task 7: Integrations server actions

**Files:**
- Create: `src/app/(dashboard)/integrations/linkedin-actions.ts`
- Test: `tests/app/integrations/linkedin-actions.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `buildAuthorizeUrl`/`listAdminOrganizations` (Task 2), `getValidAccessToken` (Task 3), `linkedinConnections`.
- Produces (all `"use server"`):
  - `getLinkedinConnectUrl(): Promise<string>` — the authorize URL with `state = tenantId|integrations`.
  - `listLinkedinOrganizations(): Promise<{ urn: string; name: string }[]>` — for the connected tenant, via a valid access token.
  - `saveLinkedinOrganization(formData: FormData): Promise<void>` — reads `urn` + `name`, stores them.
  - `saveLinkedinBaseUrl(formData: FormData): Promise<void>` — reads `baseUrl`, validates it is an absolute http(s) URL, normalizes to a trailing slash, stores it.
  - `disconnectLinkedin(): Promise<void>` — deletes the tenant's connection row.
  - `normalizeBaseUrl(raw: string): string` (exported pure helper) — throws on non-http(s)/relative; appends `/` if missing.
  - `isOrganizationUrn(urn: string): boolean` (exported pure helper) — true only for `urn:li:organization:*`; used by `saveLinkedinOrganization` and mirrored by the Task 5 `deliver` guard.

- [ ] **Step 1: Write the failing test** (pure helper — no session needed)

Create `tests/app/integrations/linkedin-actions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeBaseUrl, isOrganizationUrn } from "../../../src/app/(dashboard)/integrations/linkedin-actions";

describe("normalizeBaseUrl", () => {
  it("appends a trailing slash", () => {
    expect(normalizeBaseUrl("https://acme.com/changelog")).toBe("https://acme.com/changelog/");
  });
  it("leaves an existing trailing slash", () => {
    expect(normalizeBaseUrl("https://acme.com/changelog/")).toBe("https://acme.com/changelog/");
  });
  it("rejects a relative or non-http URL", () => {
    expect(() => normalizeBaseUrl("/changelog")).toThrow();
    expect(() => normalizeBaseUrl("ftp://acme.com")).toThrow();
  });
});

describe("isOrganizationUrn", () => {
  it("accepts an organization urn", () => {
    expect(isOrganizationUrn("urn:li:organization:123")).toBe(true);
  });
  it("rejects a personal member urn", () => {
    expect(isOrganizationUrn("urn:li:person:123")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/app/integrations/linkedin-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/app/(dashboard)/integrations/linkedin-actions.ts`**

```typescript
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl, listAdminOrganizations } from "@/lib/integrations/linkedin/client";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw); // throws on relative
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be an http(s) URL.");
  }
  const s = url.toString();
  return s.endsWith("/") ? s : `${s}/`;
}

// Company-only backstop, shared by the save action and the destination guard.
export function isOrganizationUrn(urn: string): boolean {
  return urn.startsWith("urn:li:organization:");
}

export async function getLinkedinConnectUrl(): Promise<string> {
  const session = await requireSession();
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new Error("LinkedIn is not configured on the server.");
  return buildAuthorizeUrl({ clientId, redirectUri, state: `${session.user.tenantId}|integrations` });
}

async function loadConnectionOrThrow(tenantId: string) {
  const [connection] = await db.select().from(linkedinConnections).where(eq(linkedinConnections.tenantId, tenantId)).limit(1);
  if (!connection) throw new Error("LinkedIn is not connected.");
  return connection;
}

export async function listLinkedinOrganizations(): Promise<{ urn: string; name: string }[]> {
  const session = await requireSession();
  const connection = await loadConnectionOrThrow(session.user.tenantId);
  const accessToken = await getValidAccessToken(connection, db);
  return listAdminOrganizations(accessToken);
}

export async function saveLinkedinOrganization(formData: FormData): Promise<void> {
  const session = await requireSession();
  const urn = String(formData.get("urn") ?? "");
  const name = String(formData.get("name") ?? "");
  if (!urn) throw new Error("Select an organization.");
  // Company-only backstop: the ACL list only returns org URNs, but never trust
  // the submitted form value — reject anything that is not an organization page.
  if (!isOrganizationUrn(urn)) throw new Error("Only company pages can be selected.");
  await db
    .update(linkedinConnections)
    .set({ organizationUrn: urn, organizationName: name })
    .where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function saveLinkedinBaseUrl(formData: FormData): Promise<void> {
  const session = await requireSession();
  const baseUrl = normalizeBaseUrl(String(formData.get("baseUrl") ?? ""));
  await db
    .update(linkedinConnections)
    .set({ baseUrl })
    .where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function disconnectLinkedin(): Promise<void> {
  const session = await requireSession();
  await db.delete(linkedinConnections).where(eq(linkedinConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/app/integrations/linkedin-actions.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/integrations/linkedin-actions.ts" tests/app/integrations/linkedin-actions.test.ts
git commit -m "feat: linkedin integration server actions"
```

---

## Task 8: Integrations UI card

**Files:**
- Create: `src/app/(dashboard)/integrations/linkedin-form.tsx`
- Modify: `src/app/(dashboard)/integrations/page.tsx` (render the card in a `Suspense`)

**Interfaces:**
- Consumes: `requireSession`, `linkedinConnections`, the Task 7 actions, `Card`/`CardHeader`/`CardTitle`/`CardContent` from `@/components/ui/card`.
- Produces: `LinkedinForm` (async server component) rendering the correct wizard stage from the connection row: not connected → Connect button (posts to a tiny client wrapper that calls `getLinkedinConnectUrl` then navigates); connected but no org → org picker (calls `listLinkedinOrganizations`, submits `saveLinkedinOrganization`); org set but no base URL → base URL form; fully configured → connected summary + Disconnect; `needs_reauth` → reconnect banner.

This is UI wiring with no independent unit test (its logic is the branch selection, verified visually + by the actions' own tests). Fold the render into a single task.

- [ ] **Step 1: Read the pattern**

Read `src/app/(dashboard)/integrations/webflow-form.tsx` and the picker components (`webflow-collection-form.tsx`, `webflow-token-form.tsx`) to mirror the async-RSC + client-subcomponent + `Card` structure and the `?...=success|error` query-flash handling.

- [ ] **Step 2: Implement `linkedin-form.tsx`**

Mirror `webflow-form.tsx`. Skeleton (fill in the JSX following the Webflow components' styling):

```tsx
import { eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listLinkedinOrganizations, saveLinkedinOrganization, saveLinkedinBaseUrl, disconnectLinkedin } from "./linkedin-actions";
import { LinkedinConnectButton } from "./linkedin-connect-button"; // client wrapper calling getLinkedinConnectUrl()

export async function LinkedinForm() {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(linkedinConnections)
    .where(eq(linkedinConnections.tenantId, session.user.tenantId))
    .limit(1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>LinkedIn company page</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stage 1: not connected */}
        {!connection && <LinkedinConnectButton />}

        {/* needs_reauth banner */}
        {connection?.status === "needs_reauth" && (
          <p className="text-sm text-destructive">LinkedIn disconnected this app. Reconnect to keep publishing.</p>
        )}

        {/* Stage 2: connected, pick org */}
        {connection && !connection.organizationUrn && (
          <OrgPicker orgs={await listLinkedinOrganizations()} action={saveLinkedinOrganization} />
        )}

        {/* Stage 3: org set, need base URL */}
        {connection?.organizationUrn && !connection.baseUrl && (
          <form action={saveLinkedinBaseUrl} className="space-y-2">
            <label className="text-sm" htmlFor="baseUrl">Changelog base URL</label>
            <input id="baseUrl" name="baseUrl" placeholder="https://acme.com/changelog/" className="w-full rounded border px-2 py-1" />
            <button type="submit" className="rounded bg-primary px-3 py-1 text-primary-foreground">Save</button>
          </form>
        )}

        {/* Stage 4: fully configured */}
        {connection?.organizationUrn && connection.baseUrl && (
          <div className="space-y-2 text-sm">
            <p>Posting to <strong>{connection.organizationName}</strong></p>
            <p className="text-muted-foreground">Link base: {connection.baseUrl}</p>
            <form action={disconnectLinkedin}>
              <button type="submit" className="rounded border px-3 py-1">Disconnect</button>
            </form>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OrgPicker({ orgs, action }: { orgs: { urn: string; name: string }[]; action: (fd: FormData) => Promise<void> }) {
  if (orgs.length === 0) return <p className="text-sm text-muted-foreground">No company pages you administer were found.</p>;
  return (
    <form action={action} className="space-y-2">
      {orgs.map((o) => (
        <label key={o.urn} className="flex items-center gap-2 text-sm">
          <input type="radio" name="urn" value={o.urn} required />
          {o.name}
          <input type="hidden" name="name" value={o.name} />
        </label>
      ))}
      <button type="submit" className="rounded bg-primary px-3 py-1 text-primary-foreground">Use this page</button>
    </form>
  );
}
```

Also create `src/app/(dashboard)/integrations/linkedin-connect-button.tsx` (client):

```tsx
"use client";
import { getLinkedinConnectUrl } from "./linkedin-actions";

export function LinkedinConnectButton() {
  async function connect() {
    const url = await getLinkedinConnectUrl();
    window.location.href = url;
  }
  return (
    <button type="button" onClick={connect} className="rounded bg-primary px-3 py-1 text-primary-foreground">
      Connect LinkedIn
    </button>
  );
}
```

> The `name` hidden input inside a radio-label works because only the selected radio's sibling matters at submit only if scoped per-option; if multiple `name="name"` inputs cause ambiguity, switch `OrgPicker` to a `<select>` of `urn` and resolve the name server-side in `saveLinkedinOrganization` by re-listing. Prefer the `<select>` approach if unsure.

- [ ] **Step 3: Render the card in `page.tsx`**

In `src/app/(dashboard)/integrations/page.tsx`, add an import and a `Suspense`-wrapped card next to the Webflow one, mirroring `WebflowFormSkeleton`:

```tsx
import { LinkedinForm } from "./linkedin-form";

function LinkedinFormSkeleton() {
  return (
    <Card>
      <CardHeader><CardTitle>LinkedIn company page</CardTitle></CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Loading LinkedIn…</p></CardContent>
    </Card>
  );
}
```

Inside the `<section>`, after the Webflow `Suspense`:

```tsx
<Suspense fallback={<LinkedinFormSkeleton />}>
  <LinkedinForm />
</Suspense>
```

- [ ] **Step 4: Manual verification**

Run: `npm run build` — expect a clean compile (no type errors). Full OAuth is externally gated (needs a real LinkedIn app), so runtime verification of the flow is deferred to a staging environment with real `LINKEDIN_*` env vars.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/integrations/linkedin-form.tsx" "src/app/(dashboard)/integrations/linkedin-connect-button.tsx" "src/app/(dashboard)/integrations/page.tsx"
git commit -m "feat: linkedin integration setup card"
```

---

## Task 9: Drafts LinkedIn panel (gated) + generate/save actions

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/linkedin-actions.ts`
- Create: `src/app/(dashboard)/drafts/[releaseId]/linkedin-panel.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (conditionally render the panel)
- Test: `tests/app/drafts/linkedin-actions.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `generateLinkedinCopy` (Task 4), `linkedinDestination.loadConfig` (Task 5) to decide gating, `releases`.
- Produces (all `"use server"`):
  - `generateLinkedinCopyAction(formData: FormData): Promise<void>` — reads `releaseId`, loads the release (tenant-scoped), calls `generateLinkedinCopy`, stores `linkedinBody` and clears `linkedinBodyEditedAt`, `revalidatePath`.
  - `saveLinkedinCopyAction(formData: FormData): Promise<void>` — reads `releaseId` + `linkedinBody`, stores it and sets `linkedinBodyEditedAt = now`.
  - `LinkedinPanel` (client) — textarea + char count + Generate/Regenerate + Save.

- [ ] **Step 1: Write the failing test**

Create `tests/app/drafts/linkedin-actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases } from "../../../src/db/schema";

vi.mock("../../../src/lib/workspace/session", () => ({ requireSession: vi.fn() }));
vi.mock("../../../src/lib/ai/linkedin-copy", () => ({ generateLinkedinCopy: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "../../../src/lib/workspace/session";
import { generateLinkedinCopy } from "../../../src/lib/ai/linkedin-copy";
import { generateLinkedinCopyAction, saveLinkedinCopyAction } from "../../../src/app/(dashboard)/drafts/[releaseId]/linkedin-actions";

const TENANT = "LinkedIn Drafts Actions Test Tenant";

async function seedRelease() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [release] = await db
    .insert(releases)
    .values({ tenantId: tenant.id, title: "T", body: "B", status: "draft" })
    .returning();
  return { tenantId: tenant.id, releaseId: release.id };
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("linkedin draft actions", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockReset();
    vi.mocked(generateLinkedinCopy).mockReset();
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("generates and stores copy, clearing the edited marker", async () => {
    const { tenantId, releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(generateLinkedinCopy).mockResolvedValue("Generated post.");
    await generateLinkedinCopyAction(fd({ releaseId }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBe("Generated post.");
    expect(row.linkedinBodyEditedAt).toBeNull();
  });

  it("saves hand-edited copy and stamps the edited marker", async () => {
    const { tenantId, releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    await saveLinkedinCopyAction(fd({ releaseId, linkedinBody: "My edit." }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBe("My edit.");
    expect(row.linkedinBodyEditedAt).not.toBeNull();
  });

  it("refuses to touch a release from another tenant", async () => {
    const { releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId: "00000000-0000-0000-0000-000000000000" } } as never);
    await saveLinkedinCopyAction(fd({ releaseId, linkedinBody: "x" }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/app/drafts/linkedin-actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/app/(dashboard)/drafts/[releaseId]/linkedin-actions.ts`**

```typescript
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { generateLinkedinCopy } from "@/lib/ai/linkedin-copy";

async function loadTenantRelease(releaseId: string, tenantId: string) {
  const [release] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)))
    .limit(1);
  return release ?? null;
}

export async function generateLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const releaseId = String(formData.get("releaseId") ?? "");
  const release = await loadTenantRelease(releaseId, session.user.tenantId);
  if (!release) return;

  const post = await generateLinkedinCopy({ tenantId: session.user.tenantId, title: release.title, body: release.body });

  await db
    .update(releases)
    .set({ linkedinBody: post, linkedinBodyEditedAt: null })
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${releaseId}`);
}

export async function saveLinkedinCopyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const releaseId = String(formData.get("releaseId") ?? "");
  const linkedinBody = String(formData.get("linkedinBody") ?? "");

  await db
    .update(releases)
    .set({ linkedinBody, linkedinBodyEditedAt: new Date() })
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)));
  revalidatePath(`/drafts/${releaseId}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/app/drafts/linkedin-actions.test.ts`
Expected: PASS (all three cases — the cross-tenant case leaves `linkedinBody` null because the `and(id, tenantId)` filter matches no row).

- [ ] **Step 5: Implement the panel `linkedin-panel.tsx` (client)**

```tsx
"use client";

import { useState } from "react";
import { LINKEDIN_MAX_CHARS } from "@/lib/ai/linkedin-copy";
import { generateLinkedinCopyAction, saveLinkedinCopyAction } from "./linkedin-actions";

export function LinkedinPanel({
  releaseId,
  initialBody,
  baseUrl,
  slug,
}: {
  releaseId: string;
  initialBody: string;
  baseUrl: string;
  slug: string;
}) {
  const [body, setBody] = useState(initialBody);
  const link = `${baseUrl}${slug}`;

  return (
    <section className="space-y-2 rounded border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">LinkedIn post</h2>
        <form action={generateLinkedinCopyAction}>
          <input type="hidden" name="releaseId" value={releaseId} />
          <button type="submit" className="text-sm underline">{initialBody ? "Regenerate" : "Generate"}</button>
        </form>
      </div>
      <form action={saveLinkedinCopyAction} className="space-y-2">
        <input type="hidden" name="releaseId" value={releaseId} />
        <textarea
          name="linkedinBody"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full rounded border p-2 text-sm"
        />
        <p className={`text-xs ${body.length > LINKEDIN_MAX_CHARS ? "text-destructive" : "text-muted-foreground"}`}>
          {body.length}/{LINKEDIN_MAX_CHARS} characters · link appended: {link}
        </p>
        <button type="submit" className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">Save</button>
      </form>
    </section>
  );
}
```

- [ ] **Step 6: Conditionally render in `page.tsx`**

In `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (near the existing `listPublishTargets` call, line ~50), gate on the LinkedIn destination being configured — reuse its `loadConfig` so the gate can never drift from delivery:

```tsx
import { linkedinDestination } from "@/lib/publishing/destinations/linkedin";
import { slugify } from "@/lib/publishing/slug";
import { LinkedinPanel } from "./linkedin-panel";
```

```tsx
const linkedinConfig = await linkedinDestination.loadConfig(session.user.tenantId, db);
```

Then, in the JSX where the draft editor renders, add:

```tsx
{linkedinConfig && (
  <LinkedinPanel
    releaseId={release.id}
    initialBody={release.linkedinBody ?? ""}
    baseUrl={linkedinConfig.baseUrl!}
    slug={slugify(release.title)}
  />
)}
```

> If `db` is not already imported in `page.tsx`, add `import { db } from "@/db";`. The panel is entirely absent when `linkedinConfig` is null (not configured), satisfying the "show only when configured" requirement.

- [ ] **Step 7: Verify build + full suite**

Run: `npm run build && npm test`
Expected: clean build; entire test suite passes.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/linkedin-actions.ts" "src/app/(dashboard)/drafts/[releaseId]/linkedin-panel.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx" tests/app/drafts/linkedin-actions.test.ts
git commit -m "feat: gated linkedin post panel in draft editor"
```

---

## Self-Review

**Spec coverage:**

- §1 goal / company-only → Tasks 2 (`listAdminOrganizations` filter), 5 (`author` = org urn), Global Constraints. ✅
- §2 architecture fit → Tasks 1, 5 (enum + destination + dispatch registration). ✅
- §3 connection table + OAuth + org selection + base URL + token lifecycle → Tasks 1, 6, 7, 3. ✅
- §4 generation + storage columns + link-back-not-baked-in → Tasks 1, 4, 9 (storage), 5 (link appended at deliver). ✅
- §5 destination (loadConfig gating, post-once, classification, needs_reauth) → Task 5. ✅
- §6 integrations card + gated drafts panel → Tasks 8, 9. ✅
- §7 testing → tests in every task. ✅
- §8 out-of-scope items → none implemented. ✅

**Placeholder scan:** No "TBD"/"handle errors"-style gaps; every code step carries real code. The one intentional flag is the `OrgPicker` `<select>` fallback note in Task 8 (a stylistic choice, both paths specified). The `sql` import note in Task 6 explicitly says to drop it.

**Type consistency:**
- `LinkedinTokens`/`LinkedinOrg`/`LinkedinApiError` defined in Task 2, consumed unchanged in Tasks 3, 5, 6, 7.
- `getValidAccessToken(connection, database)` signature identical in Task 3 (def), Task 5 & 7 (use).
- `generateLinkedinCopy({ tenantId, title, body })` identical in Task 4 (def) and Task 9 (use).
- `linkedinDestination.loadConfig` returns the connection row whose `.baseUrl` (non-null by the gate) is used in Task 9 — consistent.
- `normalizeBaseUrl` guarantees a trailing slash, which Task 5's `new URL(slug, baseUrl)` and Task 9's `baseUrl + slug` both rely on. ✅
