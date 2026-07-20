# Webflow CMS Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace connect its Webflow site and publish an approved update directly into a CMS collection as a mapped, correctly-formatted item.

**Architecture:** Extract the hardcoded webhook publisher into a `Destination` interface, add Webflow as the second implementation, and introduce the encrypted credential storage the codebase currently lacks. Webflow auth is a pasted Site Token in v1 behind an `authType` column that OAuth later fills in without touching the delivery layer.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, NextAuth v4 (JWT), Vitest against a real test database, Node built-in `crypto`, `marked` for Markdown parsing.

## Global Constraints

- **Delivery must never throw into the publish path.** An update is already published when delivery runs; a destination failure is recorded and swallowed, never propagated. This includes DB errors, not just network errors.
- **No queue.** Retries run in the existing hourly Vercel cron (`/api/cron/scheduler`). `MAX_ATTEMPTS = 3`.
- **Never call `POST /v2/sites/{site_id}/publish`.** It deploys the customer's unrelated staged Designer changes. Use per-item endpoints only.
- **No refresh-token logic.** Webflow issues none. A `401` marks the connection `needs_reauth` and stops; it is never retried.
- **Tests run against a real Postgres test database** (see `tests/lib/publishing/webhook-delivery.test.ts` for the pattern: seed a uniquely-named tenant, clean it up in `afterEach`). `fetch` is stubbed with `vi.stubGlobal`.
- **Every table carries `tenantId` with `onDelete: "cascade"`**, and every query filters on it explicitly. There is no RLS.
- Verification commands: `npm test`, `npm run typecheck`, `npm run lint`.
- Migrations: `npm run db:generate`, then `npm run db:migrate` and `npm run db:migrate:test`.

**Spec:** `docs/superpowers/specs/2026-07-20-webflow-cms-publishing-design.md`

**Deliberate deviation from the spec:** the spec puts the Webflow CMS item id on `updates.webflowItemId`. This plan stores it as `delivery_attempts.externalId` instead. Same behavior, but it generalizes to any future destination and keeps per-destination state out of the `updates` table. Nothing else in the spec changes.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/lib/credentials/encryption.ts` | AES-256-GCM encrypt/decrypt. The only module that touches ciphertext. |
| `src/lib/publishing/destinations/types.ts` | `Destination`, `DeliveryResult` types. |
| `src/lib/publishing/destinations/webhook.ts` | Existing webhook logic, moved. |
| `src/lib/publishing/destinations/webflow.ts` | Webflow delivery: create/patch, error mapping. |
| `src/lib/publishing/dispatch.ts` | `dispatchAllDestinations`, `retryFailedDeliveries`. |
| `src/lib/publishing/markdown-to-html.ts` | Markdown → Webflow-safe HTML. |
| `src/lib/publishing/slug.ts` | Slug generation and collision suffixing. |
| `src/lib/integrations/webflow/client.ts` | Typed Webflow Data API v2 calls. |
| `src/lib/integrations/webflow/mapping.ts` | Field mapping → `fieldData`; required-field validation. |
| `src/app/(dashboard)/integrations/webflow-form.tsx` | Connect + mapping UI. |

**Modified:** `src/db/schema.ts`, `src/app/(dashboard)/integrations/page.tsx`, `src/app/(dashboard)/integrations/actions.ts`, `src/app/(dashboard)/drafts/actions.ts`, `src/lib/scheduling/run-schedule.ts`, `src/app/api/cron/scheduler/route.ts`.

**Deleted:** `src/lib/publishing/webhook-delivery.ts` (contents move to `destinations/webhook.ts` + `dispatch.ts`).

---

## Task 1: Credential encryption

**Files:**
- Create: `src/lib/credentials/encryption.ts`
- Test: `tests/lib/credentials/encryption.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string): { ciphertext: string; iv: string; authTag: string }` and `decryptSecret(parts: { ciphertext: string; iv: string; authTag: string }): string`. All values hex-encoded. Both throw on a missing/malformed key; `decryptSecret` throws on tampering.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/credentials/encryption.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptSecret, decryptSecret } from "../../../src/lib/credentials/encryption";

const KEY = "a".repeat(64); // 32 bytes hex

describe("credentials/encryption", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = KEY;
  });

  afterEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = original;
  });

  it("round-trips a secret", () => {
    const parts = encryptSecret("wf-token-123");
    expect(decryptSecret(parts)).toBe("wf-token-123");
  });

  it("does not store the plaintext in the ciphertext", () => {
    const parts = encryptSecret("wf-token-123");
    expect(parts.ciphertext).not.toContain("wf-token-123");
  });

  it("produces a different iv per call", () => {
    expect(encryptSecret("same").iv).not.toBe(encryptSecret("same").iv);
  });

  it("throws when the ciphertext has been tampered with", () => {
    const parts = encryptSecret("wf-token-123");
    const flipped = parts.ciphertext.startsWith("a") ? "b" : "a";
    const tampered = { ...parts, ciphertext: flipped + parts.ciphertext.slice(1) };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("throws when the key is not 32 bytes", () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "abcd";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/credentials/encryption.test.ts`
Expected: FAIL — cannot resolve `src/lib/credentials/encryption`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/credentials/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
};

// Read the key per-call rather than at module load: tests swap it between
// cases, and a module-level read would freeze the first value.
function getKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

export function decryptSecret(parts: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(parts.iv, "hex"));
  decipher.setAuthTag(Buffer.from(parts.authTag, "hex"));
  // GCM verifies the auth tag on final(); tampering throws here rather than
  // returning garbage. Deliberately not caught — a decrypt failure must be loud.
  return Buffer.concat([decipher.update(Buffer.from(parts.ciphertext, "hex")), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lib/credentials/encryption.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Document the env var**

Add to `.env.example`:

```
# 32 bytes, hex encoded. Generate with: openssl rand -hex 32
CREDENTIALS_ENCRYPTION_KEY=
```

Generate a real value for `.env.local` and the test env with `openssl rand -hex 32`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/credentials/encryption.ts tests/lib/credentials/encryption.test.ts .env.example
git commit -m "feat: add AES-256-GCM credential encryption"
```

---

## Task 2: Encrypt the existing webhook secret

Closes the plaintext-secret gap before adding a second secret-bearing integration.

**Files:**
- Modify: `src/db/schema.ts:204-214`, `src/app/(dashboard)/integrations/actions.ts`, `src/app/(dashboard)/integrations/page.tsx:35`
- Create: migration via `npm run db:generate`
- Test: `tests/lib/publishing/webhook-delivery.test.ts` (update seeds)

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret` from Task 1.
- Produces: `webhookConfigs` columns `secretCiphertext`, `secretIv`, `secretAuthTag` (all `text().notNull()`); the `secret` column is gone.

- [ ] **Step 1: Change the schema**

In `src/db/schema.ts`, replace the `secret` line in `webhookConfigs`:

```ts
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretIv: text("secret_iv").notNull(),
  secretAuthTag: text("secret_auth_tag").notNull(),
  active: boolean("active").notNull().default(true),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`

Open the generated file in `src/db/migrations/`. Drizzle will emit a drop of `secret` and three adds. Replace the generated body so existing rows survive — `NOT NULL` columns cannot be added to a non-empty table without a default:

```sql
ALTER TABLE "webhook_configs" ADD COLUMN "secret_ciphertext" text;
ALTER TABLE "webhook_configs" ADD COLUMN "secret_iv" text;
ALTER TABLE "webhook_configs" ADD COLUMN "secret_auth_tag" text;

-- Existing plaintext secrets cannot be encrypted from SQL, and the columns are
-- about to become NOT NULL. Drop those rows; the owner re-enters the secret.
DELETE FROM "webhook_configs" WHERE "secret_ciphertext" IS NULL;

ALTER TABLE "webhook_configs" ALTER COLUMN "secret_ciphertext" SET NOT NULL;
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_iv" SET NOT NULL;
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_auth_tag" SET NOT NULL;
ALTER TABLE "webhook_configs" DROP COLUMN "secret";
```

The `DELETE` is safe here because webhook configs are a small, easily re-entered per-tenant setting. Confirm with the repo owner before running against production data.

- [ ] **Step 3: Apply migrations**

```bash
npm run db:migrate && npm run db:migrate:test
```

- [ ] **Step 4: Update the server action to encrypt**

Rewrite `saveWebhookConfig` in `src/app/(dashboard)/integrations/actions.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";

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

  // The form is write-only: an empty secret on an existing config means
  // "leave it alone", not "set it to empty".
  const encrypted = secret ? encryptSecret(secret) : null;

  if (existing) {
    await db
      .update(webhookConfigs)
      .set({
        url,
        active,
        ...(encrypted
          ? {
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
            }
          : {}),
      })
      .where(eq(webhookConfigs.id, existing.id));
  } else {
    if (!encrypted) throw new Error("A secret is required to create a webhook config");
    await db.insert(webhookConfigs).values({
      tenantId: session.user.tenantId,
      url,
      active,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
    });
  }

  revalidatePath("/integrations");
}
```

- [ ] **Step 5: Make the secret field write-only in the UI**

In `src/app/(dashboard)/integrations/page.tsx`, replace the secret input block:

```tsx
              <div className="space-y-2">
                <Label htmlFor="secret">Secret</Label>
                <Input
                  id="secret"
                  type="password"
                  name="secret"
                  placeholder={config ? "Saved — leave blank to keep" : ""}
                  required={!config}
                />
              </div>
```

- [ ] **Step 6: Update the delivery code to decrypt**

In `src/lib/publishing/webhook-delivery.ts`, add the import and change both `attemptDelivery` call sites (lines 74 and 106) to decrypt first:

```ts
import { decryptSecret } from "@/lib/credentials/encryption";

function configSecret(config: typeof webhookConfigs.$inferSelect): string {
  return decryptSecret({
    ciphertext: config.secretCiphertext,
    iv: config.secretIv,
    authTag: config.secretAuthTag,
  });
}
```

Then replace `config.secret` with `configSecret(config)` in both calls.

- [ ] **Step 7: Update the existing tests**

In `tests/lib/publishing/webhook-delivery.test.ts`, every `db.insert(webhookConfigs).values({...})` currently passes `secret: "s3cr3t"`. Add at the top of the file:

```ts
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const SECRET = "s3cr3t";
const encryptedSecret = () => {
  const p = encryptSecret(SECRET);
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};
```

Replace each `secret: "s3cr3t"` with `...encryptedSecret()`. The HMAC assertions still verify against the plaintext `SECRET`, so they should pass unchanged — that is the point of the test.

Ensure `CREDENTIALS_ENCRYPTION_KEY` is set in the test environment (`.env.test` or wherever the existing test DB URL lives).

- [ ] **Step 8: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: PASS. The webhook signature tests passing unchanged is the signal that encryption is transparent to delivery.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: encrypt webhook secrets at rest"
```

---

## Task 3: Destination abstraction

Pure refactor — no behavior change. Existing webhook tests must pass with only import-path edits.

**Files:**
- Create: `src/lib/publishing/destinations/types.ts`, `src/lib/publishing/destinations/webhook.ts`, `src/lib/publishing/dispatch.ts`
- Delete: `src/lib/publishing/webhook-delivery.ts`
- Modify: `src/db/schema.ts`, `src/app/(dashboard)/drafts/actions.ts:9,69,106`, `src/lib/scheduling/run-schedule.ts:10,104`, `src/app/api/cron/scheduler/route.ts:3,12`
- Test: rename `tests/lib/publishing/webhook-delivery.test.ts` → `tests/lib/publishing/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `type DeliveryResult = { status: "ok"; externalId?: string } | { status: "retryable"; error: string } | { status: "permanent"; error: string }`
  - `interface Destination<TConfig> { id: DestinationId; loadConfig(tenantId, db): Promise<TConfig | null>; deliver(update, config): Promise<DeliveryResult> }`
  - `type DestinationId = "webhook" | "webflow"`
  - `dispatchAllDestinations(updateId: string, database?): Promise<void>`
  - `retryFailedDeliveries(database?): Promise<void>`
  - `deliveryAttempts` table.

- [ ] **Step 1: Add the `delivery_attempts` table to the schema**

In `src/db/schema.ts`, after `webhookDeliveries`:

```ts
export const destinationEnum = pgEnum("destination", ["webhook", "webflow"]);

export const deliveryAttempts = pgTable("delivery_attempts", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  updateId: uuid("update_id")
    .notNull()
    .references(() => updates.id, { onDelete: "cascade" }),
  destination: destinationEnum("destination").notNull(),
  status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  // Last error, surfaced in the UI. Null on success.
  lastError: text("last_error"),
  // Destination-side identifier, e.g. the Webflow CMS item id, so a
  // re-publish updates instead of duplicating.
  externalId: text("external_id"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Delete the `webhookDeliveries` table definition.

- [ ] **Step 2: Generate and edit the migration**

Run: `npm run db:generate`

In the generated SQL, add a data copy before the drop of `webhook_deliveries`:

```sql
INSERT INTO "delivery_attempts" ("update_id", "destination", "status", "attempts", "last_attempt_at", "created_at")
SELECT "update_id", 'webhook', "status", "attempts", "last_attempt_at", "created_at" FROM "webhook_deliveries";

DROP TABLE "webhook_deliveries";
```

Then: `npm run db:migrate && npm run db:migrate:test`

- [ ] **Step 3: Write the types**

```ts
// src/lib/publishing/destinations/types.ts
import type { db as defaultDb } from "@/db";
import type { updates } from "@/db/schema";

export type DestinationId = "webhook" | "webflow";

export type Update = typeof updates.$inferSelect;

export type DeliveryResult =
  // `externalId` is stored so a later re-publish can update rather than duplicate.
  | { status: "ok"; externalId?: string }
  // Worth another attempt in the cron sweep: network, 429, 5xx.
  | { status: "retryable"; error: string }
  // Retrying cannot help: bad credentials, validation failure, empty body.
  | { status: "permanent"; error: string };

export interface Destination<TConfig> {
  id: DestinationId;
  loadConfig(tenantId: string, database: typeof defaultDb): Promise<TConfig | null>;
  deliver(update: Update, config: TConfig, externalId: string | null): Promise<DeliveryResult>;
}
```

- [ ] **Step 4: Move the webhook logic**

Create `src/lib/publishing/destinations/webhook.ts` containing `signPayload`, `buildPayload`, `attemptDelivery`, `configSecret`, and `DELIVERY_TIMEOUT_MS` copied verbatim from `webhook-delivery.ts`, wrapped in a `Destination`:

```ts
// src/lib/publishing/destinations/webhook.ts
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { decryptSecret } from "@/lib/credentials/encryption";
import type { Destination, DeliveryResult, Update } from "./types";

const DELIVERY_TIMEOUT_MS = 5000;

type WebhookConfig = typeof webhookConfigs.$inferSelect;

function signPayload(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function buildPayload(update: Update) {
  return {
    id: update.id,
    tenantId: update.tenantId,
    title: update.title,
    body: update.body,
    status: update.status,
    sourceItems: update.sourceItems,
    createdAt: update.createdAt,
    publishedAt: update.publishedAt,
  };
}

export const webhookDestination: Destination<WebhookConfig> = {
  id: "webhook",

  async loadConfig(tenantId, database: typeof defaultDb) {
    const [config] = await database
      .select()
      .from(webhookConfigs)
      .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
      .limit(1);
    return config ?? null;
  },

  async deliver(update, config): Promise<DeliveryResult> {
    const body = JSON.stringify(buildPayload(update));
    const secret = decryptSecret({
      ciphertext: config.secretCiphertext,
      iv: config.secretIv,
      authTag: config.secretAuthTag,
    });
    try {
      // Bound the request: delivery runs synchronously inside the publish action
      // (and sequentially inside the cron sweep), so a slow/hanging tenant
      // endpoint must not block either.
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-product-announcer-signature": signPayload(secret, body),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      // Preserves prior behavior: any non-2xx is simply "failed" and retried.
      return response.ok ? { status: "ok" } : { status: "retryable", error: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
    }
  },
};
```

- [ ] **Step 5: Write the dispatcher**

```ts
// src/lib/publishing/dispatch.ts
import { and, eq, lt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { deliveryAttempts, updates } from "@/db/schema";
import { webhookDestination } from "./destinations/webhook";
import type { Destination, DeliveryResult } from "./destinations/types";

const MAX_ATTEMPTS = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DESTINATIONS: Destination<any>[] = [webhookDestination];

function statusFor(result: DeliveryResult) {
  if (result.status === "ok") return "success" as const;
  // A permanent failure is recorded as failed with attempts maxed out, so the
  // retry sweep skips it without needing a fourth status value.
  return "failed" as const;
}

export async function dispatchAllDestinations(
  updateId: string,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  // Runs AFTER the update is already published. Nothing here may throw — not the
  // network call, not the DB writes — or it 500s an action that already succeeded.
  try {
    const [update] = await database.select().from(updates).where(eq(updates.id, updateId)).limit(1);
    if (!update) return;

    for (const destination of DESTINATIONS) {
      try {
        const config = await destination.loadConfig(update.tenantId, database);
        if (!config) continue;

        // Reuse the prior attempt row for this update+destination so a
        // re-publish updates the existing external item rather than duplicating.
        const [existing] = await database
          .select()
          .from(deliveryAttempts)
          .where(
            and(eq(deliveryAttempts.updateId, update.id), eq(deliveryAttempts.destination, destination.id))
          )
          .limit(1);

        const attempt =
          existing ??
          (
            await database
              .insert(deliveryAttempts)
              .values({ updateId: update.id, destination: destination.id })
              .returning()
          )[0];

        const result = await destination.deliver(update, config, attempt.externalId);

        await database
          .update(deliveryAttempts)
          .set({
            status: statusFor(result),
            attempts: result.status === "permanent" ? MAX_ATTEMPTS : attempt.attempts + 1,
            lastError: result.status === "ok" ? null : result.error,
            externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
            lastAttemptAt: new Date(),
          })
          .where(eq(deliveryAttempts.id, attempt.id));
      } catch (error) {
        console.error(`Dispatch to ${destination.id} failed for update ${updateId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Dispatch failed for update ${updateId}:`, error);
  }
}

export async function retryFailedDeliveries(database: typeof defaultDb = defaultDb): Promise<void> {
  const failed = await database
    .select()
    .from(deliveryAttempts)
    .where(and(eq(deliveryAttempts.status, "failed"), lt(deliveryAttempts.attempts, MAX_ATTEMPTS)));

  for (const attempt of failed) {
    // Isolate each attempt: one bad row must not abort the sweep and starve the
    // rest for a full hour until the next tick.
    try {
      const destination = DESTINATIONS.find((d) => d.id === attempt.destination);
      if (!destination) continue;

      const [update] = await database.select().from(updates).where(eq(updates.id, attempt.updateId)).limit(1);
      if (!update) continue;

      const config = await destination.loadConfig(update.tenantId, database);
      // Skip if the config was deactivated or removed since the original attempt.
      if (!config) continue;

      const result = await destination.deliver(update, config, attempt.externalId);

      await database
        .update(deliveryAttempts)
        .set({
          status: statusFor(result),
          attempts: result.status === "permanent" ? MAX_ATTEMPTS : attempt.attempts + 1,
          lastError: result.status === "ok" ? null : result.error,
          externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
          lastAttemptAt: new Date(),
        })
        .where(eq(deliveryAttempts.id, attempt.id));
    } catch (error) {
      console.error(`Retry failed for delivery attempt ${attempt.id}:`, error);
    }
  }
}
```

- [ ] **Step 6: Update the four call sites and delete the old file**

- `src/app/(dashboard)/drafts/actions.ts:9` → `import { dispatchAllDestinations } from "@/lib/publishing/dispatch";`; lines 69 and 106 → `await dispatchAllDestinations(updateId);`
- `src/lib/scheduling/run-schedule.ts:10` → same import; line 104 → `await dispatchAllDestinations(update.id, database);`
- `src/app/api/cron/scheduler/route.ts:3` → `import { retryFailedDeliveries } from "@/lib/publishing/dispatch";`; line 12 → `await retryFailedDeliveries();`
- `rm src/lib/publishing/webhook-delivery.ts`

- [ ] **Step 7: Update the tests**

```bash
git mv tests/lib/publishing/webhook-delivery.test.ts tests/lib/publishing/dispatch.test.ts
```

In that file: import `dispatchAllDestinations, retryFailedDeliveries` from `../../../src/lib/publishing/dispatch`, swap `webhookDeliveries` → `deliveryAttempts` in imports and queries, and rename the calls. Every assertion about signing, status transitions, attempt counts, and the deactivated-config skip stays as written — unchanged assertions passing is the proof this refactor is behavior-preserving.

- [ ] **Step 8: Verify**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS, with no test *assertions* modified in this task.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract destination abstraction from webhook delivery"
```

---

## Task 4: Webflow schema

**Files:**
- Modify: `src/db/schema.ts`
- Create: migration

**Interfaces:**
- Produces: `webflowConnections` table and the `WebflowFieldMapping` type.

- [ ] **Step 1: Add types and table**

In `src/db/schema.ts`:

```ts
export const webflowAuthTypeEnum = pgEnum("webflow_auth_type", ["site_token", "oauth"]);
export const webflowPublishModeEnum = pgEnum("webflow_publish_mode", ["draft", "live"]);
export const webflowConnectionStatusEnum = pgEnum("webflow_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);

// Keyed by Webflow field *slug*, not id, so renaming a field's display name in
// Webflow does not break the mapping.
export type WebflowFieldMapping = Record<
  string,
  | { source: "title" | "body" | "slug" | "publishedAt" | "empty" }
  | { source: "static"; value: string }
>;

export const webflowConnections = pgTable("webflow_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  authType: webflowAuthTypeEnum("auth_type").notNull().default("site_token"),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenAuthTag: text("token_auth_tag").notNull(),
  // Null until the user completes the corresponding wizard step.
  siteId: text("site_id"),
  siteName: text("site_name"),
  collectionId: text("collection_id"),
  collectionName: text("collection_name"),
  fieldMapping: jsonb("field_mapping").$type<WebflowFieldMapping>().notNull().default({}),
  publishMode: webflowPublishModeEnum("publish_mode").notNull().default("draft"),
  status: webflowConnectionStatusEnum("status").notNull().default("active"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate and apply**

```bash
npm run db:generate && npm run db:migrate && npm run db:migrate:test
```

- [ ] **Step 3: Verify and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: add webflow_connections schema"
```

---

## Task 5: Markdown → Webflow-safe HTML

**Files:**
- Create: `src/lib/publishing/markdown-to-html.ts`
- Test: `tests/lib/publishing/markdown-to-html.test.ts`

**Interfaces:**
- Produces: `markdownToWebflowHtml(markdown: string): string` and `containsCodeBlock(markdown: string): boolean`.

- [ ] **Step 1: Install the parser**

```bash
npm install marked
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/lib/publishing/markdown-to-html.test.ts
import { describe, it, expect } from "vitest";
import { markdownToWebflowHtml, containsCodeBlock } from "../../../src/lib/publishing/markdown-to-html";

describe("markdownToWebflowHtml", () => {
  it("converts headings and paragraphs", () => {
    const html = markdownToWebflowHtml("# Title\n\nSome text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some text.</p>");
  });

  it("converts emphasis, lists and links", () => {
    const html = markdownToWebflowHtml("- **bold** and *italic*\n- [link](https://x.com)");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://x.com">link</a>');
  });

  it("downgrades fenced code to paragraph text instead of emitting <pre>", () => {
    // Webflow's Rich Text field turns <pre>/<code> into an empty string, so the
    // content would silently vanish.
    const html = markdownToWebflowHtml("```js\nconst a = 1;\nconst b = 2;\n```");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<code");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("const b = 2;");
    expect(html).toContain("<br>");
  });

  it("downgrades inline code to plain text", () => {
    const html = markdownToWebflowHtml("Use `npm test` now.");
    expect(html).not.toContain("<code");
    expect(html).toContain("npm test");
  });

  it("escapes HTML entities in code content", () => {
    const html = markdownToWebflowHtml("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("strips raw HTML that Webflow would drop anyway", () => {
    const html = markdownToWebflowHtml('<div class="x">hi</div>\n\nAfter.');
    expect(html).not.toContain("<div");
    expect(html).toContain("After.");
  });

  it("preserves images as external URLs", () => {
    const html = markdownToWebflowHtml("![alt text](https://cdn.example.com/a.png)");
    expect(html).toContain('src="https://cdn.example.com/a.png"');
    expect(html).toContain('alt="alt text"');
  });

  it("returns an empty string for empty input", () => {
    expect(markdownToWebflowHtml("")).toBe("");
    expect(markdownToWebflowHtml("   \n  ")).toBe("");
  });
});

describe("containsCodeBlock", () => {
  it("detects fenced code", () => {
    expect(containsCodeBlock("text\n\n```js\nx\n```")).toBe(true);
  });

  it("detects indented code blocks", () => {
    expect(containsCodeBlock("text\n\n    indented code\n")).toBe(true);
  });

  it("is false for prose with inline code", () => {
    expect(containsCodeBlock("just `inline` prose")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/lib/publishing/markdown-to-html.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/lib/publishing/markdown-to-html.ts
import { Marked, type Tokens } from "marked";

// Webflow's Rich Text field sanitizes incoming HTML down to the tags its editor
// supports. Anything else is silently dropped, so we emit only this set rather
// than letting content disappear without a trace:
//   h1-h6, p, strong, em, u, s, a, ul, ol, li, blockquote, br, img
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildRenderer() {
  const marked = new Marked({ gfm: true, breaks: false });

  marked.use({
    renderer: {
      // Webflow renders <pre>/<code> as an empty string. Downgrade to a
      // paragraph with hard breaks so the content survives, approximately.
      code(this: unknown, token: Tokens.Code) {
        const lines = token.text.split("\n").map(escapeHtml).join("<br>");
        return `<p>${lines}</p>\n`;
      },
      codespan(this: unknown, token: Tokens.Codespan) {
        return escapeHtml(token.text);
      },
      // Raw HTML in the source would be stripped by Webflow anyway; drop it here
      // so what we send matches what gets stored.
      html() {
        return "";
      },
    },
  });

  return marked;
}

export function markdownToWebflowHtml(markdown: string): string {
  if (!markdown.trim()) return "";
  const html = buildRenderer().parse(markdown, { async: false }) as string;
  return html.trim();
}

export function containsCodeBlock(markdown: string): boolean {
  // Fenced (``` or ~~~) or indented-by-four code blocks. Inline `code` does not
  // count — Webflow keeps its text content, just not the styling.
  if (/^\s*(```|~~~)/m.test(markdown)) return true;
  return /^(?: {4}|\t)\S/m.test(markdown);
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/lib/publishing/markdown-to-html.test.ts`
Expected: PASS, 11 tests. If `marked`'s renderer signature differs in the installed version, check `node_modules/marked/lib/marked.d.ts` for the `RendererObject` type rather than guessing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: convert markdown to Webflow-safe HTML"
```

---

## Task 6: Slug generation

**Files:**
- Create: `src/lib/publishing/slug.ts`
- Test: `tests/lib/publishing/slug.test.ts`

**Interfaces:**
- Produces: `slugify(title: string): string` and `withSuffix(slug: string, attempt: number): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/publishing/slug.test.ts
import { describe, it, expect } from "vitest";
import { slugify, withSuffix } from "../../../src/lib/publishing/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips punctuation and collapses repeats", () => {
    expect(slugify("New!  Faster --- Search?")).toBe("new-faster-search");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  -- Launch --  ")).toBe("launch");
  });

  it("caps length at 200 characters without a trailing hyphen", () => {
    const slug = slugify("word ".repeat(100));
    expect(slug.length).toBeLessThanOrEqual(200);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("falls back when the title has no usable characters", () => {
    expect(slugify("!!!")).toBe("update");
    expect(slugify("")).toBe("update");
  });
});

describe("withSuffix", () => {
  it("returns the base slug on the first attempt", () => {
    expect(withSuffix("launch", 0)).toBe("launch");
  });

  it("appends an incrementing suffix on later attempts", () => {
    expect(withSuffix("launch", 1)).toBe("launch-2");
    expect(withSuffix("launch", 2)).toBe("launch-3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/publishing/slug.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/publishing/slug.ts
const MAX_LENGTH = 200;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-$/, "");
  // Webflow requires a non-empty slug; a title of pure punctuation would
  // otherwise produce a validation error we can't act on.
  return slug || "update";
}

export function withSuffix(slug: string, attempt: number): string {
  return attempt === 0 ? slug : `${slug}-${attempt + 1}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/lib/publishing/slug.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add slug generation for Webflow CMS items"
```

---

## Task 7: Webflow API client

**Files:**
- Create: `src/lib/integrations/webflow/client.ts`
- Test: `tests/lib/integrations/webflow/client.test.ts`

**Interfaces:**
- Produces:
  - `type WebflowField = { id: string; slug: string; displayName: string; type: string; isRequired: boolean }`
  - `type WebflowSite = { id: string; displayName: string }`
  - `type WebflowCollection = { id: string; displayName: string; slug: string }`
  - `class WebflowApiError extends Error { status: number; validationDetails: string[]; retryAfterMs?: number }`
  - `listSites(token)`, `listCollections(token, siteId)`, `getCollection(token, collectionId)`, `createItem(token, collectionId, body, live)`, `updateItem(token, collectionId, itemId, body, live)` — all `async`, all throwing `WebflowApiError` on non-2xx.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/webflow/client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listSites,
  listCollections,
  getCollection,
  createItem,
  WebflowApiError,
} from "../../../../src/lib/integrations/webflow/client";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("webflow client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("lists sites with a bearer token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ sites: [{ id: "s1", displayName: "Acme" }] }));
    const sites = await listSites("tok");
    expect(sites).toEqual([{ id: "s1", displayName: "Acme" }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.webflow.com/v2/sites");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("lists collections for a site", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ collections: [{ id: "c1", displayName: "Blog", slug: "blog" }] })
    );
    const collections = await listCollections("tok", "s1");
    expect(collections[0].id).toBe("c1");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/sites/s1/collections");
  });

  it("returns the collection field schema", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        id: "c1",
        displayName: "Blog",
        slug: "blog",
        fields: [
          { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
          { id: "f2", slug: "post-body", displayName: "Body", type: "RichText", isRequired: false },
        ],
      })
    );
    const collection = await getCollection("tok", "c1");
    expect(collection.fields).toHaveLength(2);
    expect(collection.fields[0].isRequired).toBe(true);
  });

  it("posts to the staged endpoint when live is false", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: "item1" }, { status: 202 }));
    const result = await createItem("tok", "c1", { isDraft: true, fieldData: { name: "T", slug: "t" } }, false);
    expect(result.id).toBe("item1");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1/items");
  });

  it("posts to the live endpoint when live is true", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: "item1" }, { status: 202 }));
    await createItem("tok", "c1", { isDraft: false, fieldData: { name: "T", slug: "t" } }, true);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1/items/live");
  });

  it("throws WebflowApiError with validation details on 400", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          message: "Validation Error",
          code: "validation_error",
          details: [{ param: "slug", description: "Unique value is already in database: 'my-slug'" }],
        },
        { status: 400 }
      )
    );
    await expect(createItem("tok", "c1", { isDraft: true, fieldData: {} }, false)).rejects.toMatchObject({
      status: 400,
      validationDetails: ["Unique value is already in database: 'my-slug'"],
    });
  });

  it("surfaces Retry-After on 429", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "Too Many Requests" }, { status: 429, headers: { "retry-after": "60" } })
    );
    const error = await listSites("tok").catch((e) => e as WebflowApiError);
    expect(error).toBeInstanceOf(WebflowApiError);
    expect((error as WebflowApiError).retryAfterMs).toBe(60_000);
  });

  it("throws on 401", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "Unauthorized" }, { status: 401 }));
    await expect(listSites("bad")).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/integrations/webflow/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/integrations/webflow/client.ts
const BASE_URL = "https://api.webflow.com";
const REQUEST_TIMEOUT_MS = 10_000;

export type WebflowField = {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
};

export type WebflowSite = { id: string; displayName: string };
export type WebflowCollection = { id: string; displayName: string; slug: string };
export type WebflowCollectionDetail = WebflowCollection & { fields: WebflowField[] };

export type WebflowItemBody = {
  isDraft: boolean;
  isArchived?: boolean;
  fieldData: Record<string, unknown>;
};

export class WebflowApiError extends Error {
  status: number;
  validationDetails: string[];
  retryAfterMs?: number;

  constructor(status: number, message: string, validationDetails: string[] = [], retryAfterMs?: number) {
    super(message);
    this.name = "WebflowApiError";
    this.status = status;
    this.validationDetails = validationDetails;
    this.retryAfterMs = retryAfterMs;
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Webflow returns {message, code, details:[{param, description}]}; a body
    // that fails to parse must not mask the status code.
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      details?: { param?: string; description?: string }[];
    };
    const retryAfter = response.headers.get("retry-after");
    throw new WebflowApiError(
      response.status,
      body.message ?? `Webflow returned HTTP ${response.status}`,
      (body.details ?? []).map((d) => d.description ?? "").filter(Boolean),
      retryAfter ? Number(retryAfter) * 1000 : undefined
    );
  }

  return (await response.json()) as T;
}

export async function listSites(token: string): Promise<WebflowSite[]> {
  const data = await request<{ sites: WebflowSite[] }>(token, "/v2/sites");
  return data.sites;
}

export async function listCollections(token: string, siteId: string): Promise<WebflowCollection[]> {
  const data = await request<{ collections: WebflowCollection[] }>(token, `/v2/sites/${siteId}/collections`);
  return data.collections;
}

export async function getCollection(token: string, collectionId: string): Promise<WebflowCollectionDetail> {
  return request<WebflowCollectionDetail>(token, `/v2/collections/${collectionId}`);
}

// `live: true` writes staging AND publishes that single item. It does NOT
// publish the site, so the customer's unrelated staged changes stay staged.
export async function createItem(
  token: string,
  collectionId: string,
  body: WebflowItemBody,
  live: boolean
): Promise<{ id: string }> {
  const suffix = live ? "/live" : "";
  return request<{ id: string }>(token, `/v2/collections/${collectionId}/items${suffix}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateItem(
  token: string,
  collectionId: string,
  itemId: string,
  body: WebflowItemBody,
  live: boolean
): Promise<{ id: string }> {
  const suffix = live ? "/live" : "";
  return request<{ id: string }>(token, `/v2/collections/${collectionId}/items/${itemId}${suffix}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/lib/integrations/webflow/client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Webflow Data API v2 client"
```

---

## Task 8: Field mapping

**Files:**
- Create: `src/lib/integrations/webflow/mapping.ts`
- Test: `tests/lib/integrations/webflow/mapping.test.ts`

**Interfaces:**
- Consumes: `WebflowField` (Task 7), `WebflowFieldMapping` (Task 4), `markdownToWebflowHtml` (Task 5), `slugify` (Task 6).
- Produces:
  - `buildFieldData(update: Update, mapping: WebflowFieldMapping, fields: WebflowField[], slugOverride?: string): Record<string, unknown>`
  - `validateMapping(mapping: WebflowFieldMapping, fields: WebflowField[]): string[]` — returns human-readable problems, empty array when valid.
  - `suggestMapping(fields: WebflowField[]): WebflowFieldMapping`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/integrations/webflow/mapping.test.ts
import { describe, it, expect } from "vitest";
import { buildFieldData, validateMapping, suggestMapping } from "../../../../src/lib/integrations/webflow/mapping";
import type { WebflowField } from "../../../../src/lib/integrations/webflow/client";
import type { WebflowFieldMapping } from "../../../../src/db/schema";

const fields: WebflowField[] = [
  { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
  { id: "f2", slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
  { id: "f3", slug: "post-body", displayName: "Post Body", type: "RichText", isRequired: false },
  { id: "f4", slug: "published-on", displayName: "Published On", type: "DateTime", isRequired: false },
  { id: "f5", slug: "author", displayName: "Author", type: "Reference", isRequired: true },
];

const update = {
  id: "u1",
  tenantId: "t1",
  title: "Faster Search",
  body: "# Hi\n\nWe shipped **search**.",
  publishedAt: new Date("2026-07-20T10:00:00Z"),
} as never;

describe("buildFieldData", () => {
  it("maps title, slug, body and date onto the customer's field slugs", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      "post-body": { source: "body" },
      "published-on": { source: "publishedAt" },
      author: { source: "static", value: "65f1abc" },
    };
    const data = buildFieldData(update, mapping, fields);
    expect(data.name).toBe("Faster Search");
    expect(data.slug).toBe("faster-search");
    expect(data["post-body"]).toContain("<strong>search</strong>");
    expect(data["published-on"]).toBe("2026-07-20T10:00:00.000Z");
    expect(data.author).toBe("65f1abc");
  });

  it("omits fields mapped to empty", () => {
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "post-body": { source: "empty" } };
    const data = buildFieldData(update, mapping, fields);
    expect(data).not.toHaveProperty("post-body");
  });

  it("uses the slug override when retrying a collision", () => {
    const mapping: WebflowFieldMapping = { slug: { source: "slug" } };
    expect(buildFieldData(update, mapping, fields, "faster-search-2").slug).toBe("faster-search-2");
  });

  it("ignores mappings for fields that no longer exist in the collection", () => {
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "deleted-field": { source: "body" } };
    const data = buildFieldData(update, mapping, fields);
    expect(data).not.toHaveProperty("deleted-field");
  });
});

describe("validateMapping", () => {
  it("passes when every required field is mapped", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
    };
    expect(validateMapping(mapping, fields)).toEqual([]);
  });

  it("reports required fields with no mapping", () => {
    const problems = validateMapping({ name: { source: "title" } }, fields);
    expect(problems.join(" ")).toContain("Slug");
    expect(problems.join(" ")).toContain("Author");
  });

  it("reports a required field mapped to empty", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "empty" },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("Author");
  });

  it("reports a static mapping with a blank value", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "  " },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("Author");
  });

  it("reports mapped fields missing from the collection", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "x" },
      gone: { source: "body" },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("gone");
  });
});

describe("suggestMapping", () => {
  it("pre-selects name, slug, the first rich text field and a date field", () => {
    const suggestion = suggestMapping(fields);
    expect(suggestion.name).toEqual({ source: "title" });
    expect(suggestion.slug).toEqual({ source: "slug" });
    expect(suggestion["post-body"]).toEqual({ source: "body" });
    expect(suggestion["published-on"]).toEqual({ source: "publishedAt" });
  });

  it("leaves fields it cannot infer unmapped", () => {
    expect(suggestMapping(fields).author).toBeUndefined();
  });

  it("only maps the first rich text field", () => {
    const twoRichText: WebflowField[] = [
      ...fields,
      { id: "f6", slug: "excerpt", displayName: "Excerpt", type: "RichText", isRequired: false },
    ];
    expect(suggestMapping(twoRichText).excerpt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/integrations/webflow/mapping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/integrations/webflow/mapping.ts
import type { WebflowFieldMapping } from "@/db/schema";
import { markdownToWebflowHtml } from "@/lib/publishing/markdown-to-html";
import { slugify } from "@/lib/publishing/slug";
import type { Update } from "@/lib/publishing/destinations/types";
import type { WebflowField } from "./client";

export function buildFieldData(
  update: Update,
  mapping: WebflowFieldMapping,
  fields: WebflowField[],
  slugOverride?: string
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const entry = mapping[field.slug];
    if (!entry || entry.source === "empty") continue;

    switch (entry.source) {
      case "title":
        data[field.slug] = update.title;
        break;
      case "body":
        data[field.slug] = markdownToWebflowHtml(update.body);
        break;
      case "slug":
        data[field.slug] = slugOverride ?? slugify(update.title);
        break;
      case "publishedAt":
        // Webflow DateTime fields take ISO-8601. Fall back to now for an update
        // that has not been stamped yet.
        data[field.slug] = (update.publishedAt ?? new Date()).toISOString();
        break;
      case "static":
        data[field.slug] = entry.value;
        break;
    }
  }

  // Iterating `fields` rather than `mapping` means a mapping entry for a field
  // deleted in Webflow is silently ignored here; validateMapping surfaces it.
  return data;
}

export function validateMapping(mapping: WebflowFieldMapping, fields: WebflowField[]): string[] {
  const problems: string[] = [];
  const knownSlugs = new Set(fields.map((f) => f.slug));

  for (const field of fields) {
    if (!field.isRequired) continue;
    const entry = mapping[field.slug];
    if (!entry || entry.source === "empty") {
      problems.push(`"${field.displayName}" is required by Webflow but is not mapped.`);
      continue;
    }
    if (entry.source === "static" && !entry.value.trim()) {
      problems.push(`"${field.displayName}" is set to a static value but the value is blank.`);
    }
  }

  for (const slug of Object.keys(mapping)) {
    if (!knownSlugs.has(slug)) {
      problems.push(`Mapped field "${slug}" no longer exists in this collection.`);
    }
  }

  return problems;
}

export function suggestMapping(fields: WebflowField[]): WebflowFieldMapping {
  const suggestion: WebflowFieldMapping = {};
  let richTextTaken = false;
  let dateTaken = false;

  for (const field of fields) {
    if (field.slug === "name") {
      suggestion.name = { source: "title" };
    } else if (field.slug === "slug") {
      suggestion.slug = { source: "slug" };
    } else if (field.type === "RichText" && !richTextTaken) {
      // Only the first: a second rich text field is usually an excerpt, and
      // duplicating the whole body into it is worse than leaving it blank.
      suggestion[field.slug] = { source: "body" };
      richTextTaken = true;
    } else if (field.type === "DateTime" && !dateTaken) {
      suggestion[field.slug] = { source: "publishedAt" };
      dateTaken = true;
    }
  }

  return suggestion;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/lib/integrations/webflow/mapping.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Webflow field mapping and validation"
```

---

## Task 9: Webflow destination

**Files:**
- Create: `src/lib/publishing/destinations/webflow.ts`
- Modify: `src/lib/publishing/dispatch.ts` (register the destination)
- Test: `tests/lib/publishing/destinations/webflow.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–8.
- Produces: `webflowDestination: Destination<typeof webflowConnections.$inferSelect>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/publishing/destinations/webflow.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { webflowDestination } from "../../../../src/lib/publishing/destinations/webflow";
import type { WebflowFieldMapping } from "../../../../src/db/schema";

const SCHEMA = {
  id: "c1",
  displayName: "Blog",
  slug: "blog",
  fields: [
    { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
    { id: "f2", slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
    { id: "f3", slug: "post-body", displayName: "Body", type: "RichText", isRequired: false },
  ],
};

const mapping: WebflowFieldMapping = {
  name: { source: "title" },
  slug: { source: "slug" },
  "post-body": { source: "body" },
};

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn1",
    tenantId: "t1",
    authType: "site_token",
    // Encrypted at rest; the destination decrypts before calling the API.
    tokenCiphertext: "",
    tokenIv: "",
    tokenAuthTag: "",
    siteId: "s1",
    collectionId: "c1",
    fieldMapping: mapping,
    publishMode: "draft",
    status: "active",
    ...overrides,
  } as never;
}

const update = {
  id: "u1",
  tenantId: "t1",
  title: "Faster Search",
  body: "We shipped search.",
  publishedAt: new Date("2026-07-20T10:00:00Z"),
} as never;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("webflowDestination.deliver", () => {
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn());
    // Token decryption is exercised in the credentials tests; stub it here so
    // these cases stay focused on delivery behavior.
    vi.mock("../../../../src/lib/credentials/encryption", () => ({
      encryptSecret: () => ({ ciphertext: "", iv: "", authTag: "" }),
      decryptSecret: () => "tok",
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a draft item and returns its id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection(), null);

    expect(result).toEqual({ status: "ok", externalId: "item1" });
    const [url, init] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe("https://api.webflow.com/v2/collections/c1/items");
    const body = JSON.parse(init?.body as string);
    expect(body.isDraft).toBe(true);
    expect(body.fieldData.name).toBe("Faster Search");
  });

  it("uses the live endpoint when publishMode is live", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await webflowDestination.deliver(update, connection({ publishMode: "live" }), null);

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://api.webflow.com/v2/collections/c1/items/live");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string).isDraft).toBe(false);
  });

  it("never calls the site publish endpoint", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await webflowDestination.deliver(update, connection({ publishMode: "live" }), null);

    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain("/publish");
    }
  });

  it("patches the existing item when an externalId is known", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 200));

    const result = await webflowDestination.deliver(update, connection(), "item1");

    expect(result.status).toBe("ok");
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://api.webflow.com/v2/collections/c1/items/item1");
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe("PATCH");
  });

  it("falls back to create when the known item was deleted in Webflow", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: "item2" }, 202));

    const result = await webflowDestination.deliver(update, connection(), "item1");

    expect(result).toEqual({ status: "ok", externalId: "item2" });
  });

  it("retries with a suffixed slug on a slug collision", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Error",
            code: "validation_error",
            details: [{ param: "slug", description: "Unique value is already in database: 'faster-search'" }],
          },
          400
        )
      )
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection(), null);

    expect(result.status).toBe("ok");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string).fieldData.slug).toBe("faster-search-2");
  });

  it("gives up after exhausting slug attempts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(SCHEMA));
    for (let i = 0; i < 5; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Error",
            details: [{ param: "slug", description: "Unique value is already in database" }],
          },
          400
        )
      );
    }
    const result = await webflowDestination.deliver(update, connection(), null);
    expect(result.status).toBe("permanent");
  });

  it("returns permanent on 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));
    const result = await webflowDestination.deliver(update, connection(), null);
    expect(result).toMatchObject({ status: "permanent" });
  });

  it("returns permanent on a non-slug validation error, surfacing the detail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Validation Error", details: [{ param: "author", description: "Field is required" }] },
          400
        )
      );
    const result = await webflowDestination.deliver(update, connection(), null);
    expect(result.status).toBe("permanent");
    expect((result as { error: string }).error).toContain("Field is required");
  });

  it("returns retryable on 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Too Many Requests" }, 429));
    expect((await webflowDestination.deliver(update, connection(), null)).status).toBe("retryable");
  });

  it("returns retryable on 5xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Server Error" }, 503));
    expect((await webflowDestination.deliver(update, connection(), null)).status).toBe("retryable");
  });

  it("returns permanent for an empty body without calling Webflow", async () => {
    const result = await webflowDestination.deliver({ ...update, body: "   " } as never, connection(), null);
    expect(result.status).toBe("permanent");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns permanent when the connection is not fully configured", async () => {
    const result = await webflowDestination.deliver(update, connection({ collectionId: null }), null);
    expect(result.status).toBe("permanent");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/publishing/destinations/webflow.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/publishing/destinations/webflow.ts
import { and, eq } from "drizzle-orm";
import type { db as defaultDb } from "@/db";
import { webflowConnections } from "@/db/schema";
import { decryptSecret } from "@/lib/credentials/encryption";
import {
  WebflowApiError,
  createItem,
  getCollection,
  updateItem,
  type WebflowItemBody,
} from "@/lib/integrations/webflow/client";
import { buildFieldData } from "@/lib/integrations/webflow/mapping";
import { slugify, withSuffix } from "@/lib/publishing/slug";
import type { Destination, DeliveryResult, Update } from "./types";

type WebflowConnection = typeof webflowConnections.$inferSelect;

const MAX_SLUG_ATTEMPTS = 5;

function isSlugCollision(error: WebflowApiError): boolean {
  return (
    error.status === 400 &&
    error.validationDetails.some((d) => d.toLowerCase().includes("unique value is already in database"))
  );
}

function classify(error: unknown): DeliveryResult {
  if (error instanceof WebflowApiError) {
    // 401: the token was revoked or the app uninstalled. Webflow issues no
    // refresh token, so retrying can never succeed — the user must reconnect.
    if (error.status === 401 || error.status === 403) {
      return { status: "permanent", error: "Webflow rejected the token. Reconnect the integration." };
    }
    if (error.status === 400) {
      const detail = error.validationDetails.join("; ") || error.message;
      return { status: "permanent", error: `Webflow rejected the item: ${detail}` };
    }
    if (error.status === 429 || error.status >= 500) {
      return { status: "retryable", error: error.message };
    }
    return { status: "permanent", error: error.message };
  }
  // Network failure or timeout.
  return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
}

export const webflowDestination: Destination<WebflowConnection> = {
  id: "webflow",

  async loadConfig(tenantId, database: typeof defaultDb) {
    const [connection] = await database
      .select()
      .from(webflowConnections)
      .where(and(eq(webflowConnections.tenantId, tenantId), eq(webflowConnections.status, "active")))
      .limit(1);
    return connection ?? null;
  },

  async deliver(update: Update, connection, externalId): Promise<DeliveryResult> {
    if (!connection.collectionId) {
      return { status: "permanent", error: "Webflow connection is missing a collection." };
    }
    // MDXEditor can submit a blank body on a parse failure (see resolveBody in
    // drafts/actions.ts). Publishing an empty CMS item is worse than failing.
    if (!update.body.trim()) {
      return { status: "permanent", error: "Update body is empty; nothing to publish." };
    }

    const live = connection.publishMode === "live";

    try {
      const token = decryptSecret({
        ciphertext: connection.tokenCiphertext,
        iv: connection.tokenIv,
        authTag: connection.tokenAuthTag,
      });

      // Re-fetch the schema rather than trusting the stored mapping: a field
      // deleted in Webflow since setup would otherwise 400 with no explanation.
      const collection = await getCollection(token, connection.collectionId);

      const baseSlug = slugify(update.title);
      let lastError: DeliveryResult | null = null;

      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        const body: WebflowItemBody = {
          isDraft: !live,
          fieldData: buildFieldData(
            update,
            connection.fieldMapping,
            collection.fields,
            withSuffix(baseSlug, attempt)
          ),
        };

        try {
          if (externalId) {
            const updated = await updateItem(token, connection.collectionId, externalId, body, live);
            return { status: "ok", externalId: updated.id };
          }
          const created = await createItem(token, connection.collectionId, body, live);
          return { status: "ok", externalId: created.id };
        } catch (error) {
          if (error instanceof WebflowApiError && error.status === 404 && externalId) {
            // The customer deleted our item in Webflow. Drop the stale id and
            // create a fresh one on the next loop pass.
            externalId = null;
            continue;
          }
          if (error instanceof WebflowApiError && isSlugCollision(error)) {
            // A deleted item's slug stays reserved until the site republishes,
            // so check-then-insert cannot prevent this — only retrying can.
            lastError = classify(error);
            continue;
          }
          return classify(error);
        }
      }

      return lastError ?? { status: "permanent", error: "Could not find an available slug in Webflow." };
    } catch (error) {
      return classify(error);
    }
  },
};
```

- [ ] **Step 4: Register the destination**

In `src/lib/publishing/dispatch.ts`:

```ts
import { webflowDestination } from "./destinations/webflow";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DESTINATIONS: Destination<any>[] = [webhookDestination, webflowDestination];
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/lib/publishing/destinations/webflow.test.ts && npm test`
Expected: PASS, 13 new tests plus the existing suite green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: publish updates to Webflow CMS"
```

---

## Task 10: Connect and mapping UI

**Files:**
- Create: `src/app/(dashboard)/integrations/webflow-form.tsx`
- Modify: `src/app/(dashboard)/integrations/actions.ts`, `src/app/(dashboard)/integrations/page.tsx`

**Interfaces:**
- Consumes: `listSites`, `listCollections`, `getCollection` (Task 7); `suggestMapping`, `validateMapping` (Task 8); `encryptSecret` (Task 1).
- Produces: server actions `saveWebflowToken(formData)`, `saveWebflowSite(formData)`, `saveWebflowCollection(formData)`, `saveWebflowMapping(formData)`, `disconnectWebflow()`.

- [ ] **Step 1: Write the server actions**

Append to `src/app/(dashboard)/integrations/actions.ts`:

```ts
import { webflowConnections } from "@/db/schema";
import type { WebflowFieldMapping } from "@/db/schema";
import { listSites, getCollection } from "@/lib/integrations/webflow/client";
import { validateMapping, suggestMapping } from "@/lib/integrations/webflow/mapping";

export async function saveWebflowToken(formData: FormData) {
  const session = await requireSession();
  const token = (formData.get("token") as string).trim();

  // Validate before storing. A bad token discovered at publish time is a much
  // worse failure than one caught here.
  await listSites(token);

  const encrypted = encryptSecret(token);
  const values = {
    tokenCiphertext: encrypted.ciphertext,
    tokenIv: encrypted.iv,
    tokenAuthTag: encrypted.authTag,
    authType: "site_token" as const,
    status: "active" as const,
    lastValidatedAt: new Date(),
  };

  const [existing] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);

  if (existing) {
    await db.update(webflowConnections).set(values).where(eq(webflowConnections.id, existing.id));
  } else {
    await db.insert(webflowConnections).values({ tenantId: session.user.tenantId, ...values });
  }

  revalidatePath("/integrations");
}

export async function saveWebflowSite(formData: FormData) {
  const session = await requireSession();
  await db
    .update(webflowConnections)
    .set({
      siteId: formData.get("siteId") as string,
      siteName: formData.get("siteName") as string,
      // Changing site invalidates the collection and its mapping.
      collectionId: null,
      collectionName: null,
      fieldMapping: {},
    })
    .where(eq(webflowConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}

export async function saveWebflowCollection(formData: FormData) {
  const session = await requireSession();
  const collectionId = formData.get("collectionId") as string;

  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  if (!connection) throw new Error("No Webflow connection");

  const token = decryptSecret({
    ciphertext: connection.tokenCiphertext,
    iv: connection.tokenIv,
    authTag: connection.tokenAuthTag,
  });
  const collection = await getCollection(token, collectionId);

  await db
    .update(webflowConnections)
    .set({
      collectionId,
      collectionName: collection.displayName,
      // Pre-fill the mapping so the common case is one confirmation click.
      fieldMapping: suggestMapping(collection.fields),
    })
    .where(eq(webflowConnections.id, connection.id));

  revalidatePath("/integrations");
}

export async function saveWebflowMapping(formData: FormData) {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  if (!connection?.collectionId) throw new Error("No Webflow collection selected");

  const token = decryptSecret({
    ciphertext: connection.tokenCiphertext,
    iv: connection.tokenIv,
    authTag: connection.tokenAuthTag,
  });
  const collection = await getCollection(token, connection.collectionId);

  const mapping: WebflowFieldMapping = {};
  for (const field of collection.fields) {
    const source = formData.get(`source:${field.slug}`) as string | null;
    if (!source) continue;
    if (source === "static") {
      mapping[field.slug] = { source: "static", value: (formData.get(`static:${field.slug}`) as string) ?? "" };
    } else {
      mapping[field.slug] = { source: source as "title" | "body" | "slug" | "publishedAt" | "empty" };
    }
  }

  // The gate: an unmapped required field would fail at publish time with a
  // Webflow 400 the user cannot act on. Refuse the save instead.
  const problems = validateMapping(mapping, collection.fields);
  if (problems.length > 0) throw new Error(problems.join(" "));

  await db
    .update(webflowConnections)
    .set({
      fieldMapping: mapping,
      publishMode: formData.get("publishMode") === "live" ? "live" : "draft",
      status: "active",
    })
    .where(eq(webflowConnections.id, connection.id));

  revalidatePath("/integrations");
}

export async function disconnectWebflow() {
  const session = await requireSession();
  await db.delete(webflowConnections).where(eq(webflowConnections.tenantId, session.user.tenantId));
  revalidatePath("/integrations");
}
```

Add `decryptSecret` to the existing `@/lib/credentials/encryption` import.

- [ ] **Step 2: Build the form component**

Create `src/app/(dashboard)/integrations/webflow-form.tsx` as a server component rendering whichever step the connection has reached:

- No connection → token input, submitting `saveWebflowToken`.
- Connection but no `siteId` → call `listSites(token)`, render a radio/select list submitting `saveWebflowSite`.
- Site but no `collectionId` → call `listCollections(token, siteId)`, submit `saveWebflowCollection`.
- Collection set → call `getCollection`, render one row per field: field display name, a `select` named `source:<slug>` with options *Update title / Update body / Slug / Published date / Static value / Leave empty*, plus a text input `static:<slug>`. Mark required fields with an asterisk. Add a `publishMode` select (*Create as draft* / *Publish live*) and a Save button submitting `saveWebflowMapping`.
- Always render a Disconnect button submitting `disconnectWebflow`, and show `connection.status` when it is not `active` (`needs_reauth` → "Reconnect Webflow"; `misconfigured` → the validation problems from `validateMapping`).

Use the existing `Card`, `Input`, `Label`, `Button`, `Badge` imports already present in `page.tsx`. Wrap each Webflow API call in try/catch and render the error inline — a Webflow outage must not blank the whole integrations page.

- [ ] **Step 3: Mount it and drop the badge**

In `src/app/(dashboard)/integrations/page.tsx`, add `<WebflowForm />` as a second `<Card>` in the first section, and remove `"Webflow"` from the `COMING_SOON` array:

```tsx
const COMING_SOON = ["Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];
```

- [ ] **Step 4: Manual verification**

```bash
npm run dev
```

With a real Webflow Site Token: paste it, pick a site, pick a collection, confirm the mapping pre-fills, save, then publish a draft and confirm the item appears in the Webflow CMS as a draft.

Then deliberately unmap a required field and confirm the save is rejected with a readable message.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: add Webflow connect and field mapping UI"
```

---

## Task 11: Code-block warning on drafts

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`
- Test: covered by `containsCodeBlock` tests in Task 5

**Interfaces:**
- Consumes: `containsCodeBlock` (Task 5), `webflowConnections` (Task 4).

- [ ] **Step 1: Add the warning**

In the draft detail page, after loading the update, check for a configured Webflow connection and a code block:

```tsx
import { containsCodeBlock } from "@/lib/publishing/markdown-to-html";
import { webflowConnections } from "@/db/schema";

// ...inside the component, after the update is loaded:
const [webflow] = await db
  .select()
  .from(webflowConnections)
  .where(eq(webflowConnections.tenantId, session.user.tenantId))
  .limit(1);

const showCodeWarning = Boolean(webflow?.collectionId) && containsCodeBlock(update.body);
```

Render above the editor when true:

```tsx
{showCodeWarning && (
  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
    This draft contains a code block. Webflow&apos;s rich text field doesn&apos;t support code
    blocks, so it will be published as plain formatted text.
  </div>
)}
```

Match the surrounding file's existing query and layout conventions rather than copying this markup verbatim if it clashes.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Manually confirm the banner appears for a draft containing a fenced code block and not otherwise.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: warn when a draft's code block will be flattened in Webflow"
```

---

## Task 12: End-to-end verification

**Files:** none modified — this task is a gate.

- [ ] **Step 1: Full suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all PASS.

- [ ] **Step 2: Confirm the retry sweep covers Webflow**

Write a test in `tests/lib/publishing/dispatch.test.ts` that seeds a `delivery_attempts` row with `destination: "webflow"`, `status: "failed"`, `attempts: 1`, stubs `fetch` to succeed, calls `retryFailedDeliveries()`, and asserts the row flips to `success`. This proves the generalized sweep actually serves the new destination rather than only the webhook.

- [ ] **Step 3: Confirm a permanent failure is not retried**

Test: seed an attempt with `attempts: 3`, call `retryFailedDeliveries()`, assert `fetch` was never called.

- [ ] **Step 4: Manual end-to-end**

Publish a real draft with Webflow configured in `draft` mode; confirm the item appears in Webflow as a draft and `delivery_attempts.external_id` is populated. Edit the update and re-publish; confirm the same Webflow item is updated rather than a second one created.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: cover Webflow retry sweep and permanent-failure skip"
```

---

## Deferred

Tracked in the spec, deliberately not in this plan: OAuth flow and Marketplace listing (the `authType` column reserves room), inbound Webflow webhooks for detecting customer edits/deletes, Assets API image upload, multiple sites or collections per workspace, multi-locale collections.
