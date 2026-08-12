# Unified Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every content type a live generation checklist, then merge the atomic-update composition into the one drafting path.

**Architecture:** `after()` has no open response to stream into, so progress is persisted on a new `contentPieces.generationStep` column and polled by the client. `DraftStepKey` and `DRAFT_STEPS` carry over from the retiring NDJSON dialog unchanged. Once progress works for every type, the release composition becomes a branch inside `generateDraftForPiece`, selected by `brief.contentType === "product_update"`.

**Tech Stack:** Next.js 16.2.10 App Router, Drizzle ORM 0.45.2 (`drizzle-kit generate` / `migrate`), Postgres, Vitest.

**Task order is deliberate.** Tasks 1–4 deliver the streaming/progress work on its own and leave the codebase shippable. Tasks 5–6 are the drafting fork, which is what unblocks spec 10's Task 6.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route code.** This Next.js has breaking changes from training data.
- **No test may reach the real Anthropic API.** The generator is injected through the existing `deps.generate` seam in `generateDraftForPiece`. Any test on this path mocks the generator. Where `after` is mocked, it must still *run* its callback — a synchronous no-op mock silently skips generation and passes for the wrong reason.
- **Tenant scoping is the security boundary**, enforced in the WHERE clause. The progress read takes `tenantId` and must refuse another tenant's piece.
- `revalidatePath` / `requireSession` stay in the `"use server"` layer; `src/lib` modules take `tenantId` and an injectable `database` defaulting to the shared `db`.
- **`"use server"` files may export ONLY async functions.**
- **Never import a runtime value from a server module into a `"use client"` file** — `import type` only.
- **`npm run build` is a mandatory gate** on every task touching a route or component.
- Migrations: edit `src/db/schema.ts`, then `npm run db:generate` (writes `src/db/migrations/0060_*.sql`), then `npm run db:migrate` and `npm run db:migrate:test`. **Never hand-write the SQL file.**
- Tests live in `tests/`, mirroring `src/`. **The suite is flaky against its shared Postgres — run a failing file twice before believing it.**
- The UI cannot be visually verified; the dev preview is behind an OAuth wall.

## The checklist renders `DRAFT_STEPS`, always

`generationStep` holds the key of the step in flight. The client renders the full `DRAFT_STEPS` list and marks every step *before* the stored one as done.

This is why no per-branch step list is needed: the generic brief path has no review pass, so it goes from `generating` straight to `saving`, and `reviewing` reads as done. That is accurate — there was nothing to do. Do **not** add a `BRIEF_STEPS` constant.

---

### Task 1: The `generationStep` column

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0060_*.sql` (generated, not hand-written)
- Test: `tests/db/content-pieces-schema.test.ts`

**Interfaces:**
- Produces: `contentPieces.generationStep`, nullable text. Every later task reads or writes it.

- [ ] **Step 1: Write the failing test**

Create `tests/db/content-pieces-schema.test.ts` (or append to the existing content-pieces schema test if one is already there — check first):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces } from "../../src/db/schema";

const TENANT = "Generation Step Schema Test Tenant";

describe("contentPieces.generationStep", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults to null and round-trips a step key", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, title: "T", body: "B", type: "product_update" })
      .returning();

    expect(piece.generationStep).toBeNull();

    const [updated] = await db
      .update(contentPieces)
      .set({ generationStep: "generating" })
      .where(eq(contentPieces.id, piece.id))
      .returning();

    expect(updated.generationStep).toBe("generating");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/content-pieces-schema.test.ts`
Expected: FAIL — `generationStep` does not exist on the insert/select type, or the column is missing at runtime.

- [ ] **Step 3: Add the column to the schema**

In `src/db/schema.ts`, inside `contentPieces`, next to `generatedAt`:

```ts
  // The DraftStepKey currently in flight (see lib/drafting/draft-progress.ts),
  // or null when nothing is generating. Persisted rather than streamed because
  // generation runs in `after()`, which has no open response to stream into —
  // the client polls this instead.
  //
  // Free text, not an enum: the step vocabulary lives in TypeScript, a piece
  // generated before this column existed reads null and renders as "no progress
  // information", and adding a step later must not need a migration.
  //
  // MUST be cleared in every terminal write — success, failure, and the
  // interrupted-generation marker. A piece left displaying a step it is no
  // longer running is worse than showing none.
  generationStep: text("generation_step"),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Confirm exactly one new file appeared under `src/db/migrations/` and that it contains a single `ALTER TABLE ... ADD COLUMN "generation_step" text;`. If it contains anything else, the schema has drifted — stop and report rather than applying it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/content-pieces-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/db/content-pieces-schema.test.ts
git commit -m "feat: persist the in-flight generation step"
```

---

### Task 2: Write progress from the drafting path

**Files:**
- Modify: `src/lib/briefs/draft.ts`
- Test: `tests/lib/briefs/draft.test.ts` (exists — extend it)

**Interfaces:**
- Consumes: `generationStep` from Task 1; `DraftStepKey` from `src/lib/drafting/draft-progress.ts`.
- Produces: `generateDraftForPiece` now advances `generationStep` and clears it on every exit. Task 3 reads what this writes.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/briefs/draft.test.ts`. Follow the file's existing fixture and mocking conventions — it already has a working `deps.generate` stub; reuse it rather than inventing a new one.

```ts
it("advances generationStep and clears it on success", async () => {
  const { tenant, piece } = await seedPieceWithBrief();
  const seen: (string | null)[] = [];

  await generateDraftForPiece(piece.id, tenant.id, {
    generate: async () => {
      const [mid] = await db
        .select({ step: contentPieces.generationStep })
        .from(contentPieces)
        .where(eq(contentPieces.id, piece.id));
      seen.push(mid.step);
      return { title: "T", body: "B" };
    },
  });

  // Observed from inside the generator: the step in flight is "generating".
  expect(seen).toEqual(["generating"]);

  const [after] = await db
    .select({ step: contentPieces.generationStep, generatedAt: contentPieces.generatedAt })
    .from(contentPieces)
    .where(eq(contentPieces.id, piece.id));
  expect(after.step).toBeNull();
  expect(after.generatedAt).not.toBeNull();
});

it("clears generationStep when generation throws", async () => {
  const { tenant, piece } = await seedPieceWithBrief();

  await generateDraftForPiece(piece.id, tenant.id, {
    generate: async () => {
      throw new Error("model exploded");
    },
  });

  const [after] = await db
    .select({ step: contentPieces.generationStep, generationError: contentPieces.generationError })
    .from(contentPieces)
    .where(eq(contentPieces.id, piece.id));
  expect(after.step).toBeNull();
  expect(after.generationError).toBe("model exploded");
});

it("clears generationStep when the piece is refused before generating", async () => {
  const { tenant, piece } = await seedPieceWithBrief();
  await db.update(contentPieces).set({ status: "published" }).where(eq(contentPieces.id, piece.id));

  const result = await generateDraftForPiece(piece.id, tenant.id, {
    generate: async () => {
      throw new Error("must not be called");
    },
  });

  expect(result.ok).toBe(false);
  const [after] = await db
    .select({ step: contentPieces.generationStep })
    .from(contentPieces)
    .where(eq(contentPieces.id, piece.id));
  expect(after.step).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/briefs/draft.test.ts`
Expected: FAIL — `generationStep` is never written, so the mid-generation read is null rather than `"generating"`.

- [ ] **Step 3: Add a private step writer and call it at each boundary**

In `src/lib/briefs/draft.ts`:

```ts
import type { DraftStepKey } from "@/lib/drafting/draft-progress";

/**
 * Records which step is in flight so the client's checklist can poll it.
 * Never throws: progress is cosmetic, and a failed progress write must not
 * abort a generation that is otherwise fine. Passing null clears it.
 */
async function setStep(
  database: Database,
  contentPieceId: string,
  step: DraftStepKey | null
): Promise<void> {
  try {
    await database
      .update(contentPieces)
      .set({ generationStep: step })
      .where(eq(contentPieces.id, contentPieceId));
  } catch (e) {
    console.error(`[briefs/draft] failed to record step ${step} for piece ${contentPieceId}:`, e);
  }
}
```

Call sites, in order through `generateDraftForPiece`:

- `"collecting"` — immediately after the status and `bodyEditedAt` guards pass, before the brief and evidence reads. **Not before the guards**: a piece refused for being published must not be left with a step written on it.
- `"preparing"` — before `prepareGenerationContext`.
- `"generating"` — folded into the existing interrupted-marker write at line 171, so it is one statement, not two:

```ts
    await database
      .update(contentPieces)
      .set({
        generationError: "Generation was interrupted before it finished. Retry to try again.",
        generationStep: "generating",
      })
      .where(eq(contentPieces.id, contentPieceId));
```

- `"saving"` — after the competitor-name scan, before the final write.
- Cleared by adding `generationStep: null` to the **final success write** (line 215) and to the **catch block's error write** (line 182). Both are existing statements — add the field, do not add a second update.
- Cleared in the outer `catch` too, before returning, via `setStep(database, contentPieceId, null)`.

> There are **four** early returns, not three, and they split into two groups.
>
> `piece not found`, wrong status, and `bodyEditedAt` all sit *before* the `"collecting"` write, so nothing has been written and no clear is needed — that is exactly why `"collecting"` goes after them.
>
> **`!brief` ("No brief is linked to this piece") sits *after* it, and must clear the step before returning.** It is a plain `return`, not a throw, so it never reaches the outer `catch`. Missing this leaves a piece permanently displaying `"collecting"` — caught in Task 2's review, recorded here so it is not reintroduced.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/briefs/draft.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 5: Delete each clear and confirm its test fails**

One at a time, reverting after each: remove `generationStep: null` from the success write, then from the catch write. Each must break its matching test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/briefs/draft.ts tests/lib/briefs/draft.test.ts
git commit -m "feat: record generation progress through the drafting path"
```

---

### Task 3: The tenant-scoped progress read

**Files:**
- Create: `src/lib/content/generation-progress.ts`
- Test: `tests/lib/content/generation-progress.test.ts`

**Interfaces:**
- Consumes: the column from Task 1.
- Produces: `readGenerationProgress(tenantId, contentPieceId, database?)` returning `GenerationProgress | null`. Task 4's server action wraps it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { readGenerationProgress } from "../../../src/lib/content/generation-progress";

const TENANT = "Generation Progress Test Tenant";
const OTHER = "Generation Progress Other Tenant";

async function seed(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post", status: "brief" })
    .returning();
  return { tenant, piece };
}

describe("readGenerationProgress", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(tenants).where(eq(tenants.name, OTHER));
  });

  it("returns the current step and terminal state", async () => {
    const { tenant, piece } = await seed(TENANT);
    await db
      .update(contentPieces)
      .set({ generationStep: "reviewing" })
      .where(eq(contentPieces.id, piece.id));

    const progress = await readGenerationProgress(tenant.id, piece.id);
    expect(progress).toEqual({
      generationStep: "reviewing",
      generatedAt: null,
      generationError: null,
      status: "brief",
    });
  });

  it("refuses a piece belonging to another tenant", async () => {
    const { piece } = await seed(TENANT);
    const { tenant: stranger } = await seed(OTHER);

    // Asserted by id: a query missing the tenant filter would still find this.
    expect(await readGenerationProgress(stranger.id, piece.id)).toBeNull();
  });

  it("returns null for a piece that does not exist", async () => {
    const { tenant } = await seed(TENANT);
    expect(
      await readGenerationProgress(tenant.id, "00000000-0000-0000-0000-000000000000")
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/content/generation-progress.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { contentPieces } from "@/db/schema";
import type { DraftStepKey } from "@/lib/drafting/draft-progress";

type Database = typeof defaultDb;

export type GenerationProgress = {
  generationStep: DraftStepKey | null;
  generatedAt: Date | null;
  generationError: string | null;
  status: (typeof contentPieces.$inferSelect)["status"];
};

/**
 * One piece's generation state, for the client's polling checklist.
 *
 * `generationStep` is free text in the database (see the schema comment) and is
 * asserted to `DraftStepKey` here. A value written by a future version of the
 * writer that this client does not know renders as an unrecognized step rather
 * than crashing the checklist — the caller must tolerate a key it cannot place.
 *
 * Returns null for a missing piece and for one belonging to another tenant,
 * deliberately without distinguishing them: the caller is a poll loop and has
 * nothing useful to do differently, and telling a stranger that an id exists is
 * information they should not have.
 */
export async function readGenerationProgress(
  tenantId: string,
  contentPieceId: string,
  database: Database = defaultDb
): Promise<GenerationProgress | null> {
  const [piece] = await database
    .select({
      generationStep: contentPieces.generationStep,
      generatedAt: contentPieces.generatedAt,
      generationError: contentPieces.generationError,
      status: contentPieces.status,
    })
    .from(contentPieces)
    .where(and(eq(contentPieces.id, contentPieceId), eq(contentPieces.tenantId, tenantId)))
    .limit(1);

  if (!piece) return null;

  return {
    generationStep: piece.generationStep as DraftStepKey | null,
    generatedAt: piece.generatedAt,
    generationError: piece.generationError,
    status: piece.status,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/content/generation-progress.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Delete the guard and confirm the test fails**

Remove `eq(contentPieces.tenantId, tenantId)` — the cross-tenant test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/lib/content/generation-progress.ts tests/lib/content/generation-progress.test.ts
git commit -m "feat: read a piece's generation progress"
```

---

### Task 4: Poll and render the checklist

**Files:**
- Create: `src/app/(dashboard)/board/progress-actions.ts`
- Create: `src/app/(dashboard)/board/generation-checklist.tsx`
- Modify: `src/app/(dashboard)/board/card.tsx`
- Test: `tests/components/generation-checklist.test.tsx`

**Interfaces:**
- Consumes: `readGenerationProgress` and `GenerationProgress` from Task 3; `DRAFT_STEPS` / `DraftStepKey` from `src/lib/drafting/draft-progress.ts`.
- Produces: `<GenerationChecklist contentPieceId />`, rendered by `BoardCard`.

- [ ] **Step 1: Write the server action**

`src/app/(dashboard)/board/progress-actions.ts`:

```ts
"use server";

import { requireSession } from "@/lib/workspace/session";
import { readGenerationProgress, type GenerationProgress } from "@/lib/content/generation-progress";

export async function pollGenerationProgress(
  contentPieceId: string
): Promise<GenerationProgress | null> {
  const session = await requireSession();
  return readGenerationProgress(session.user.tenantId, contentPieceId);
}
```

No `revalidatePath` — this is a read on a hot loop and revalidating on every poll would refetch the whole page.

- [ ] **Step 2: Write the checklist component**

`generation-checklist.tsx` is `"use client"` and imports **types only** from the lib modules.

Behaviour:
- Renders `DRAFT_STEPS` in order. Given the current key, every step at a lower index is done, that step is in flight, later ones pending.
- Polls `pollGenerationProgress(contentPieceId)` every 3 seconds.
- **Stops** on either terminal condition: `generatedAt` is non-null, or `generationError` is set and `generationStep` is null. Also stops if the read returns null (the piece was deleted).
- Clears its interval on unmount — a board can hold many of these and a leaked timer per card compounds.
- An unrecognized step key (not in `DRAFT_STEPS`) renders as no step in flight rather than throwing.

- [ ] **Step 3: Render it on the awaiting-generation card**

In `src/app/(dashboard)/board/card.tsx`, the `brief`-status branch currently shows an "Awaiting generation" badge ([card.tsx:155](src/app/(dashboard)/board/card.tsx:155)). Keep that badge as the idle state and render the checklist beneath it **only while `card.generationStep` is non-null** — a piece awaiting generation that has not started should not show a half-lit checklist.

This requires `generationStep` on the `BoardCard` type and in `readBoard`'s select (`src/lib/content/board.ts`). Add it, and add a line to the board read's test asserting it comes through.

- [ ] **Step 4: Write the component test**

`tests/components/generation-checklist.test.tsx`, following the conventions of the existing files in `tests/components/`: steps before the current render done, the current renders in flight, polling stops once `generatedAt` is set, and an unknown key does not throw.

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/components/generation-checklist.test.tsx && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. The build is the gate for a server-module leak into the client component.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: live generation checklist on the board"
```

---

### Task 5: Fork the drafting path on content type

**Files:**
- Modify: `src/lib/briefs/draft.ts`
- Modify: `src/lib/change-events/release-claim.ts`
- Test: `tests/lib/briefs/draft.test.ts`, `tests/lib/change-events/release-claim.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: `generateDraftForPiece` routes `product_update` briefs carrying shipped-work signals through `generateReleaseDraft`; `linkAtomicUpdatesToPiece` replaces the piece-creating half of `claimReleaseFromAtomicUpdates`.

- [ ] **Step 1: Write the failing tests**

Cover, using injected generators so neither real model is called:
- A `product_update` brief with a shipped-work signal calls the **release** generator, not the brief one.
- A `product_update` brief with no shipped-work signal calls the **brief** generator.
- A `blog_post` brief with a shipped-work signal calls the **brief** generator.
- Non-shipped-work evidence on a product-update brief still reaches the release generator's prompt input.
- A signal whose atomic update belongs to another tenant contributes no atomic update.
- The release branch links its atomic updates to the **existing** piece and flips them to `released` — and creates no second piece (assert the tenant's `contentPieces` count is unchanged).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/lib/briefs/draft.test.ts`
Expected: FAIL — every brief currently takes the generic path.

- [ ] **Step 3: Narrow the claim**

In `src/lib/change-events/release-claim.ts`, add `linkAtomicUpdatesToPiece({ tenantId, contentPieceId, atomicUpdateIds }, database)`: sets `contentPieceId` and `status: "released"` on those atomic updates, tenant-scoped, in one transaction. It does **not** create a content piece.

Leave `claimReleaseFromAtomicUpdates` in place until Task 6 removes its last caller — deleting it here breaks `compose-draft.ts`, which is still wired to the live API route.

- [ ] **Step 4: Add the fork**

In `generateDraftForPiece`, after the evidence read: when `brief.contentType === "product_update"`, load the atomic updates behind the brief's `shipped_work` signals (`briefSignals` → `signals.atomicUpdateId` → `atomicUpdates`, tenant-scoped). If any exist, run the release pipeline — `prepareGenerationContext` with `atomicUpdateCategories`, `generateReleaseDraft`, `reviewAndReconcile`, `validateDraftLinks` — and save through `linkAtomicUpdatesToPiece` transactionally with the body write. Otherwise fall through to the existing generic path unchanged.

The `reviewing` step key is written around `reviewAndReconcile`, which is why the generic path skips it.

- [ ] **Step 5: Run the tests, then the full suite**

Run: `npx vitest run tests/lib/briefs/draft.test.ts && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: draft product updates through the unified path"
```

---

### Task 6: Retire the parallel drafting path

**Files:**
- Delete: `src/app/api/atomic-updates/draft/route.ts`, `src/lib/drafting/compose-draft.ts`
- Modify: `src/lib/change-events/release-claim.ts` — drop `claimReleaseFromAtomicUpdates`

> **Do NOT delete `src/lib/drafting/read-draft-progress.ts` or `draft-progress.ts`.** `/api/drafts/edit` and `/api/drafts/extract` still stream through them, read by `drafts/[releaseId]/agent-edit-dialog.tsx` and `extract-dialog.tsx`. Verified, not assumed. `DRAFT_STEPS` is also now used by Task 4's checklist.

- [ ] **Step 1: Confirm the route has no remaining caller**

```bash
grep -rn "api/atomic-updates/draft\|runBatchForWorkspace\|claimReleaseFromAtomicUpdates" src --include="*.ts" --include="*.tsx"
```

The only hits should be `draft-release-dialog.tsx`, which spec 10's Task 6 deletes. If that dialog is still present, **stop** — this task and spec 10's Task 6 must land together or the dialog will call a deleted route.

- [ ] **Step 2: Delete and clean up**

Remove the route, `compose-draft.ts`, and `claimReleaseFromAtomicUpdates` with its now-dead tests.

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npm run lint && npm run build && npm test`
Expected: all pass. Re-run any failing file once before believing it.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: retire the parallel atomic-update drafting route"
```

---

## Coordination with spec 10

Spec 10's Task 6 (deleting the tabs) and this plan's Task 6 remove two halves of the same thing. Land spec 10's Tasks 1–5 and this plan's Tasks 1–5 in either order, then the two Task 6s together.
