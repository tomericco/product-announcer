# Publish + Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver published `Update`s to the outside world via a signed outbound webhook fired on publish, with a retry sweep — and give tenants an Integrations page to configure the one working delivery mechanism (Generic Webhook) alongside a "coming soon" catalog. There is no read/polling API in this MVP; webhook is the only delivery mechanism.

**Architecture:** On publish (Drafts queue's "Approve & publish"), a signed HMAC POST is attempted once, synchronously, against the tenant's `WebhookConfig` if one is active; the attempt is recorded as a `WebhookDelivery` row regardless of outcome. A retry sweep for failed deliveries piggybacks on the existing hourly scheduler cron tick rather than adding new job infrastructure — coarse hourly backoff, not precise exponential timing, which is an acceptable trade-off given the tick granularity already established in Plan 3.

**Tech Stack:** Node's built-in `crypto` (HMAC signing), no new dependencies.

## Global Constraints

- Generic Webhook is the *only* functional delivery mechanism in this MVP — the Integrations page's "coming soon" entries (Webflow, Customer.io, Mailchimp, HubSpot, LinkedIn) remain static, unconfigurable list items with no backing table or delivery logic. (Design spec: "Integrations")
- There is no read/polling API in this MVP, and none should be added in this plan — a tenant with no webhook configured simply gets no outbound delivery; the `Update` still exists and is visible in History. (Design spec: Overview, Non-goals)
- Outbound webhook delivery must never block or fail the publish action itself — a delivery failure is recorded, not thrown; the draft is still published either way.

---

### Task 1: Extend the schema — `WebhookConfig`, `WebhookDelivery`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/publish-integrations-schema.test.ts`

**Interfaces:**
- Consumes: `tenants`, `updates` (Plans 1, 3).
- Produces: `webhookConfigs`, `webhookDeliveries` tables + `webhookDeliveryStatusEnum`.

- [ ] **Step 1: Add the new tables**

Modify `src/db/schema.ts`:

1. Update the `pg-core` import line to add `boolean`:
   ```typescript
   import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb, boolean } from "drizzle-orm/pg-core";
   ```
2. Append to the end of the file:
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
Expected: `2 tables` new (`webhook_configs`, `webhook_deliveries`) — no changes to any existing table.

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

  it("links a WebhookDelivery to a WebhookConfig and an Update", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Publish Schema Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
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
Add WebhookConfig and WebhookDelivery tables

No read/polling API in this MVP — webhook is the only delivery
mechanism, so no API-key infrastructure is added here either.
EOF
)"
```

---

### Task 2: Outbound webhook delivery + retry sweep

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
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
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

### Task 3: Integrations page

**Files:**
- Create: `src/app/(dashboard)/integrations/page.tsx`, `src/app/(dashboard)/integrations/actions.ts`
- Modify: `src/app/(dashboard)/layout.tsx`

**Interfaces:**
- Consumes: `webhookConfigs` (Task 1), `requireSession` (Plan 1).

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

const COMING_SOON = ["Webflow", "Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];

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

Modify `src/app/(dashboard)/layout.tsx` — add one `Link` to the sidebar `<nav>` (matching Plan 4's bare grayscale sidebar shell, not a top nav bar):
```tsx
        <nav className="mt-4 flex flex-col gap-1">
          <Link href="/pending" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Pending
          </Link>
          <Link href="/drafts" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Drafts
          </Link>
          <Link href="/history" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            History
          </Link>
          <Link href="/integrations" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Integrations
          </Link>
          <Link href="/settings" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Settings
          </Link>
        </nav>
```

- [ ] **Step 4: Verify the app still builds and the full test suite passes**

```bash
npm run build
npx vitest run
```
Expected: `✓ Compiled successfully`, now including `/integrations`; all tests pass.

- [ ] **Step 5: Manually verify end to end**

1. `npm run dev`, visit `/integrations`. Fill in a webhook URL (use a request-bin style test endpoint like `https://webhook.site/<your-id>`) and a secret, save.
2. Publish a draft from `/drafts`. Expected: the request-bin endpoint receives a signed POST within a few seconds; a `webhook_deliveries` row exists with `status = 'success'`.
3. Point the webhook URL at something unreachable (e.g. `https://localhost:9999/nope`), publish another draft. Expected: publish still succeeds (no error shown to the user), and the `webhook_deliveries` row for it has `status = 'failed'`, `attempts = 1`.
4. Manually trigger the cron route to simulate the next hourly tick and confirm the retry increments `attempts`:
   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET from .env.local>" http://localhost:3000/api/cron/scheduler
   ```

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/integrations" "src/app/(dashboard)/layout.tsx"
git commit -m "$(cat <<'EOF'
Add Integrations page

Generic Webhook is the only configurable integration; Webflow,
Customer.io, Mailchimp, HubSpot, and LinkedIn are static "coming soon"
entries. No read/polling API — webhook is the only way updates leave
the system.
EOF
)"
```

---

## What's next

This completes the Product Announcer MVP across all 5 plans: tenant-scoped GitHub login and data layer (Plan 1), multi-repo/branch connection and PR/commit ingestion (Plan 2), scheduled and manual AI generation in the tenant's brand voice (Plan 3), a full click-through dashboard with skippable onboarding (Plan 4), and headless publishing via signed webhook only (Plan 5). Everything called out as a Non-goal in the design spec — a public changelog page/widget, email/Slack delivery, ticket-tracker enrichment, real CMS integrations, billing enforcement, multi-language generation, a live (as-you-type) draft preview, and a read/polling API — remains explicitly out of scope, ready to become its own future spec when prioritized.
