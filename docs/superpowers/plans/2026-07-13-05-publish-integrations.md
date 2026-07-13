# Publish + Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose published `Update`s to the outside world — a per-tenant API-key-authenticated read endpoint, plus a signed outbound webhook fired on publish with a retry sweep — and give tenants an Integrations page to configure the one working delivery mechanism (Generic Webhook) alongside a "coming soon" catalog.

**Architecture:** Each tenant gets a hashed API key (`tenants.apiKeyHash`) for the headless read API (`GET /api/updates`, `Authorization: Bearer <key>`). On publish (Drafts queue's "Approve & publish"), a signed HMAC POST is attempted once, synchronously, against the tenant's `WebhookConfig` if one is active; the attempt is recorded as a `WebhookDelivery` row regardless of outcome. A retry sweep for failed deliveries piggybacks on the existing hourly scheduler cron tick rather than adding new job infrastructure — coarse hourly backoff, not precise exponential timing, which is an acceptable trade-off given the tick granularity already established in Plan 3.

**Tech Stack:** Node's built-in `crypto` (HMAC signing, API key hashing), no new dependencies.

## Global Constraints

- The read API and outbound webhook are the *only* functional delivery mechanisms in this MVP — the Integrations page's "coming soon" entries (Webflow, Customer.io, Mailchimp, HubSpot) remain static, unconfigurable list items with no backing table or delivery logic. (Design spec: "Integrations")
- API keys are stored hashed (SHA-256), never in plaintext, and are only ever shown to the user once, immediately after generation.
- **Known trade-off, documented not silently accepted:** the newly generated raw API key is passed through a redirect query param (`/settings?newApiKey=...`) to keep this plan free of client-side state, per Plan 4's "no client JS state" constraint. This means the raw key transiently appears in the URL and potentially server access logs. Acceptable for an internal-only MVP tenant; revisit (e.g. a client component with `useActionState` instead) before onboarding real external tenants.
- Outbound webhook delivery must never block or fail the publish action itself — a delivery failure is recorded, not thrown; the draft is still published either way.

---

### Task 1: Extend the schema — API key, `WebhookConfig`, `WebhookDelivery`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/publish-integrations-schema.test.ts`

**Interfaces:**
- Consumes: `tenants`, `updates` (Plans 1, 3).
- Produces: `tenants.apiKeyHash` column, `webhookConfigs`, `webhookDeliveries` tables + `webhookDeliveryStatusEnum`.

- [ ] **Step 1: Add the API key column and the new tables**

Modify `src/db/schema.ts`:

1. Update the `pg-core` import line to add `boolean`:
   ```typescript
   import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb, boolean } from "drizzle-orm/pg-core";
   ```
2. In the `tenants` table definition, add an `apiKeyHash` field:
   ```typescript
   export const tenants = pgTable("tenants", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     name: text("name").notNull(),
     apiKeyHash: text("api_key_hash"),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   });
   ```
3. Append to the end of the file:
   ```typescript
   export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", ["pending", "success", "failed"]);

   export const webhookConfigs = pgTable("webhook_configs", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     tenantId: uuid("tenant_id")
       .notNull()
       .unique()
       .references(() => tenants.id, { onDelete: "cascade" }),
     url: text("url").notNull(),
     secret: text("secret").notNull(),
     active: boolean("active").notNull().default(true),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   });

   export const webhookDeliveries = pgTable("webhook_deliveries", {
     id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
     updateId: uuid("update_id")
       .notNull()
       .references(() => updates.id, { onDelete: "cascade" }),
     webhookConfigId: uuid("webhook_config_id")
       .notNull()
       .references(() => webhookConfigs.id, { onDelete: "cascade" }),
     status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
     attempts: integer("attempts").notNull().default(0),
     lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   });
   ```

- [ ] **Step 2: Generate and apply the migration**

```bash
npm run db:generate
```
Expected: `2 tables` new (`webhook_configs`, `webhook_deliveries`) plus an `ALTER TABLE "tenants" ADD COLUMN "api_key_hash" text` — not a `tenants` table rebuild.

```bash
npm run db:migrate
```
Expected: no errors.

- [ ] **Step 3: Write a round-trip test**

Create `tests/db/publish-integrations-schema.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, updates, webhookConfigs, webhookDeliveries } from "../../src/db/schema";

describe("publish/integrations schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Publish Schema Test Tenant"));
  });

  it("stores an apiKeyHash on tenants and links a WebhookDelivery to a WebhookConfig and an Update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant", apiKeyHash: "abc" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();
    const [update] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, repoId: repo.id, title: "T", body: "B", category: "new", sourceItems: [] })
      .returning();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com", secret: "s3cr3t" })
      .returning();

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({ updateId: update.id, webhookConfigId: config.id })
      .returning();

    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(0);

    const [reloadedTenant] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
    expect(reloadedTenant.apiKeyHash).toBe("abc");
  });
});
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/db/publish-integrations-schema.test.ts
```
Expected: `Tests  1 passed (1)`.

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db
git commit -m "$(cat <<'EOF'
Add apiKeyHash to tenants, plus WebhookConfig and WebhookDelivery

Confirmed via generate/migrate as an incremental ALTER + two new
tables, not a tenants table rebuild.
EOF
)"
```

---

### Task 2: API key generation and lookup

**Files:**
- Create: `src/lib/api-key.ts`
- Test: `tests/lib/api-key.test.ts`

**Interfaces:**
- Consumes: `tenants` (Task 1).
- Produces: `generateApiKey()`, `hashApiKey(rawKey)`, `regenerateApiKey(tenantId, database?)`, `findTenantByApiKey(rawKey, database?)` — Task 3's read API and Task 5's Settings extension both use these.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/api-key.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants } from "../../src/db/schema";
import { generateApiKey, hashApiKey, regenerateApiKey, findTenantByApiKey } from "../../src/lib/api-key";

describe("api-key", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "API Key Test Tenant"));
  });

  it("generateApiKey returns a raw key whose hash matches hashApiKey", () => {
    const { rawKey, hash } = generateApiKey();
    expect(hash).toBe(hashApiKey(rawKey));
    expect(rawKey).not.toBe(hash);
    expect(rawKey.length).toBeGreaterThan(32);
  });

  it("regenerateApiKey stores the hash and findTenantByApiKey resolves the raw key back to the tenant", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "API Key Test Tenant" }).returning();

    const rawKey = await regenerateApiKey(tenant.id);

    const resolvedTenantId = await findTenantByApiKey(rawKey);
    expect(resolvedTenantId).toBe(tenant.id);
  });

  it("findTenantByApiKey returns null for an unknown key", async () => {
    expect(await findTenantByApiKey("not-a-real-key")).toBeNull();
  });

  it("regenerating invalidates the previous key", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "API Key Test Tenant" }).returning();

    const firstKey = await regenerateApiKey(tenant.id);
    const secondKey = await regenerateApiKey(tenant.id);

    expect(await findTenantByApiKey(firstKey)).toBeNull();
    expect(await findTenantByApiKey(secondKey)).toBe(tenant.id);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/api-key.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/api-key'`.

- [ ] **Step 3: Implement it**

Create `src/lib/api-key.ts`:
```typescript
import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { tenants } from "../db/schema";

export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey(): { rawKey: string; hash: string } {
  const rawKey = randomBytes(32).toString("hex");
  return { rawKey, hash: hashApiKey(rawKey) };
}

export async function regenerateApiKey(tenantId: string, database: typeof defaultDb = defaultDb): Promise<string> {
  const { rawKey, hash } = generateApiKey();
  await database.update(tenants).set({ apiKeyHash: hash }).where(eq(tenants.id, tenantId));
  return rawKey;
}

export async function findTenantByApiKey(
  rawKey: string,
  database: typeof defaultDb = defaultDb
): Promise<string | null> {
  const hash = hashApiKey(rawKey);
  const [tenant] = await database.select({ id: tenants.id }).from(tenants).where(eq(tenants.apiKeyHash, hash)).limit(1);
  return tenant?.id ?? null;
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/api-key.test.ts
```
Expected: `Tests  4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-key.ts tests/lib/api-key.test.ts
git commit -m "$(cat <<'EOF'
Add hashed API key generation and lookup for the publish read API
EOF
)"
```

---

### Task 3: Publish read API

**Files:**
- Create: `src/app/api/updates/route.ts`

**Interfaces:**
- Consumes: `findTenantByApiKey` (Task 2), `updates` (Plan 3).
- Produces: `GET /api/updates` (optionally `?repoId=`), the headless read endpoint described in the design spec's Overview.

- [ ] **Step 1: Implement the route**

Create `src/app/api/updates/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { findTenantByApiKey } from "@/lib/api-key";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!rawKey) {
    return NextResponse.json({ error: "missing API key" }, { status: 401 });
  }

  const tenantId = await findTenantByApiKey(rawKey);
  if (!tenantId) {
    return NextResponse.json({ error: "invalid API key" }, { status: 401 });
  }

  const repoId = request.nextUrl.searchParams.get("repoId");
  const conditions = repoId
    ? and(eq(updates.tenantId, tenantId), eq(updates.status, "published"), eq(updates.repoId, repoId))
    : and(eq(updates.tenantId, tenantId), eq(updates.status, "published"));

  const results = await db.select().from(updates).where(conditions);

  return NextResponse.json({ updates: results });
}
```

- [ ] **Step 2: Verify the app still builds**

```bash
npm run build
```
Expected: `✓ Compiled successfully`, now including `/api/updates`.

- [ ] **Step 3: Manually verify end to end**

Requires at least one `published` `Update` (from Plan 4's Drafts queue manual verification) and a real API key.

1. Generate a key for your tenant (Task 5 adds the UI for this — for now, call `regenerateApiKey` directly):
   ```bash
   docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "select id, name from tenants;"
   ```
   then, in a `node -e` one-liner or a scratch script using the running app's env, call `regenerateApiKey('<tenant-id>')` and note the printed raw key — or simply wait for Task 5 and use the Settings UI, then return to this step.
2. `curl -H "Authorization: Bearer <raw-key>" http://localhost:3000/api/updates`
   Expected: `{"updates":[...]}` containing only `published` updates for that tenant.
3. `curl http://localhost:3000/api/updates` (no header)
   Expected: `401 {"error":"missing API key"}`.
4. `curl -H "Authorization: Bearer wrong-key" http://localhost:3000/api/updates`
   Expected: `401 {"error":"invalid API key"}`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/updates
git commit -m "$(cat <<'EOF'
Add the headless publish read API (GET /api/updates)

Bearer-token authenticated via the per-tenant hashed API key; scoped
to published updates only, optionally filtered by repoId.
EOF
)"
```

---

### Task 4: Outbound webhook delivery + retry sweep

**Files:**
- Create: `src/lib/webhook-delivery.ts`
- Test: `tests/lib/webhook-delivery.test.ts`
- Modify: `src/app/(dashboard)/drafts/actions.ts`, `src/app/api/cron/scheduler/route.ts`

**Interfaces:**
- Consumes: `webhookConfigs`, `webhookDeliveries`, `updates` (Task 1, Plan 3).
- Produces: `dispatchWebhookForUpdate(updateId, database?)`, `retryFailedWebhookDeliveries(database?)` — `approveDraft` (Plan 4) calls the former; the cron route calls the latter.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/webhook-delivery.test.ts`:
```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, updates, webhookConfigs, webhookDeliveries } from "../../src/db/schema";
import { dispatchWebhookForUpdate, retryFailedWebhookDeliveries } from "../../src/lib/webhook-delivery";

describe("webhook-delivery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, "Webhook Delivery Test Tenant"));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: "Webhook Delivery Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", defaultBranch: "main" })
      .returning();
    const [update] = await db
      .insert(updates)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        title: "T",
        body: "B",
        category: "new",
        status: "published",
        sourceItems: [],
      })
      .returning();
    return { tenant, repo, update };
  }

  it("records a successful delivery and signs the payload", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchWebhookForUpdate(update.id);

    const [call] = vi.mocked(fetch).mock.calls;
    expect(call[0]).toBe("https://example.com/hook");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-product-announcer-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(1);
  });

  it("records a failed delivery without throwing when the endpoint errors", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" });

    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    await expect(dispatchWebhookForUpdate(update.id)).resolves.not.toThrow();

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("failed");
  });

  it("does nothing when the tenant has no active webhook config", async () => {
    const { update } = await seed();

    await dispatchWebhookForUpdate(update.id);

    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retryFailedWebhookDeliveries retries failed deliveries under the attempt cap", async () => {
    const { tenant, update } = await seed();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" })
      .returning();
    await db.insert(webhookDeliveries).values({
      updateId: update.id,
      webhookConfigId: config.id,
      status: "failed",
      attempts: 1,
    });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await retryFailedWebhookDeliveries();

    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
  });

  it("retryFailedWebhookDeliveries skips deliveries that already hit the attempt cap", async () => {
    const { tenant, update } = await seed();
    const [config] = await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s3cr3t" })
      .returning();
    await db.insert(webhookDeliveries).values({
      updateId: update.id,
      webhookConfigId: config.id,
      status: "failed",
      attempts: 3,
    });

    await retryFailedWebhookDeliveries();

    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/webhook-delivery.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/webhook-delivery'`.

- [ ] **Step 3: Implement it**

Create `src/lib/webhook-delivery.ts`:
```typescript
import { createHmac } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { webhookConfigs, webhookDeliveries, updates } from "../db/schema";

const MAX_ATTEMPTS = 3;

function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function buildPayload(update: typeof updates.$inferSelect) {
  return {
    id: update.id,
    tenantId: update.tenantId,
    title: update.title,
    body: update.body,
    category: update.category,
    status: update.status,
    sourceItems: update.sourceItems,
    createdAt: update.createdAt,
    publishedAt: update.publishedAt,
  };
}

async function attemptDelivery(url: string, secret: string, payload: object): Promise<boolean> {
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-product-announcer-signature": signPayload(secret, body),
      },
      body,
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function dispatchWebhookForUpdate(
  updateId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  const [update] = await database.select().from(updates).where(eq(updates.id, updateId)).limit(1);
  if (!update) return;

  const [config] = await database
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, update.tenantId), eq(webhookConfigs.active, true)))
    .limit(1);
  if (!config) return;

  const [delivery] = await database
    .insert(webhookDeliveries)
    .values({ updateId: update.id, webhookConfigId: config.id })
    .returning();

  const succeeded = await attemptDelivery(config.url, config.secret, buildPayload(update));

  await database
    .update(webhookDeliveries)
    .set({ status: succeeded ? "success" : "failed", attempts: 1, lastAttemptAt: new Date() })
    .where(eq(webhookDeliveries.id, delivery.id));
}

export async function retryFailedWebhookDeliveries(database: typeof defaultDb = defaultDb): Promise<void> {
  const failedDeliveries = await database
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "failed"), lt(webhookDeliveries.attempts, MAX_ATTEMPTS)));

  for (const delivery of failedDeliveries) {
    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(eq(webhookConfigs.id, delivery.webhookConfigId))
      .limit(1);
    const [update] = await database.select().from(updates).where(eq(updates.id, delivery.updateId)).limit(1);
    if (!config || !update) continue;

    const succeeded = await attemptDelivery(config.url, config.secret, buildPayload(update));

    await database
      .update(webhookDeliveries)
      .set({ status: succeeded ? "success" : "failed", attempts: delivery.attempts + 1, lastAttemptAt: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/webhook-delivery.test.ts
```
Expected: `Tests  5 passed (5)`.

- [ ] **Step 5: Wire delivery into publish**

Modify `src/app/(dashboard)/drafts/actions.ts` — add the import and update `approveDraft`:
```typescript
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { dispatchWebhookForUpdate } from "@/lib/webhook-delivery";

async function loadOwnedDraft(tenantId: string, updateId: string) {
  const [update] = await db.select().from(updates).where(and(eq(updates.id, updateId), eq(updates.tenantId, tenantId)));
  if (!update) throw new Error("Update not found for this tenant");
  return update;
}

export async function saveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db
    .update(updates)
    .set({
      title: formData.get("title") as string,
      body: formData.get("body") as string,
      category: formData.get("category") as "new" | "improved" | "fixed",
      editedBy: session.user.id,
    })
    .where(eq(updates.id, updateId));

  revalidatePath(`/drafts/${updateId}`);
}

export async function approveDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.update(updates).set({ status: "published", publishedAt: new Date() }).where(eq(updates.id, updateId));

  await dispatchWebhookForUpdate(updateId);

  revalidatePath("/drafts");
  redirect("/drafts");
}

export async function rejectDraft(formData: FormData) {
  const session = await requireSession();
  const updateId = formData.get("updateId") as string;
  await loadOwnedDraft(session.user.tenantId, updateId);

  await db.update(updates).set({ status: "rejected" }).where(eq(updates.id, updateId));

  revalidatePath("/drafts");
  redirect("/drafts");
}
```

- [ ] **Step 6: Wire the retry sweep into the existing cron route**

Modify `src/app/api/cron/scheduler/route.ts` (replace the entire file):
```typescript
import { NextRequest, NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/run-schedule";
import { retryFailedWebhookDeliveries } from "@/lib/webhook-delivery";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await runSchedulerTick(new Date());
  await retryFailedWebhookDeliveries();

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Verify the app still builds and the full test suite passes**

```bash
npm run build
npx vitest run
```
Expected: `✓ Compiled successfully`; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/lib/webhook-delivery.ts tests/lib/webhook-delivery.test.ts "src/app/(dashboard)/drafts/actions.ts" src/app/api/cron
git commit -m "$(cat <<'EOF'
Add outbound webhook delivery with HMAC signing and a retry sweep

approveDraft fires one synchronous delivery attempt on publish;
the hourly cron tick retries failed deliveries (up to 3 attempts),
reusing the existing scheduler cron rather than new job infra.
EOF
)"
```

---

### Task 5: Integrations page + Settings API key section

**Files:**
- Create: `src/app/(dashboard)/integrations/page.tsx`, `src/app/(dashboard)/integrations/actions.ts`
- Modify: `src/app/(dashboard)/settings/page.tsx`, `src/app/(dashboard)/settings/actions.ts`, `src/app/(dashboard)/layout.tsx`

**Interfaces:**
- Consumes: `webhookConfigs` (Task 1), `regenerateApiKey` (Task 2), `requireSession` (Plan 1).

- [ ] **Step 1: Implement the Integrations actions**

Create `src/app/(dashboard)/integrations/actions.ts`:
```typescript
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";

export async function saveWebhookConfig(formData: FormData) {
  const session = await requireSession();
  const url = formData.get("url") as string;
  const secret = formData.get("secret") as string;
  const active = formData.get("active") === "on";

  const [existing] = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, session.user.tenantId))
    .limit(1);

  if (existing) {
    await db.update(webhookConfigs).set({ url, secret, active }).where(eq(webhookConfigs.id, existing.id));
  } else {
    await db.insert(webhookConfigs).values({ tenantId: session.user.tenantId, url, secret, active });
  }

  revalidatePath("/integrations");
}
```

- [ ] **Step 2: Implement the Integrations page**

Create `src/app/(dashboard)/integrations/page.tsx`:
```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveWebhookConfig } from "./actions";

const COMING_SOON = ["Webflow", "Customer.io", "Mailchimp", "HubSpot"];

export default async function IntegrationsPage() {
  const session = await requireSession();
  const [config] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.tenantId, session.user.tenantId));

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-xl font-semibold mb-4">Integrations</h1>
        <div className="border p-4 max-w-lg space-y-3">
          <p className="font-medium">Generic Webhook</p>
          <form action={saveWebhookConfig} className="space-y-3">
            <label className="block">
              URL
              <input type="url" name="url" defaultValue={config?.url ?? ""} required className="block w-full border p-2" />
            </label>
            <label className="block">
              Secret
              <input type="text" name="secret" defaultValue={config?.secret ?? ""} required className="block w-full border p-2" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="active" defaultChecked={config?.active ?? true} />
              Active
            </label>
            <button type="submit" className="border px-4 py-2">
              Save
            </button>
          </form>
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-2">Coming soon</h2>
        <ul className="flex gap-3">
          {COMING_SOON.map((name) => (
            <li key={name} className="border px-3 py-2 opacity-50">
              {name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Add the Integrations nav link**

Modify `src/app/(dashboard)/layout.tsx` — add one line to the `<nav>`:
```tsx
      <nav className="flex gap-6 border-b p-4">
        <Link href="/pending">Pending</Link>
        <Link href="/drafts">Drafts</Link>
        <Link href="/history">History</Link>
        <Link href="/integrations">Integrations</Link>
        <Link href="/settings">Settings</Link>
      </nav>
```

- [ ] **Step 4: Add the API key action to Settings**

Modify `src/app/(dashboard)/settings/actions.ts` — add the import and the new action:
```typescript
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { brandProfiles, repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";
import { regenerateApiKey } from "@/lib/api-key";

function splitCsv(value: FormDataEntryValue | null): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function saveBrandProfile(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateBrandProfile(session.user.tenantId);

  await db
    .update(brandProfiles)
    .set({
      tone: (formData.get("tone") as string) || null,
      readingLevel: (formData.get("readingLevel") as string) || null,
      industry: (formData.get("industry") as string) || null,
      userPersonas: splitCsv(formData.get("userPersonas")),
      doList: splitCsv(formData.get("doList")),
      dontList: splitCsv(formData.get("dontList")),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/settings");
}

export async function saveRepoSchedule(formData: FormData) {
  const session = await requireSession();
  const repoId = formData.get("repoId") as string;

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    throw new Error("Repo not found for this tenant");
  }

  const cadence = formData.get("cadence") as Cadence;
  const thresholdRaw = formData.get("threshold");
  const threshold = thresholdRaw ? Number(thresholdRaw) : null;

  const [existing] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, repoId)).limit(1);
  const nextScheduledAt = cadence === "none" ? null : advanceNextScheduledAt(new Date(), cadence);

  if (existing) {
    await db
      .update(scheduleConfigs)
      .set({
        cadence,
        threshold,
        nextScheduledAt: cadence === existing.cadence ? existing.nextScheduledAt : nextScheduledAt,
      })
      .where(eq(scheduleConfigs.id, existing.id));
  } else {
    await db.insert(scheduleConfigs).values({ tenantId: session.user.tenantId, repoId, cadence, threshold, nextScheduledAt });
  }

  revalidatePath("/settings");
  revalidatePath("/pending");
}

export async function regenerateTenantApiKey() {
  const session = await requireSession();
  const rawKey = await regenerateApiKey(session.user.tenantId);
  redirect(`/settings?newApiKey=${rawKey}`);
}
```

- [ ] **Step 5: Add the API key section to the Settings page**

Modify `src/app/(dashboard)/settings/page.tsx` — add `searchParams`, the `tenants` import, and a new section:
```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { saveBrandProfile, saveRepoSchedule, regenerateTenantApiKey } from "./actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ newApiKey?: string }>;
}) {
  const session = await requireSession();
  const { newApiKey } = await searchParams;
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const tenantSchedules = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId));

  return (
    <div className="space-y-12">
      <section>
        <h1 className="text-xl font-semibold mb-4">Brand profile</h1>
        <form action={saveBrandProfile} className="space-y-3 max-w-lg">
          <label className="block">
            Tone
            <input type="text" name="tone" defaultValue={brandProfile.tone ?? ""} className="block w-full border p-2" />
          </label>
          <label className="block">
            Reading level
            <input
              type="text"
              name="readingLevel"
              defaultValue={brandProfile.readingLevel ?? ""}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Industry
            <input
              type="text"
              name="industry"
              defaultValue={brandProfile.industry ?? ""}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            User personas (comma-separated)
            <input
              type="text"
              name="userPersonas"
              defaultValue={brandProfile.userPersonas.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Do (comma-separated)
            <input
              type="text"
              name="doList"
              defaultValue={brandProfile.doList.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Don&apos;t (comma-separated)
            <input
              type="text"
              name="dontList"
              defaultValue={brandProfile.dontList.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <button type="submit" className="border px-4 py-2">
            Save
          </button>
        </form>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">Repos &amp; schedule</h1>
        <div className="space-y-4">
          {tenantRepos.map((repo) => {
            const config = tenantSchedules.find((s) => s.repoId === repo.id);
            return (
              <form key={repo.id} action={saveRepoSchedule} className="border p-4 space-y-2 max-w-md">
                <input type="hidden" name="repoId" value={repo.id} />
                <p className="font-medium">{repo.githubRepoFullName}</p>
                <label className="block">
                  Cadence
                  <select name="cadence" defaultValue={config?.cadence ?? "weekly"} className="block border p-2 w-full">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every 2 weeks</option>
                    <option value="monthly">Monthly</option>
                    <option value="none">No fixed cadence</option>
                  </select>
                </label>
                <label className="block">
                  Threshold
                  <input
                    type="number"
                    name="threshold"
                    min={1}
                    defaultValue={config?.threshold ?? 5}
                    className="block border p-2 w-full"
                  />
                </label>
                <button type="submit" className="border px-4 py-2">
                  Save
                </button>
              </form>
            );
          })}
        </div>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">API access</h1>
        {newApiKey && (
          <div className="border border-yellow-500 p-3 mb-3 max-w-lg">
            <p className="text-sm">Your new API key — copy it now, it won&apos;t be shown again:</p>
            <code className="block break-all">{newApiKey}</code>
          </div>
        )}
        <form action={regenerateTenantApiKey}>
          <button type="submit" className="border px-4 py-2">
            {tenant?.apiKeyHash ? "Regenerate API key" : "Generate API key"}
          </button>
        </form>
      </section>
    </div>
  );
}
```

- [ ] **Step 6: Verify the app still builds and the full test suite passes**

```bash
npm run build
npx vitest run
```
Expected: `✓ Compiled successfully`, now including `/integrations`; all tests pass.

- [ ] **Step 7: Manually verify end to end**

1. `npm run dev`, visit `/integrations`. Fill in a webhook URL (use a request-bin style test endpoint like `https://webhook.site/<your-id>`) and a secret, save.
2. Publish a draft from `/drafts`. Expected: the request-bin endpoint receives a signed POST within a few seconds; a `webhook_deliveries` row exists with `status = 'success'`.
3. Point the webhook URL at something unreachable (e.g. `https://localhost:9999/nope`), publish another draft. Expected: publish still succeeds (no error shown to the user), and the `webhook_deliveries` row for it has `status = 'failed'`, `attempts = 1`.
4. Manually trigger the cron route to simulate the next hourly tick and confirm the retry increments `attempts`:
   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET from .env.local>" http://localhost:3000/api/cron/scheduler
   ```
5. Visit `/settings`, click "Generate API key" (or "Regenerate"). Expected: redirected back to `/settings?newApiKey=...` showing the raw key once; confirm `GET /api/updates` with that key now works (Task 3's manual verification).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/integrations" "src/app/(dashboard)/settings" "src/app/(dashboard)/layout.tsx"
git commit -m "$(cat <<'EOF'
Add Integrations page and Settings API key section

Generic Webhook is the only configurable integration; Webflow,
Customer.io, Mailchimp, and HubSpot are static "coming soon" entries.
EOF
)"
```

---

## What's next

This completes the Product Announcer MVP across all 5 plans: tenant-scoped GitHub login and data layer (Plan 1), repo connection and PR/commit ingestion (Plan 2), scheduled and manual AI generation in the tenant's brand voice (Plan 3), a full click-through dashboard (Plan 4), and headless publishing via API key and signed webhook (Plan 5). Everything called out as a Non-goal in the original design spec — a public changelog page/widget, email/Slack delivery, ticket-tracker enrichment, real CMS integrations, billing enforcement, multi-language generation, and a live (as-you-type) draft preview — remains explicitly out of scope and undocumented as a "TODO," ready to become its own future spec when prioritized.
