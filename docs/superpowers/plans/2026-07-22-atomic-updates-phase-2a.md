# Atomic Updates — Phase 2a (Composition Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make atomic updates the sole unit of composition: rename `updates`→`releases`, repoint draft generation at atomic updates, compose a release from user-selected atomic updates on the `/atomic-updates` page, retire the legacy `/pending` generation flow, and remove unattended auto-publish.

**Architecture:** A release (renamed from `updates`) is composed of atomic updates via the `atomic_updates.release_id` FK. Generation consumes atomic-update rows (title/summary/category), not raw change events. Publishing a release closes its atomic updates (`status = 'released'`). The `/pending` page and the raw-change-event batching path are removed; a cron sweep re-resolves any user-facing event the resolver left unassigned, since `/pending` was the only place those were recoverable.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + Postgres, Vercel AI SDK v7 (`generateObject`) with `@ai-sdk/anthropic`, Vitest.

## Sequencing note — every task leaves a green tree

The legacy composition path (`/api/pending/draft` route + `run-schedule.ts` + `claimBatchAndCreateUpdate` + `generateUpdateDraft` + `getBatchableChangeItems`) is one tangled unit coupled through `run-schedule.ts`. Changing any one signature breaks the others. To keep `npm run typecheck` green at the end of **every** task (a hard requirement for per-task review), this plan **adds the new atomic-update functions alongside the old ones (Tasks 2–3), repoints all callers in one swap (Task 4), then deletes the now-dead old code and columns (Task 7).** Do not delete an old function while a caller still references it, and do not change a shared signature in a task that does not also fix every caller.

## Global Constraints

- **The database has no production data.** No backfill; required columns are `NOT NULL`; schema changes are ordinary migrations continuing from 0023 (do NOT squash history or drop schemas). Expect `drizzle-kit generate` to prompt interactively on the table rename — an agent cannot answer it, so that ONE step is handed to the human, exactly as in phase 1 Task 1.
- **Rename `updates` → `releases`** (table, `updateStatusEnum` → `releaseStatusEnum`, `deliveryAttempts.updateId` → `releaseId`, route param `[updateId]` → `[releaseId]`). The `changeEvents.updateId` column, `releases.sourceItems` column, and `tenants.autoPublish` column survive until the cleanup task (Task 7), because their consumers are removed first.
- **This version of Next.js differs from training data.** Per `AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before writing any Server Component / Server Action / route-handler code. Phase 1 confirmed this matters.
- **Model resolution goes through `src/lib/ai/model.ts`** (`resolveModel` / `modelId`); every LLM call records usage via `recordLlmUsage`. Generation reuses `GENERATION_MODEL` / `REVIEW_MODEL` unchanged.
- **The advisory lock (`withTenantLock`, `src/lib/change-events/apply-resolution.ts`) is the ingestion concurrency boundary.** Do not weaken it. Release-claim is a separate, user-initiated transaction and does not take that lock.
- **Do NOT auto-publish anything.** The scheduler produces drafts only.
- **Tenant scoping is per-query**, not RLS — every `where` clause on a tenant-scoped table is a security boundary.
- DB tests run against the separate test database — run `npm run db:migrate:test` after any migration before running them.
- **Never let a test reach the live Anthropic API.** A live `ANTHROPIC_API_KEY` is present. Mock `ai`'s `generateObject` and/or the pipeline/generation modules; follow the `vi.mock` patterns already in `tests/lib/ai/` and `tests/lib/change-events/`.

## Decisions baked into this plan

| Decision | Choice | Why |
| --- | --- | --- |
| Compose surface | Multi-select + "Draft release" on `/atomic-updates` | That page already lists exactly the open atomic updates. |
| `/pending` | Removed entirely (page, dialog, actions, nav link) | Atomic updates are the only unit; a raw-event list contradicts that. |
| Raw-event recoverability | Cron sweep re-resolves orphaned user-facing events | `/pending` was the only manual recovery path; removing it forces this. |
| Imported commits | Wired through the resolver | Otherwise imported commits can never appear in a release. |
| Outbound webhook `sourceItems` field | Dropped from the payload (Task 7) | No consumers exist (pre-production); a release is composed of atomic updates, not a flat id list. |
| `updateStatusEnum` value `"approved"` | Left as a dead enum value | It is already never written; removing it is churn outside this phase's intent. |
| `updates`→`releases` UI labels | Route param renamed; nav labels ("Drafts"/"History") unchanged | A draft release is still a "draft"; renaming visible copy is out of scope. |

---

### Task 1: Rename `updates` → `releases` (schema + migration + all consumers)

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0024_*.sql` (generated; the human runs `db:generate`)
- Rename: `src/app/(dashboard)/drafts/[updateId]/` → `src/app/(dashboard)/drafts/[releaseId]/` (via `git mv`)
- Modify (mechanical): every file in the rename blast radius listed below
- Modify: the tests referencing these symbols

**Interfaces:**
- Consumes: nothing
- Produces:
  - `releases` table export (replaces `updates`), `releaseStatusEnum` (replaces `updateStatusEnum`)
  - `deliveryAttempts.releaseId` (replaces `.updateId`)
  - `atomicUpdates.releaseId` now references `releases.id`
  - `type Release = typeof releases.$inferSelect` in `src/lib/publishing/destinations/types.ts` (replaces `Update`)
  - `changeEvents.updateId`, `releases.sourceItems`, `tenants.autoPublish` are RETAINED (removed in Task 7)

**Context:** A pure identifier rename with the typecheck as the completeness net — no behavior changes. Blast radius (from recon; verify with grep at execution): `src/db/schema.ts`, `src/lib/change-events/change-item-batch.ts`, `src/lib/scheduling/run-schedule.ts`, `src/lib/publishing/dispatch.ts`, `src/lib/publishing/destinations/{types,webhook,webflow}.ts`, `src/app/(dashboard)/drafts/{page,actions,draft-row-menu}.tsx` and `drafts/[updateId]/*`, `src/app/(dashboard)/history/page.tsx`, `src/app/(dashboard)/pending/draft-update-dialog.tsx`, and their tests.

Keep `DraftProgressEvent`'s `{ type: "done"; updateId }` field name — the dialog that reads it is replaced in Task 4.

- [ ] **Step 1: Write the failing schema test**

Create `tests/db/releases-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, releases, atomicUpdates } from "../../src/db/schema";

const TENANT = "Releases Rename Test Tenant";

describe("releases schema (renamed from updates)", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("inserts a release and defaults status to draft", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B", sourceItems: [] })
      .returning();
    expect(release.status).toBe("draft");
  });

  it("links an atomic update to a release and nulls the FK on release delete", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B", sourceItems: [] })
      .returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "A", summary: "S", releaseId: release.id })
      .returning();
    expect(atomic.releaseId).toBe(release.id);

    await db.delete(releases).where(eq(releases.id, release.id));
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.releaseId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/db/releases-schema.test.ts`
Expected: FAIL — `releases` is not exported from `src/db/schema.ts`.

- [ ] **Step 3: Rename in `src/db/schema.ts`**

- `updateStatusEnum = pgEnum("update_status", [...])` → `releaseStatusEnum = pgEnum("release_status", ["draft", "approved", "published", "rejected"])` (keep the dead `"approved"`).
- `updates = pgTable("updates", {...})` → `releases = pgTable("releases", {...})`, internal `status: updateStatusEnum(...)` → `status: releaseStatusEnum(...)`; ALL columns unchanged, INCLUDING `sourceItems`.
- `atomicUpdates.releaseId`: `.references(() => updates.id, ...)` → `.references(() => releases.id, ...)`.
- `changeEvents.updateId`: `.references(() => updates.id)` → `.references(() => releases.id)`. Keep the column name.
- `deliveryAttempts.updateId` → `.releaseId`, `.references(() => releases.id, ...)`, unique index `delivery_attempts_update_id_destination_unique` → `delivery_attempts_release_id_destination_unique` on `(releaseId, destination)`.

- [ ] **Step 4: Generate the migration (HUMAN-RUN — interactive prompt)**

Run: `npm run db:generate`. This prompts on the table/enum/column rename. **An agent cannot answer it — hand it to the human or report NEEDS_CONTEXT.** With no data, choose **rename** at each prompt. Do not hand-write SQL. Expect one new `src/db/migrations/0024_*.sql`; open it and confirm it renames `updates`→`releases`, `update_status`→`release_status`, `delivery_attempts.update_id`→`release_id` + its unique index, and retargets the `atomic_updates.release_id` / `change_events.update_id` FKs at `releases`.

- [ ] **Step 5: Apply to both databases**

Run: `npm run db:migrate && npm run db:migrate:test`. Both report 0024 applied; seeded catalogs untouched.

- [ ] **Step 6: Rename the route folder**

```bash
git mv "src/app/(dashboard)/drafts/[updateId]" "src/app/(dashboard)/drafts/[releaseId]"
```
Update `params.updateId` → `params.releaseId` reads inside those files and any hidden form field carrying the id.

- [ ] **Step 7: Sweep every remaining consumer**

`grep -rln "updateStatusEnum\|\\.updateId\|typeof updates\|from \"@/db/schema\"" src/ tests/` and inspect. Rename imports/usages to `releases` / `releaseStatusEnum` / `deliveryAttempts.releaseId`. In `destinations/types.ts` rename `type Update` → `type Release`; update `webhook.ts`/`webflow.ts`/`dispatch.ts` param names (`update` → `release`). **Do NOT** rename `changeEvents.updateId` (column), `releases.sourceItems`, `DraftProgressEvent.updateId`, `claimBatchAndCreateUpdate`, or `tenants.autoPublish` — all handled in later tasks.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`. Typecheck is the net — any missed rename fails to compile.

- [ ] **Step 9: Commit**

```bash
git add -A src/db src/lib src/app tests
git commit -m "refactor: rename updates to releases"
```

---

### Task 2: Add atomic-update generation (additive)

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (add new functions; keep the old ones)
- Modify: `src/lib/ai/generation.ts` (add `generateReleaseDraft`; keep `generateUpdateDraft`)
- Modify: `tests/lib/ai/compose-prompt.test.ts` (add a describe block; keep existing)

**Interfaces:**
- Produces:
  - `type AtomicUpdateForPrompt = { id: string; title: string; summary: string; category: "new" | "improved" | "fixed" | null }`
  - `serializeAtomicUpdates(items: AtomicUpdateForPrompt[], maxChars?: number): string`
  - `composeReleasePrompt(args: { items: AtomicUpdateForPrompt[]; brandProfile; personas; examples }): { system; prompt }`
  - `generateReleaseDraft(items: AtomicUpdateForPrompt[], brandProfile, personas?, examples?): Promise<UpdateDraft>`

**Context:** ADDITIVE — the existing `serializeBatch` / `composePrompt` / `generateUpdateDraft` stay untouched and green; their callers are repointed in Task 4 and they are deleted in Task 7. An atomic update is already a distilled, repo-agnostic statement, so the new renderer needs no repo map and no PR/commit branching. `buildSystemPrompt` and the review loop are reused as-is.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/ai/compose-prompt.test.ts`:

```ts
import { serializeAtomicUpdates, composeReleasePrompt } from "../../../src/lib/ai/compose-prompt";

const AUS = [
  { id: "a1", title: "CSV export", summary: "Export reports as CSV.", category: "new" as const },
  { id: "a2", title: "Faster search", summary: "Search returns in under a second.", category: "improved" as const },
];

describe("serializeAtomicUpdates", () => {
  it("renders each atomic update as a numbered title + summary line", () => {
    const text = serializeAtomicUpdates(AUS);
    expect(text).toContain("CSV export");
    expect(text).toContain("Export reports as CSV.");
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
  });

  it("drops trailing items past maxChars with a note, keeping at least one", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`, title: `Feature ${i}`, summary: "x".repeat(200), category: "new" as const,
    }));
    const text = serializeAtomicUpdates(many, 500);
    expect(text).toMatch(/more updates not shown/);
    expect(text).toContain("Feature 0");
  });
});

describe("composeReleasePrompt", () => {
  it("builds a system+prompt pair from atomic updates without a repo map", () => {
    const { system, prompt } = composeReleasePrompt({
      items: AUS,
      brandProfile: { tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, updatesStyleSummary: null, userPersonas: [] } as never,
      personas: [],
      examples: [],
    });
    expect(system).toContain("product update");
    expect(prompt).toContain("CSV export");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/ai/compose-prompt.test.ts`
Expected: FAIL — `serializeAtomicUpdates` not exported.

- [ ] **Step 3: Add to `compose-prompt.ts`**

Append (do not remove `serializeBatch`/`composePrompt`/`formatChangeItem`):

```ts
export type AtomicUpdateForPrompt = {
  id: string;
  title: string;
  summary: string;
  category: "new" | "improved" | "fixed" | null;
};

function formatAtomicUpdate(item: AtomicUpdateForPrompt, index: number): string {
  const tag = item.category ? ` (${item.category})` : "";
  return `${index + 1}. "${item.title}"${tag} — ${item.summary}`;
}

/**
 * Renders selected atomic updates as numbered title + summary lines. Atomic
 * updates are already distilled and repo-agnostic — no repo tag, no PR/commit
 * branching. Trailing items past `maxChars` are dropped whole with a note.
 */
export function serializeAtomicUpdates(
  items: AtomicUpdateForPrompt[],
  maxChars = DEFAULT_MAX_PROMPT_CHARS
): string {
  const lines = items.map(formatAtomicUpdate);
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const droppedIfStopHere = lines.length - (i + 1);
    const note = droppedIfStopHere > 0 ? `\n…and ${droppedIfStopHere} more updates not shown.` : "";
    const candidate = [...kept, lines[i]].join("\n") + note;
    if (candidate.length > maxChars && kept.length > 0) break;
    kept.push(lines[i]);
    if (candidate.length > maxChars) break;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n…and ${dropped} more updates not shown.` : kept.join("\n");
}

export function composeReleasePrompt(args: {
  items: AtomicUpdateForPrompt[];
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  return {
    system: buildSystemPrompt(args.brandProfile, args.personas, args.examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${serializeAtomicUpdates(args.items)}`,
  };
}
```

- [ ] **Step 4: Add `generateReleaseDraft` to `generation.ts`**

Read `generation.ts`; add `generateReleaseDraft(items: AtomicUpdateForPrompt[], brandProfile, personas = [], examples = [])` that mirrors `generateUpdateDraft` but calls `composeReleasePrompt` (no `reposById`). Keep `generateUpdateDraft`. Reuse the same retry + `recordLlmUsage` structure. Add a focused test in `tests/lib/ai/generation.test.ts` with the atomic-update shape and a mocked `generateObject`.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run tests/lib/ai && npm run typecheck`. Green (old path untouched).

```bash
git add src/lib/ai tests/lib/ai
git commit -m "feat: add atomic-update generation alongside legacy path"
```

---

### Task 3: Add release-claim from atomic updates (additive)

**Files:**
- Create: `src/lib/change-events/release-claim.ts`
- Test: `tests/lib/change-events/release-claim.test.ts`

**Interfaces:**
- Produces:
  - `claimReleaseFromAtomicUpdates(input: { tenantId; atomicUpdateIds: string[]; draft: { title; body }; review?: { status; issues } }, database?): Promise<Release | null>`
  - `revertReleaseAtomicUpdates(releaseId: string, database?): Promise<number>`
  - `getOpenAtomicUpdates(tenantId: string, database?): Promise<AtomicUpdateRow[]>`

**Context:** ADDITIVE — the old `claimBatchAndCreateUpdate` stays until Task 7. This is the FIRST code to write `atomicUpdates.status = "released"` and `releaseId`. Claim only tenant-owned, currently-`open` atomic updates so a re-submit or race can't double-claim. `atomicUpdates.releaseId` is `ON DELETE SET NULL`, so a release delete nulls the FK but leaves `status = 'released'`, stranding the atomic update — `revertReleaseAtomicUpdates` flips it back to `open` and must run on both reject and delete (wired in Task 4).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-events/release-claim.test.ts` (covers: claim marks selected open AUs `released`+linked and creates the release; returns null when none are open; never claims another tenant's AU; `getOpenAtomicUpdates` returns only open for the tenant; `revertReleaseAtomicUpdates` reopens + clears `releaseId`):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates } from "../../../src/db/schema";
import { claimReleaseFromAtomicUpdates, revertReleaseAtomicUpdates, getOpenAtomicUpdates } from "../../../src/lib/change-events/release-claim";

const TENANT = "Release Claim Test Tenant";
const seed = async (tenantId: string, titles: string[]) => {
  const out = [];
  for (const t of titles) { const [a] = await db.insert(atomicUpdates).values({ tenantId, title: t, summary: "S" }).returning(); out.push(a); }
  return out;
};

describe("claimReleaseFromAtomicUpdates", () => {
  afterEach(async () => { await db.delete(tenants).where(eq(tenants.name, TENANT)); });

  it("marks selected atomic updates released, links them, creates the release", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1, a2] = await seed(t.id, ["A1", "A2"]);
    const r = await claimReleaseFromAtomicUpdates({ tenantId: t.id, atomicUpdateIds: [a1.id, a2.id], draft: { title: "R", body: "B" }, review: { status: "passed", issues: [] } });
    expect(r).not.toBeNull();
    const claimed = await db.select().from(atomicUpdates).where(eq(atomicUpdates.releaseId, r!.id));
    expect(claimed).toHaveLength(2);
    expect(claimed.every((a) => a.status === "released")).toBe(true);
  });

  it("returns null when none of the ids are open", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    await claimReleaseFromAtomicUpdates({ tenantId: t.id, atomicUpdateIds: [a1.id], draft: { title: "R1", body: "B" } });
    const second = await claimReleaseFromAtomicUpdates({ tenantId: t.id, atomicUpdateIds: [a1.id], draft: { title: "R2", body: "B" } });
    expect(second).toBeNull();
  });

  it("never claims another tenant's atomic update", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [o] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [foreign] = await seed(o.id, ["F"]);
    const r = await claimReleaseFromAtomicUpdates({ tenantId: t.id, atomicUpdateIds: [foreign.id], draft: { title: "R", body: "B" } });
    expect(r).toBeNull();
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, foreign.id));
    expect(after.status).toBe("open");
  });

  it("getOpenAtomicUpdates returns only open for the tenant", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["Open"]);
    await db.insert(atomicUpdates).values({ tenantId: t.id, title: "Released", summary: "S", status: "released" });
    const open = await getOpenAtomicUpdates(t.id);
    expect(open.map((a) => a.id)).toEqual([a1.id]);
  });

  it("revertReleaseAtomicUpdates reopens and clears releaseId", async () => {
    const [t] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [a1] = await seed(t.id, ["A1"]);
    const r = await claimReleaseFromAtomicUpdates({ tenantId: t.id, atomicUpdateIds: [a1.id], draft: { title: "R", body: "B" } });
    expect(await revertReleaseAtomicUpdates(r!.id)).toBe(1);
    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, a1.id));
    expect(after.status).toBe("open");
    expect(after.releaseId).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/change-events/release-claim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `release-claim.ts`**

```ts
import { and, asc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, releases } from "@/db/schema";
import type { ReviewStatus } from "@/lib/ai/review-draft";

type Database = typeof defaultDb;
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
type Release = typeof releases.$inferSelect;
type AtomicUpdateRow = typeof atomicUpdates.$inferSelect;

export type DraftInput = { title: string; body: string };

class EmptyClaimError extends Error {}

export async function getOpenAtomicUpdates(
  tenantId: string,
  database: Database = defaultDb
): Promise<AtomicUpdateRow[]> {
  return database
    .select()
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")))
    .orderBy(asc(atomicUpdates.createdAt));
}

/**
 * Claims the given OPEN atomic updates into a new draft release: inserts the
 * release, flips the atomic updates to `released` + sets `releaseId`, all in one
 * transaction. Only tenant-owned, still-open atomic updates are claimable, so a
 * re-submit or concurrent claim cannot double-claim. Returns null if nothing was
 * claimable (the release insert is rolled back).
 */
export async function claimReleaseFromAtomicUpdates(
  input: { tenantId: string; atomicUpdateIds: string[]; draft: DraftInput; review?: { status: ReviewStatus; issues: string[] } },
  database: Database = defaultDb
): Promise<Release | null> {
  if (input.atomicUpdateIds.length === 0) return null;

  return database
    .transaction(async (tx) => {
      const [release] = await tx
        .insert(releases)
        .values({
          tenantId: input.tenantId,
          title: input.draft.title,
          body: input.draft.body,
          ...(input.review
            ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
            : {}),
        })
        .returning();

      const claimed = await tx
        .update(atomicUpdates)
        .set({ status: "released", releaseId: release.id, updatedAt: new Date() })
        .where(
          and(
            inArray(atomicUpdates.id, input.atomicUpdateIds),
            eq(atomicUpdates.tenantId, input.tenantId),
            eq(atomicUpdates.status, "open")
          )
        )
        .returning({ id: atomicUpdates.id });

      if (claimed.length === 0) throw new EmptyClaimError(); // rolls back the release insert
      return release;
    })
    .catch((err) => {
      if (err instanceof EmptyClaimError) return null;
      throw err;
    });
}

/**
 * Inverse of the claim: reopens a release's atomic updates (status → open,
 * releaseId → null). Load-bearing on reject and delete — `releaseId` is
 * ON DELETE SET NULL, so a delete nulls the FK but leaves `status = 'released'`,
 * which would strand the atomic update, invisible to every open-only query.
 * Run it BEFORE deleting the release, or the FK is already null and this matches
 * zero rows.
 */
export async function revertReleaseAtomicUpdates(
  releaseId: string,
  database: Executor = defaultDb
): Promise<number> {
  const reverted = await database
    .update(atomicUpdates)
    .set({ status: "open", releaseId: null, updatedAt: new Date() })
    .where(eq(atomicUpdates.releaseId, releaseId))
    .returning({ id: atomicUpdates.id });
  return reverted.length;
}
```

Confirm Drizzle's `transaction()` rejects (not swallows) on a thrown callback error in this codebase — `apply-resolution.ts` relies on the same. If it does not, use an explicit rollback path instead.

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run tests/lib/change-events/release-claim.test.ts && npm run typecheck`.

```bash
git add src/lib/change-events/release-claim.ts tests/lib/change-events/release-claim.test.ts
git commit -m "feat: add release-claim from atomic updates"
```

---

### Task 4: Swap composition to atomic updates everywhere

**Files:**
- Modify: `src/lib/scheduling/run-schedule.ts` (repoint to new generation + claim + `getOpenAtomicUpdates`; delete auto-publish block)
- Modify: `src/app/(dashboard)/settings/page.tsx`, `settings/actions.ts` (remove the auto-publish Switch + `saveAutoPublish`)
- Create: `src/app/api/atomic-updates/draft/route.ts`; delete `src/app/api/pending/draft/route.ts`
- Modify: `src/app/(dashboard)/atomic-updates/page.tsx`, `atomic-update-card.tsx`; create `draft-release-dialog.tsx`
- Delete: `src/app/(dashboard)/pending/` (whole folder); remove the Pending nav entry
- Modify: `src/app/(dashboard)/drafts/actions.ts` (reject/delete call `revertReleaseAtomicUpdates`)
- Tests: rewrite `tests/lib/scheduling/run-schedule.test.ts`; move `tests/app/api/pending/draft/route.test.ts` → the new route; delete `tests/lib/scheduling/auto-publish*.test.ts`

**Interfaces:**
- Consumes: `generateReleaseDraft` (T2); `claimReleaseFromAtomicUpdates`, `revertReleaseAtomicUpdates`, `getOpenAtomicUpdates` (T3)
- Produces: `runBatchForWorkspace(tenantId, atomicUpdates: AtomicUpdateForPrompt[]-shaped, database?, onProgress?)`; a POST route taking `{ atomicUpdateIds }` streaming `DraftProgressEvent`

**Context:** This is the coupled swap — it repoints every caller of the legacy composition path in one green step, after which `generateUpdateDraft`/`claimBatchAndCreateUpdate`/`getBatchableChangeItems`/`getTrackedChangeItems`/`getPendingChangeItems`/`batchCategories`/`serializeBatch`/`composePrompt` become caller-less (deleted in Task 7). It is large; work in the sub-steps below and keep the tree compiling throughout. **Read `node_modules/next/dist/docs/` for route handlers + streaming before writing the route.**

- [ ] **Step 1: Rewrite the scheduler test (RED)**

In `tests/lib/scheduling/run-schedule.test.ts`: the batch input is now atomic updates; assert `runBatchForWorkspace` creates a release linked to them (via `releaseId`) and that NOTHING publishes (remove any `dispatchAllDestinations` expectation). Run it — FAIL on the new shape.

- [ ] **Step 2: Rewrite `run-schedule.ts`**

- `runBatchForWorkspace(tenantId, items, ...)`: `items` are open atomic updates. Drop the `reposById` prep. Build `selectExamples` `categories` from the atomic updates' distinct non-null `category`. Call `generateReleaseDraft(items, brandProfile, personas, examples)`. `reviewAndReconcile` unchanged. Save via `claimReleaseFromAtomicUpdates({ tenantId, atomicUpdateIds: items.map(i => i.id), draft: review.finalDraft, review })`.
- **Delete** the auto-publish block (old lines ~81–108) and the now-unused `tenants` / `webhookConfigs` / `releases` / `dispatchAllDestinations` imports.
- `runSchedulerTick`: replace `getBatchableChangeItems` with `getOpenAtomicUpdates`; `pendingCount` = open-atomic-update count.
- Keep `onProgress({ type: "done", updateId: release.id })` (field renamed with the dialog, if you rename it, update `draft-progress.ts` + the new dialog together).

- [ ] **Step 3: Remove the auto-publish settings UI**

Remove the Switch + copy in `settings/page.tsx` and `saveAutoPublish` in `settings/actions.ts`. Delete `tests/lib/scheduling/auto-publish.test.ts` and `auto-publish-failure.test.ts`. (The `tenants.autoPublish` COLUMN drop happens in Task 7 — leaving it now keeps the tree green with no reader.)

- [ ] **Step 4: Build the new draft route + move its test**

Create `src/app/api/atomic-updates/draft/route.ts`: read `{ atomicUpdateIds }`; load the tenant's open atomic updates; filter the requested ids to owned+open; if none, stream `{type:"error"}`; else stream `runBatchForWorkspace(tenantId, selected, db, emit)`. Mirror the streaming structure of the existing `api/pending/draft/route.ts` (which you delete). Move `tests/app/api/pending/draft/route.test.ts` → `tests/app/api/atomic-updates/draft/route.test.ts`, adapted to POST ids and mock the generation surface.

- [ ] **Step 5: Build the selection UI + delete `/pending`**

- `atomic-update-card.tsx`: add an optional selection checkbox controlled by the page.
- `page.tsx`: track selected ids; render "Draft release (N)" opening `draft-release-dialog.tsx`.
- `draft-release-dialog.tsx`: adapt `pending/draft-update-dialog.tsx` verbatim in structure (fetch + `getReader` + `pacedApply` + 4-phase UI + `MIN_STEP_MS`), changing only the endpoint, the `{ atomicUpdateIds }` payload, empty-state copy, and the `/drafts/${releaseId}` link.
- `git rm -r "src/app/(dashboard)/pending" src/app/api/pending`; remove the Pending nav entry.

- [ ] **Step 6: Rewire reject/delete**

In `drafts/actions.ts`, replace every `releaseBatchForUpdate(id, ...)` with `revertReleaseAtomicUpdates(id, ...)`, keeping the revert-BEFORE-delete order.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`. All green; `grep -rn "autoPublish" src/app` empty (code removed; column remains); route table includes `/api/atomic-updates/draft` and not `/api/pending/draft`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: compose releases from atomic updates; remove pending flow and auto-publish"
```

---

### Task 5: Wire manual commit import through the resolver

**Files:**
- Modify: `src/lib/change-events/import-commits.ts`
- Test: `tests/lib/change-events/import-commits.test.ts` (extend)

**Interfaces:**
- Consumes: `resolvePendingEvents` (phase 1, `pipeline.ts`)
- Produces: no new export; `importSelectedCommits` resolves the user-facing commits it imports

**Context:** Imported commits are inserted but never resolved (phase-1 comment says so), so with composition now atomic-updates-only they can never appear in a release. Add the same tail `ingest-push.ts` uses.

- [ ] **Step 1: Failing test** — import two user-facing commits with a stubbed classifier + stubbed `resolvePending`; assert `resolvePending` called once with both ids. Use the DI style `ingest-push.ts`/its test use; add `resolvePending` as an injectable dep. No live LLM.
- [ ] **Step 2: Run — FAIL** (`npx vitest run tests/lib/change-events/import-commits.test.ts`).
- [ ] **Step 3: Implement** — read `import-commits.ts`; add injectable `resolvePending = resolvePendingEvents`; after the import loop, collect inserted events with `userFacing !== false` and call `resolvePending(tenantId, ids)` once (skip if none). Remove the stale "not auto-resolved" comment.
- [ ] **Step 4: Verify** — `npx vitest run tests/lib/change-events/import-commits.test.ts && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: resolve manually imported commits into atomic updates"`.

---

### Task 6: Cron sweep for orphaned unresolved events

**Files:**
- Create: `src/lib/change-events/resolve-sweep.ts`
- Modify: `src/app/api/cron/scheduler/route.ts`
- Test: `tests/lib/change-events/resolve-sweep.test.ts`

**Interfaces:**
- Consumes: `resolvePendingEvents` (phase 1)
- Produces: `sweepUnresolvedEvents(deps?: { database?; resolvePending? }): Promise<void>`

**Context:** Removing `/pending` (Task 4) removed the only surface where a user-facing event the resolver left unassigned (resolver returned `[]` on a model error) was recoverable. This is its replacement, and it closes the phase-1 final-review follow-up. Candidates: `status = 'pending'`, `atomicUpdateId IS NULL`, `filterReason IS NULL` (a deterministically-filtered event is not an ingestion miss), `userFacing` is null OR true. Group by tenant; re-run `resolvePendingEvents` per tenant; per-tenant try/catch so one failure doesn't starve the sweep. Runs on the hourly cron after `retryFailedDeliveries`.

- [ ] **Step 1: Failing test** — seed a user-facing/unassigned/unfiltered pending event + stubbed `resolvePending`; assert one call with that id. Seed an already-assigned event and a `userFacing = false` event; assert neither is swept.

```ts
const resolvePending = vi.fn();
await sweepUnresolvedEvents({ database: db, resolvePending });
expect(resolvePending).toHaveBeenCalledTimes(1);
expect(resolvePending.mock.calls[0][1]).toEqual([orphan.id]);
```

- [ ] **Step 2: Run — FAIL** (module not found).
- [ ] **Step 3: Implement `resolve-sweep.ts`** — select candidates across tenants; group ids by `tenantId`; per tenant call `resolvePending(tenantId, ids)` inside try/catch. Injectable `database`/`resolvePending`.
- [ ] **Step 4: Wire the cron** — in `api/cron/scheduler/route.ts`, call `sweepUnresolvedEvents()` after `retryFailedDeliveries()`, keeping the `CRON_SECRET` guard. Read the installed Next route-handler docs first.
- [ ] **Step 5: Verify** — `npx vitest run tests/lib/change-events/resolve-sweep.test.ts && npm run typecheck && npm run build`.
- [ ] **Step 6: Commit** — `git commit -m "feat: cron sweep re-resolves orphaned user-facing events"`.

---

### Task 7: Cleanup — delete dead code and drop unused columns

**Files:**
- Modify: `src/lib/change-events/change-item-batch.ts` (delete dead functions; delete the file if empty)
- Modify: `src/lib/ai/compose-prompt.ts`, `generation.ts` (delete `serializeBatch`/`composePrompt`/`formatChangeItem`/`generateUpdateDraft`)
- Modify: `src/db/schema.ts` (drop `releases.sourceItems`, `changeEvents.updateId`, `tenants.autoPublish`); migration `0025_*.sql`
- Modify: `src/lib/publishing/destinations/webhook.ts` (drop `sourceItems` from the payload) + its test
- Modify/delete: any test referencing the deleted symbols

**Context:** Task 4 left the legacy composition functions and the `autoPublish` code caller-less; now delete them and the columns they used. Order matters: within this task, delete the CODE that reads a column before the migration that drops it, so intermediate `typecheck` stays green.

- [ ] **Step 1: Delete dead functions**

Confirm caller-less first: `grep -rn "claimBatchAndCreateUpdate\|releaseBatchForUpdate\|getBatchableChangeItems\|getTrackedChangeItems\|getPendingChangeItems\|batchCategories\|serializeBatch\|composePrompt\b\|generateUpdateDraft" src/ tests/` — every hit should be a definition or a test of the dead function. Delete the functions and their now-orphaned tests. If `change-item-batch.ts` is left empty, delete it and drop its imports.

- [ ] **Step 2: Drop the webhook payload field**

Remove `sourceItems` from `webhook.ts` `buildPayload`; update its test to assert the field is absent.

- [ ] **Step 3: Drop the columns**

In `schema.ts` remove `releases.sourceItems`, `changeEvents.updateId` (+ its FK), `tenants.autoPublish`. `npm run db:generate` (HUMAN-RUN if it prompts; column drops usually don't) → `0025_*.sql` → `npm run db:migrate && npm run db:migrate:test`.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`. Then the dead-code grep from Step 1 returns only zero hits, and `grep -rn "sourceItems\|autoPublish\|changeEvents.updateId" src/ tests/` is empty.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove legacy composition code and unused columns"
```

---

## Verification

- [ ] `npm run typecheck && npm run lint && npx vitest run && npm run build` all clean.
- [ ] Publishing a release marks its atomic updates `released`; they disappear from `/atomic-updates` and the resolver candidate set — confirm `loadOpenAtomicUpdates` / `listAtomicUpdates` need no change (they already filter `open`).
- [ ] Rejecting or deleting a draft release reopens its atomic updates.
- [ ] The scheduler creates a draft release and never publishes.
- [ ] An imported user-facing commit becomes an atomic update.
- [ ] A user-facing event the resolver left unassigned is picked up by the next cron sweep.
- [ ] No `/pending` route, no auto-publish setting or column, no `sourceItems`/`updateId`/legacy batch functions remain.

## Deferred to Phase 2b (catch-up)

- Detecting a draft release gone stale (evidence delta + membership delta vs a `composedAt` timestamp).
- The "N new updates since this draft — catch up" affordance on the release editor.
- Merge-regeneration (integrate new atomic updates while preserving hand-edited body) + a "start over" escape hatch.
- The `releases.composedAt` / `bodyEditedAt` columns those need.

## Out of scope (later phases)

- Full change-events list + manual reassignment UI (phase 3).
- Notion / task sources (separate spec).
