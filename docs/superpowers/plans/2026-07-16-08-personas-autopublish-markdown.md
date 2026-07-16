# Structured Personas + Auto-Publish + Markdown Draft Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured user personas to the Brand Profile, a workspace auto-publish toggle, and a full markdown editor for draft bodies.

**Architecture:** `brandProfiles.userPersonas` becomes a `jsonb` array of `{name, usage, deliveredValue}`; a pure `parsePersonas` helper + a `PersonasEditor` client component feed it (the editor syncs a hidden JSON field so the Server Action contract is unchanged). A `tenants.autoPublish` boolean drives publish-on-generate inside `runBatchForWorkspace` (publishing + firing the webhook only when an active webhook exists, else falling back to a draft). Draft bodies are edited with `@uiw/react-md-editor` in a client wrapper that syncs a hidden `body` input; the preview renders markdown; the AI is nudged to emit markdown.

**Tech Stack:** Drizzle ORM + drizzle-kit, `@uiw/react-md-editor`, shadcn/ui (Base UI flavor — `@base-ui/react`, no `asChild`, `render` prop), Next 16 Server Actions, Vitest.

## Global Constraints

- **shadcn is the Base UI flavor** (`@base-ui/react`). No `asChild` — use the `render` prop. Base UI form controls (`Select`, `Switch`) submit via their `name` prop. Neutral/grayscale, light mode.
- **`Persona` type:** `{ name: string; usage: string; deliveredValue: string }` (`usage` = how they use the product; `deliveredValue` = what they get). Defined in `src/db/schema.ts`, imported elsewhere.
- **Personas fully replace the old flat `text[]`** — no backward-compat retained (dev data disposable).
- **Auto-publish (fall back to a draft):** publish + deliver immediately ONLY when `tenant.autoPublish` AND an active webhook config exists; otherwise leave the update a `draft`. Applies to scheduled AND manual runs.
- **Server-Action contract unchanged:** the personas editor and markdown editor each sync their state into a hidden form field (`personas` JSON, `body`) so the existing/`parse` helpers stay the interface.
- **Local dev DB:** Docker Postgres `product-announcer-postgres` on host port **5434**; `.env.local` `DATABASE_URL` → 5434. Must be running for tests/migrations.
- **Schema-change sequencing (Tasks 1–4):** making `userPersonas` a `jsonb Persona[]` column (Task 1) leaves `saveBrandProfile` — which still assigns a `string[]` via `splitCsv` — a **`tsc`/`npm run build` type error until Task 4** replaces it with `parsePersonas`. This is expected. The full `vitest run` stays green the whole time (no test imports `saveBrandProfile`, and vitest transpiles per-file without full typechecking), so Tasks 1–3 verify with their own test file + the full `vitest run`, NOT `tsc`/`build`. **Task 4 restores `tsc` + `build` + full suite all green.** Tasks 5–7 require full `tsc`/`build`/suite green as normal.
- Otherwise: TypeScript strict; `tsc --noEmit`, `npm run build`, and the full `vitest` suite green after each task.

---

### Task 1: Schema — `Persona` type, `userPersonas` jsonb, `tenants.autoPublish`

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/personas-autopublish-schema.test.ts`

**Interfaces:**
- Produces: `Persona` type; `brandProfiles.userPersonas: Persona[]` (jsonb); `tenants.autoPublish: boolean`.

- [ ] **Step 1: Edit the schema**

In `src/db/schema.ts`:
1. Add the `Persona` type near the top (after the imports line):
   ```typescript
   export type Persona = { name: string; usage: string; deliveredValue: string };
   ```
2. In the `brandProfiles` table, change:
   ```typescript
     userPersonas: text("user_personas").array().notNull().default([]),
   ```
   to:
   ```typescript
     userPersonas: jsonb("user_personas").$type<Persona[]>().notNull().default([]),
   ```
3. In the `tenants` table, add `autoPublish` (between `onboardingCompletedAt` and `createdAt`):
   ```typescript
     autoPublish: boolean("auto_publish").notNull().default(false),
   ```
   (`jsonb` and `boolean` are already in the `drizzle-orm/pg-core` import line — no import change needed.)

- [ ] **Step 2: Generate the migration and fix the un-castable column type change**

```bash
npm run db:generate
```
Open the generated `src/db/migrations/000X_*.sql`. It will contain an `auto_publish` add (keep it) and a `user_personas` type change. Postgres cannot auto-cast `text[]` → `jsonb`, so **replace every generated statement that touches `user_personas`** with a drop-and-recreate (dev data is disposable, so resetting the column is fine):
```sql
ALTER TABLE "brand_profiles" DROP COLUMN "user_personas";--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "user_personas" jsonb DEFAULT '[]'::jsonb NOT NULL;
```
Leave the tenants line as generated:
```sql
ALTER TABLE "tenants" ADD COLUMN "auto_publish" boolean DEFAULT false NOT NULL;
```
Confirm the file contains NO `DROP TABLE`/rebuild of `brand_profiles` or `tenants` — only the `ALTER`s above. (The generated `meta/000X_snapshot.json` already reflects the jsonb end-state; leave it untouched.)

- [ ] **Step 3: Apply the migration**

```bash
npm run db:migrate
```
Expected: no errors. Verify the column type:
```bash
docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "\d brand_profiles" | grep user_personas
docker exec product-announcer-postgres psql -U postgres -d product_announcer -c "\d tenants" | grep auto_publish
```
Expected: `user_personas | jsonb` and `auto_publish | boolean`.

- [ ] **Step 4: Write the round-trip test**

Create `tests/db/personas-autopublish-schema.test.ts`:
```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, brandProfiles } from "../../src/db/schema";

describe("personas + auto-publish schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Personas Schema Test Tenant"));
  });

  it("stores structured personas as jsonb and defaults auto_publish to false", async () => {
    const [tenant] = await db.insert(tenants).values({ name: "Personas Schema Test Tenant" }).returning();
    expect(tenant.autoPublish).toBe(false);

    const [profile] = await db
      .insert(brandProfiles)
      .values({
        tenantId: tenant.id,
        userPersonas: [{ name: "Eng managers", usage: "track shipped work", deliveredValue: "know what changed" }],
      })
      .returning();

    expect(profile.userPersonas).toEqual([
      { name: "Eng managers", usage: "track shipped work", deliveredValue: "know what changed" },
    ]);
  });
});
```

- [ ] **Step 5: Run it**

```bash
npx vitest run tests/db/personas-autopublish-schema.test.ts
```
Expected: `Tests 1 passed (1)`.

- [ ] **Step 6: Verify the full test suite still passes**

```bash
npx vitest run
```
Expected: all tests pass (including your new schema round-trip). Do NOT run `npx tsc --noEmit` / `npm run build` here — this schema change leaves `saveBrandProfile` (assigns `string[]` to the new `Persona[]` column) a type error until Task 4, which is expected (see Global Constraints "Schema-change sequencing"). The full `vitest run` is green because no test imports `saveBrandProfile` and vitest transpiles per-file. (`buildSystemPrompt`'s `.join` still compiles on `Persona[]`; it's rewritten in Task 3.)

- [ ] **Step 7: Commit**

```bash
git add src/db tests/db
git commit -m "$(cat <<'EOF'
Add Persona type, jsonb userPersonas, and tenants.autoPublish

userPersonas becomes jsonb Persona[] (drop-and-recreate migration since
text[]→jsonb has no cast; dev data reset). autoPublish defaults false.
EOF
)"
```

---

### Task 2: `parsePersonas` helper

**Files:**
- Create: `src/lib/persona-form.ts`
- Test: `tests/lib/persona-form.test.ts`

**Interfaces:**
- Consumes: `Persona` (Task 1).
- Produces: `parsePersonas(formData: FormData): Persona[]` — reads a hidden `personas` JSON field; trims fields; drops entries with an empty `name`; returns `[]` for missing/garbage.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/persona-form.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { parsePersonas } from "../../src/lib/persona-form";

function fd(personas: string | undefined): FormData {
  const f = new FormData();
  if (personas !== undefined) f.set("personas", personas);
  return f;
}

describe("parsePersonas", () => {
  it("parses valid personas, trimming fields", () => {
    const json = JSON.stringify([
      { name: "  Eng managers ", usage: " track work ", deliveredValue: " know changes " },
    ]);
    expect(parsePersonas(fd(json))).toEqual([
      { name: "Eng managers", usage: "track work", deliveredValue: "know changes" },
    ]);
  });

  it("drops entries with an empty name and fills missing fields with empty strings", () => {
    const json = JSON.stringify([
      { name: "", usage: "x", deliveredValue: "y" },
      { name: "IC devs" },
    ]);
    expect(parsePersonas(fd(json))).toEqual([{ name: "IC devs", usage: "", deliveredValue: "" }]);
  });

  it("returns [] for a missing field", () => {
    expect(parsePersonas(fd(undefined))).toEqual([]);
  });

  it("returns [] for non-JSON or a non-array", () => {
    expect(parsePersonas(fd("not json"))).toEqual([]);
    expect(parsePersonas(fd(JSON.stringify({ name: "x" })))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/persona-form.test.ts
```
Expected: FAIL — `Cannot find module '../../src/lib/persona-form'`.

- [ ] **Step 3: Implement it**

Create `src/lib/persona-form.ts`:
```typescript
import type { Persona } from "@/db/schema";

export function parsePersonas(formData: FormData): Persona[] {
  const raw = formData.get("personas");
  if (typeof raw !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      name: typeof p.name === "string" ? p.name.trim() : "",
      usage: typeof p.usage === "string" ? p.usage.trim() : "",
      deliveredValue: typeof p.deliveredValue === "string" ? p.deliveredValue.trim() : "",
    }))
    .filter((p) => p.name.length > 0);
}
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/persona-form.test.ts
```
Expected: `Tests 4 passed (4)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/persona-form.ts tests/lib/persona-form.test.ts
git commit -m "Add parsePersonas helper for the structured-personas form"
```

---

### Task 3: Descriptive personas in the generation prompt

**Files:**
- Modify: `src/lib/generation.ts`
- Test: `tests/lib/generation.test.ts`

**Interfaces:**
- Consumes: `brandProfiles.$inferSelect` (now with `userPersonas: Persona[]`).

- [ ] **Step 1: Update the generation test fixture + assertion**

In `tests/lib/generation.test.ts`, change the `brandProfile` fixture's `userPersonas` (currently `["engineering managers"]`) to structured personas, and add a persona assertion. Replace:
```typescript
      userPersonas: ["engineering managers"],
```
with:
```typescript
      userPersonas: [
        { name: "engineering managers", usage: "track shipped work", deliveredValue: "know what changed" },
      ],
```
And after the existing `expect(callArgs.system).toContain("Industry: B2B SaaS.");`, add:
```typescript
    expect(callArgs.system).toContain("Audience personas: engineering managers");
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: FAIL — the current `buildSystemPrompt` emits `Audience: [object Object].`, so the new assertion fails.

- [ ] **Step 3: Update `buildSystemPrompt`**

In `src/lib/generation.ts`, replace the `userPersonas` line inside `buildSystemPrompt`:
```typescript
    brandProfile.userPersonas.length > 0 ? `Audience: ${brandProfile.userPersonas.join(", ")}.` : null,
```
with:
```typescript
    brandProfile.userPersonas.length > 0
      ? `Audience personas: ${brandProfile.userPersonas
          .map((p) => `${p.name} — uses it to ${p.usage}; values ${p.deliveredValue}`)
          .join(" ")}.`
      : null,
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/generation.test.ts
```
Expected: `Tests 3 passed (3)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation.ts tests/lib/generation.test.ts
git commit -m "Render structured personas descriptively in the generation prompt"
```

---

### Task 4: `PersonasEditor` component + Settings wiring

**Files:**
- Create: `src/app/(dashboard)/settings/personas-editor.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`, `src/app/(dashboard)/settings/actions.ts`

**Interfaces:**
- Consumes: `Persona` (Task 1), `parsePersonas` (Task 2).
- Produces: `PersonasEditor` (Client Component) syncing a hidden `personas` JSON field.

- [ ] **Step 1: Create the `PersonasEditor` client component**

Create `src/app/(dashboard)/settings/personas-editor.tsx`:
```tsx
"use client";

import { useState } from "react";
import type { Persona } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function PersonasEditor({ personas: initial }: { personas: Persona[] }) {
  const [personas, setPersonas] = useState<Persona[]>(initial);

  const setField = (i: number, field: keyof Persona, value: string) =>
    setPersonas((ps) => ps.map((p, j) => (j === i ? { ...p, [field]: value } : p)));
  const add = () => setPersonas((ps) => [...ps, { name: "", usage: "", deliveredValue: "" }]);
  const remove = (i: number) => setPersonas((ps) => ps.filter((_, j) => j !== i));

  return (
    <div className="space-y-3">
      <input type="hidden" name="personas" value={JSON.stringify(personas)} />
      {personas.map((p, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Persona {i + 1}</Label>
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
              Remove
            </Button>
          </div>
          <Input placeholder="Name" value={p.name} onChange={(e) => setField(i, "name", e.target.value)} />
          <Textarea
            placeholder="How they should use the product"
            value={p.usage}
            onChange={(e) => setField(i, "usage", e.target.value)}
          />
          <Textarea
            placeholder="What they get from the product"
            value={p.deliveredValue}
            onChange={(e) => setField(i, "deliveredValue", e.target.value)}
          />
        </div>
      ))}
      {personas.length === 0 && <p className="text-sm text-muted-foreground">No personas yet.</p>}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        Add persona
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the Settings brand-profile form**

In `src/app/(dashboard)/settings/page.tsx`, add the import (near the other component imports):
```tsx
import { PersonasEditor } from "./personas-editor";
```
Replace the current personas field block:
```tsx
            <div className="space-y-2">
              <Label htmlFor="userPersonas">User personas (comma-separated)</Label>
              <Input id="userPersonas" name="userPersonas" defaultValue={brandProfile.userPersonas.join(", ")} />
            </div>
```
with:
```tsx
            <div className="space-y-2">
              <Label>User personas</Label>
              <PersonasEditor personas={brandProfile.userPersonas} />
            </div>
```

- [ ] **Step 3: Use `parsePersonas` in `saveBrandProfile`**

In `src/app/(dashboard)/settings/actions.ts`, add the import:
```typescript
import { parsePersonas } from "@/lib/persona-form";
```
In `saveBrandProfile`, replace:
```typescript
      userPersonas: splitCsv(formData.get("userPersonas")),
```
with:
```typescript
      userPersonas: parsePersonas(formData),
```
(`splitCsv` stays — it's still used for `doList`/`dontList`.)

- [ ] **Step 4: Verify build + full suite**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: `tsc` clean; `✓ Compiled successfully`; full suite green.

- [ ] **Step 5: Manual check (optional)**

With the dev server running, open `/settings`, add two personas (name + both descriptions), Save, reload — the personas persist and re-render.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/settings"
git commit -m "$(cat <<'EOF'
Add PersonasEditor and wire structured personas into Settings

The Brand Profile form now edits a repeatable list of {name, usage,
deliveredValue} personas via a client editor that syncs a hidden JSON
field; saveBrandProfile parses it with parsePersonas.
EOF
)"
```

---

### Task 5: Auto-publish in `runBatchForWorkspace`

**Files:**
- Modify: `src/lib/run-schedule.ts`
- Test: `tests/lib/auto-publish.test.ts`

**Interfaces:**
- Consumes: `tenants.autoPublish` (Task 1), `webhookConfigs`, `updates` (existing), `dispatchWebhookForUpdate` (Plan 5).
- Produces: `runBatchForWorkspace` now auto-publishes when `autoPublish` && an active webhook exists.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/auto-publish.test.ts`:
```typescript
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, repos, changeItems, updates, webhookConfigs, webhookDeliveries } from "../../src/db/schema";
import { runBatchForWorkspace } from "../../src/lib/run-schedule";
import { getPendingChangeItems } from "../../src/lib/change-item-batch";

const NAME = "Auto Publish Test Tenant";

describe("runBatchForWorkspace auto-publish", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, NAME));
    vi.mocked(generateObject).mockReset();
  });

  async function seed(autoPublish: boolean) {
    const [tenant] = await db.insert(tenants).values({ name: NAME, autoPublish }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repo.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);
    return tenant;
  }

  it("publishes and fires the webhook when autoPublish is on and an active webhook exists", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s" });
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("published");
    expect(update.publishedAt).not.toBeNull();
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.updateId, update.id));
    expect(deliveries).toHaveLength(1);
  });

  it("stays a draft when autoPublish is on but there is no active webhook", async () => {
    const tenant = await seed(true);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run tests/lib/auto-publish.test.ts
```
Expected: FAIL — the created update is `draft` even in the first case (auto-publish not implemented yet).

- [ ] **Step 3: Implement auto-publish**

In `src/lib/run-schedule.ts`, update the imports at the top — add `and`, the tables, and the dispatcher:
```typescript
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, scheduleConfigs, tenants, webhookConfigs, updates } from "../db/schema";
import { getPendingChangeItems, claimBatchAndCreateUpdate } from "./change-item-batch";
import { generateUpdateDraft } from "./generation";
import { getOrCreateBrandProfile } from "./brand-profile";
import { shouldTriggerRun, advanceNextScheduledAt, type Cadence } from "./scheduler-decision";
import { dispatchWebhookForUpdate } from "./webhook-delivery";
```
Then, in `runBatchForWorkspace`, replace the final `claimBatchAndCreateUpdate` block:
```typescript
  const update = await claimBatchAndCreateUpdate(
    { tenantId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );

  return update !== null;
```
with:
```typescript
  const update = await claimBatchAndCreateUpdate(
    { tenantId, changeItemIds: pending.map((p) => p.id), draft },
    database
  );
  if (!update) return false;

  // Auto-publish: only when the workspace opted in AND an active webhook
  // exists — otherwise the update stays a draft for review (a publish with no
  // delivery would go nowhere).
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [activeWebhook] = await database
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
    .limit(1);

  if (tenant?.autoPublish && activeWebhook) {
    await database
      .update(updates)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(updates.id, update.id));
    await dispatchWebhookForUpdate(update.id, database);
  }

  return true;
```

- [ ] **Step 4: Run it and confirm it passes**

```bash
npx vitest run tests/lib/auto-publish.test.ts
```
Expected: `Tests 2 passed (2)`.

- [ ] **Step 5: Run the full suite (the existing run-schedule tests must still pass — default `autoPublish` is false)**

```bash
npx tsc --noEmit && npx vitest run
```
Expected: `tsc` clean; all tests pass (the existing `run-schedule.test.ts` seeds tenants without `autoPublish`, so it defaults false → drafts, unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/lib/run-schedule.ts tests/lib/auto-publish.test.ts
git commit -m "$(cat <<'EOF'
Auto-publish generated updates when enabled and a webhook is active

runBatchForWorkspace publishes the created Update and fires the signed
webhook immediately when tenant.autoPublish is set and an active webhook
config exists; otherwise the update stays a draft (no publish into the
void). Applies to scheduled and manual runs.
EOF
)"
```

---

### Task 6: Auto-publish Settings toggle

**Files:**
- Modify: `src/app/(dashboard)/settings/page.tsx`, `src/app/(dashboard)/settings/actions.ts`
- Create (generated): `src/components/ui/switch.tsx`

**Interfaces:**
- Consumes: `tenants.autoPublish` (Task 1).
- Produces: `saveAutoPublish` Server Action.

- [ ] **Step 1: Install the shadcn Switch**

```bash
npx shadcn@latest add --yes switch
```
Expected: `src/components/ui/switch.tsx` created (Base UI `@base-ui/react/switch`).

- [ ] **Step 2: Add the `saveAutoPublish` action**

In `src/app/(dashboard)/settings/actions.ts`, add (after `saveWorkspaceName`, using the existing `tenants`/`db`/`eq`/`requireSession`/`revalidatePath` imports):
```typescript
export async function saveAutoPublish(formData: FormData) {
  const session = await requireSession();
  const autoPublish = formData.get("autoPublish") === "on";
  await db.update(tenants).set({ autoPublish }).where(eq(tenants.id, session.user.tenantId));
  revalidatePath("/settings");
}
```

- [ ] **Step 3: Add the toggle card to the Settings page**

In `src/app/(dashboard)/settings/page.tsx`:
1. Add imports:
   ```tsx
   import { Switch } from "@/components/ui/switch";
   ```
   and add `saveAutoPublish` to the existing `./actions` import.
2. Add this card just after the "Workspace name" `Card` (so it sits near the top):
   ```tsx
   <Card className="max-w-lg">
     <CardHeader>
       <CardTitle>Auto-publish</CardTitle>
     </CardHeader>
     <CardContent>
       <form action={saveAutoPublish} className="space-y-3">
         <label className="flex items-center gap-3 text-sm">
           <Switch name="autoPublish" defaultChecked={tenant?.autoPublish ?? false} />
           Publish generated updates automatically
         </label>
         <p className="text-sm text-muted-foreground">
           When on, generated updates are published to your webhook immediately and skip the Drafts
           review queue. Requires an active webhook — without one, updates still land in Drafts for review.
         </p>
         <Button type="submit" variant="outline">
           Save
         </Button>
       </form>
     </CardContent>
   </Card>
   ```

- [ ] **Step 4: Verify the Switch submits, build, full suite**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: `tsc` clean; `✓ Compiled successfully`; full suite green.

**Verify the Switch actually submits its value.** Base UI `Switch` supports form integration via `name` (submits `"on"` when checked), consistent with `Select`. Confirm the built page includes the toggle. If manual testing later shows the toggle does NOT persist (the action reads `null` instead of `"on"`), swap the `<Switch .../>` for a native checkbox that is guaranteed to submit:
```tsx
<input type="checkbox" name="autoPublish" defaultChecked={tenant?.autoPublish ?? false} className="size-4 rounded border-input" />
```
(Keep the same `name="autoPublish"` and the `=== "on"` check either way.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/settings" src/components/ui/switch.tsx
git commit -m "$(cat <<'EOF'
Add the auto-publish toggle to Settings

A workspace Switch (name-submitted) + helper line, backed by
saveAutoPublish writing tenants.autoPublish.
EOF
)"
```

---

### Task 7: Markdown draft editor + markdown preview + markdown generation

**Files:**
- Create: `src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx`
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`, `src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx`, `src/lib/generation.ts`, `package.json`/`package-lock.json`

**Interfaces:**
- Produces: `DraftBodyEditor` (Client Component) syncing a hidden `body` input.

- [ ] **Step 1: Install the markdown editor**

```bash
npm install @uiw/react-md-editor
```

- [ ] **Step 2: Create the `DraftBodyEditor` client component**

Create `src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx`:
```tsx
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import "@uiw/react-md-editor/markdown-editor.css";

const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  return (
    <div data-color-mode="light">
      <input type="hidden" name="body" value={body} />
      <MDEditor value={body} onChange={(v) => setBody(v ?? "")} height={300} />
    </div>
  );
}
```
(The editor is dynamic-imported with `ssr: false` because it references browser globals; its CSS is imported here, applying globally. It syncs the markdown into the hidden `body` input so `saveDraft` — which reads `formData.get("body")` — is unchanged.)

- [ ] **Step 3: Use it in the draft detail page**

In `src/app/(dashboard)/drafts/[updateId]/page.tsx`:
1. Remove the `Textarea` import (`import { Textarea } from "@/components/ui/textarea";`) and add:
   ```tsx
   import { DraftBodyEditor } from "./draft-body-editor";
   ```
2. Replace the body field:
   ```tsx
       <div className="space-y-2">
         <Label htmlFor="body">Body</Label>
         <Textarea id="body" name="body" defaultValue={update.body} rows={8} />
       </div>
   ```
   with:
   ```tsx
       <div className="space-y-2">
         <Label>Body</Label>
         <DraftBodyEditor defaultValue={update.body} />
       </div>
   ```

- [ ] **Step 4: Render the preview body as markdown**

In `src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx`, add at the top (below `"use client";`):
```tsx
import dynamic from "next/dynamic";

const Markdown = dynamic(() => import("@uiw/react-md-editor").then((m) => m.default.Markdown), {
  ssr: false,
});
```
Replace the plain body paragraph:
```tsx
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
```
with:
```tsx
          <div data-color-mode="light" className="text-sm">
            <Markdown source={body} />
          </div>
```

- [ ] **Step 5: Nudge the AI to emit markdown**

In `src/lib/generation.ts`, in `generateUpdateDraft`, change the `prompt`:
```typescript
    prompt: `Here are the changes to summarize into one product update:\n\n${batchText}`,
```
to:
```typescript
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${batchText}`,
```
(The existing `generation.test` prompt assertions — `toContain("acme/web")`, `toContain("Add dark mode")` — still hold, since those come from `batchText`.)

- [ ] **Step 6: Verify build + full suite**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: `tsc` clean; `✓ Compiled successfully`; full suite green. (The markdown editor is client-only via `ssr: false`, so the build must not attempt to SSR it.)

- [ ] **Step 7: Manual check (operator)**

With the dev server running and a draft present: open the draft — the body is a markdown editor with a toolbar and live preview; edit + Save persists the markdown; click Preview — the dialog renders the body as formatted markdown; approving still publishes. (Real AI generation producing markdown needs the AI key — operator step.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/(dashboard)/drafts" src/lib/generation.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add a markdown editor for draft bodies + markdown preview + generation

Draft bodies are edited with @uiw/react-md-editor (client, ssr:false,
syncs a hidden body input so saveDraft is unchanged); the preview dialog
renders the body as markdown; generateUpdateDraft asks the model for a
markdown-formatted body.
EOF
)"
```

---

## What's next

This completes the three enhancements: structured personas feeding a richer prompt, a workspace auto-publish toggle (publish + deliver when a webhook is active, else draft), and a markdown draft editor with markdown preview and markdown-formatted generation. No further plans are queued.
