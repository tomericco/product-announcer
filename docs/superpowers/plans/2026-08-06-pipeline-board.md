# Pipeline Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A board showing every content piece by pipeline stage, with assignment and date-and-time scheduling.

**Architecture:** A new `/board` route alongside `/drafts` and `/briefs`, reading the same `content_pieces`. `src/lib/content/board.ts` owns the grouped read and the two mutations so both are testable without mocking Next internals. The transition rules are enforced server-side, not merely by which drop targets the client renders.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM 0.45.2, Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-pipeline-board-design.md`

## Global Constraints

- **This is NOT the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router code. `searchParams` is a Promise and must be awaited.
- **`npm run build` is a mandatory gate, ahead of the test suite.** It has caught a `"use server"` export-rule break twice in this project that the whole suite missed. Files carrying `"use server"` may export ONLY async functions.
- **Never import a runtime value from a server module into a `"use client"` file.** Pass values down as props — this project shipped an AI-SDK-into-the-browser bug that way.
- **The tests are the contract. If prose and a code sample in this plan disagree, STOP and report it.** Implementers on the previous four plans did this ten times and were right every time — the plan was wrong, not them.
- **A comment that promises behaviour the code does not implement is a bug.**
- **When you add a test to guard a behaviour, delete the guard and confirm the test fails.**
- **Every query and mutation must be tenant-scoped.** The piece id and target status arrive from a browser.
- No schema change in this plan. `assignedTo` and `scheduledFor` already exist.
- The suite is FLAKY (~168 files, one shared Postgres). If a file you did not touch fails, do NOT conclude "pre-existing" from a stash test alone.
- The UI cannot be visually verified — the dev preview is behind an OAuth wall. Do not attempt it and do not report visual confirmation you did not obtain.
- Commit after each task. Do NOT push. Do NOT merge.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/content/board.ts` | grouped read, `moveContentPiece`, `assignContentPiece`, the transition table | 1, 2 |
| `src/app/(dashboard)/board/actions.ts` | thin `"use server"` wrappers | 3 |
| `src/app/(dashboard)/board/{page,board,column,card}.tsx` | the board | 3 |
| `src/app/(dashboard)/nav-links.tsx` | a Board entry | 3 |

---

### Task 1: The board read

**Files:**
- Create: `src/lib/content/board.ts`
- Test: `tests/lib/content/board.test.ts`

**Interfaces:**
- Produces:
```typescript
export const BOARD_COLUMNS = ["brief", "draft", "review", "scheduled", "published"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const PUBLISHED_COLUMN_LIMIT = 20;
export type BoardCard = {
  id: string; title: string; type: ContentPiece["type"]; status: BoardColumn;
  assignedTo: string | null; scheduledFor: Date | null;
  generationError: string | null; generatedAt: Date | null; createdAt: Date;
};
export async function readBoard(tenantId: string, database?): Promise<Record<BoardColumn, BoardCard[]>>;
```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";
import { readBoard, BOARD_COLUMNS, PUBLISHED_COLUMN_LIMIT } from "../../../src/lib/content/board";

const TENANT = "Board Read Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function seedPiece(tenantId: string, overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId, type: "blog_post", title: "A piece", body: "b", ...overrides })
    .returning();
  return piece;
}

describe("readBoard", () => {
  it("returns every column, empty ones included", async () => {
    const tenant = await seedTenant();
    const board = await readBoard(tenant.id, db);
    // A column missing from the object would render as a missing column, not
    // an empty one — the board must always show the whole pipeline.
    expect(Object.keys(board).sort()).toEqual([...BOARD_COLUMNS].sort());
    for (const c of BOARD_COLUMNS) expect(board[c]).toEqual([]);
  });

  it("groups pieces by status", async () => {
    const tenant = await seedTenant();
    await seedPiece(tenant.id, { title: "B", status: "brief" });
    await seedPiece(tenant.id, { title: "D", status: "draft" });
    await seedPiece(tenant.id, { title: "R", status: "review" });

    const board = await readBoard(tenant.id, db);
    expect(board.brief.map((c) => c.title)).toEqual(["B"]);
    expect(board.draft.map((c) => c.title)).toEqual(["D"]);
    expect(board.review.map((c) => c.title)).toEqual(["R"]);
    expect(board.scheduled).toEqual([]);
  });

  it("caps the published column", async () => {
    const tenant = await seedTenant();
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `P${i}`, status: "published" });
    }
    const board = await readBoard(tenant.id, db);
    // Published grows without bound and would otherwise dominate the board;
    // /history is the full record.
    expect(board.published).toHaveLength(PUBLISHED_COLUMN_LIMIT);
  });

  it("does not cap the working columns", async () => {
    const tenant = await seedTenant();
    for (let i = 0; i < PUBLISHED_COLUMN_LIMIT + 4; i++) {
      await seedPiece(tenant.id, { title: `D${i}`, status: "draft" });
    }
    const board = await readBoard(tenant.id, db);
    // Hiding work in flight is the one thing a board must never do.
    expect(board.draft).toHaveLength(PUBLISHED_COLUMN_LIMIT + 4);
  });

  it("returns only the calling tenant's pieces", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedPiece(mine.id, { title: "Mine", status: "draft" });
    await seedPiece(other.id, { title: "Theirs", status: "draft" });

    const board = await readBoard(mine.id, db);
    expect(board.draft.map((c) => c.title)).toEqual(["Mine"]);
  });

  it("carries the fields a card renders", async () => {
    const tenant = await seedTenant();
    const when = new Date("2026-09-01T09:00:00Z");
    await seedPiece(tenant.id, { status: "scheduled", scheduledFor: when, generationError: "warned" });

    const [card] = (await readBoard(tenant.id, db)).scheduled;
    expect(card.scheduledFor?.toISOString()).toBe(when.toISOString());
    expect(card.generationError).toBe("warned");
  });
});
```

**Verified for you:** `contentPieces` requires `tenantId`, `title` and `body` (NOT NULL, no default). `status` defaults to `"draft"` and `type` to `"product_update"`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/content/board.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the read**

`readBoard` selects the card fields for the tenant, orders by `createdAt` descending (**`contentPieces` has no `updatedAt` column** — an earlier draft of this plan assumed one; do not add it, and do not substitute `composedAt`, which means when the body was first composed, not when the row last changed), and groups into an object seeded with every column so an empty column is `[]` rather than absent. The published column is sliced to `PUBLISHED_COLUMN_LIMIT` **after** ordering, so the newest survive; the working columns are never capped.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/lib/content/board.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 5: Prove two guards bite**

1. Build the result from the rows alone instead of seeding every column. "returns every column, empty ones included" must FAIL.
2. Apply the published cap to all columns. "does not cap the working columns" must FAIL.

Restore each and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/content/board.ts tests/lib/content/board.test.ts
git commit -m "feat: read content pieces grouped by pipeline stage"
```

---

### Task 2: Moves and assignment, with the rules enforced server-side

**Files:**
- Modify: `src/lib/content/board.ts`
- Test: `tests/lib/content/board.test.ts`

**Interfaces:**
- Consumes: `BoardColumn` (Task 1).
- Produces:
```typescript
export type MoveResult = { ok: true } | { ok: false; error: string };
export function canMove(from: BoardColumn, to: BoardColumn): boolean;
export async function moveContentPiece(
  contentPieceId: string, tenantId: string, to: BoardColumn,
  opts?: { scheduledFor?: Date | null }, database?
): Promise<MoveResult>;
export async function assignContentPiece(
  contentPieceId: string, tenantId: string, userId: string | null, database?
): Promise<MoveResult>;
```

**The rules, and why each exists.** These are not UI conveniences — the id and target status arrive from a browser, so the client declining to render a drop target guarantees nothing.

| Move | Allowed | Why |
|---|---|---|
| `draft ↔ review ↔ scheduled` | yes | planning states a human owns; nothing outside the row changes |
| anything → `published` | **no** | publishing dispatches to LinkedIn/Webflow/webhook and has delivery records; `publishDraft` carries guards a move would bypass |
| anything → `brief`, or `brief` → anything | **no** | a `brief` body is the accept-time scaffold. Moving it to `draft` presents that scaffold as finished — what spec 5c's status fix and the `approveDraft`/`publishDraft` guards exist to prevent. Generation is the only way out of `brief`. |
| `published` → anything | **no** | it has shipped |

- [ ] **Step 1: Write the failing tests**

```typescript
import { canMove, moveContentPiece, assignContentPiece } from "../../../src/lib/content/board";
import { users, tenantMembers } from "../../../src/db/schema";

describe("canMove", () => {
  it("allows movement among the planning states", () => {
    expect(canMove("draft", "review")).toBe(true);
    expect(canMove("review", "scheduled")).toBe(true);
    expect(canMove("scheduled", "review")).toBe(true);
    expect(canMove("review", "draft")).toBe(true);
  });

  it("never allows a move into published", () => {
    // Publishing dispatches to external destinations and has guards a board
    // move would bypass. It stays the explicit action on the draft page.
    for (const from of ["brief", "draft", "review", "scheduled"] as const) {
      expect(canMove(from, "published")).toBe(false);
    }
  });

  it("never allows a move into or out of brief", () => {
    // A brief-status body is the accept-time scaffold. Moving it to draft
    // would present that scaffold as a finished draft.
    for (const to of ["draft", "review", "scheduled"] as const) {
      expect(canMove("brief", to)).toBe(false);
    }
    for (const from of ["draft", "review", "scheduled"] as const) {
      expect(canMove(from, "brief")).toBe(false);
    }
  });

  it("never allows a move out of published", () => {
    for (const to of ["draft", "review", "scheduled"] as const) {
      expect(canMove("published", to)).toBe(false);
    }
  });
});

describe("moveContentPiece", () => {
  it("moves a draft into review", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "draft" });

    expect(await moveContentPiece(piece.id, tenant.id, "review", {}, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("review");
  });

  it("refuses a move the rules forbid and changes nothing", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "draft" });

    // The client renders no such drop target. That is not a guarantee.
    const result = await moveContentPiece(piece.id, tenant.id, "published", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("draft");
  });

  it("refuses to drag an ungenerated piece into draft", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "brief", body: "SCAFFOLD" });

    const result = await moveContentPiece(piece.id, tenant.id, "draft", {}, db);
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.status).toBe("brief");
    expect(after.body).toBe("SCAFFOLD");
  });

  it("requires a scheduled time when entering scheduled", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, { status: "review" });

    expect((await moveContentPiece(piece.id, tenant.id, "scheduled", {}, db)).ok).toBe(false);

    const when = new Date("2026-09-01T09:00:00Z");
    expect(await moveContentPiece(piece.id, tenant.id, "scheduled", { scheduledFor: when }, db)).toEqual({ ok: true });
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.scheduledFor?.toISOString()).toBe(when.toISOString());
  });

  it("clears the scheduled time on the way out", async () => {
    const tenant = await seedTenant();
    const piece = await seedPiece(tenant.id, {
      status: "scheduled",
      scheduledFor: new Date("2026-09-01T09:00:00Z"),
    });

    await moveContentPiece(piece.id, tenant.id, "review", {}, db);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    // The calendar reads scheduledFor. A piece no longer scheduled must not
    // keep a date the calendar would still draw.
    expect(after.scheduledFor).toBeNull();
  });

  it("refuses a piece belonging to another tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedPiece(other.id, { status: "draft" });

    expect((await moveContentPiece(theirs.id, mine.id, "review", {}, db)).ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, theirs.id));
    expect(after.status).toBe("draft");
  });
});

describe("assignContentPiece", () => {
  async function seedMember(tenantId: string, email: string) {
    const [user] = await db.insert(users).values({ email, name: "M" }).returning();
    await db.insert(tenantMembers).values({ tenantId, userId: user.id, role: "member" });
    return user;
  }

  it("assigns a workspace member, and unassigns with null", async () => {
    const tenant = await seedTenant();
    const member = await seedMember(tenant.id, `m${Date.now()}@example.com`);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    expect(await assignContentPiece(piece.id, tenant.id, member.id, db)).toEqual({ ok: true });
    let [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBe(member.id);

    expect(await assignContentPiece(piece.id, tenant.id, null, db)).toEqual({ ok: true });
    [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBeNull();
  });

  it("refuses a user who is not in the workspace", async () => {
    const tenant = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const outsider = await seedMember(other.id, `o${Date.now()}@example.com`);
    const piece = await seedPiece(tenant.id, { status: "draft" });

    // The user id comes from a form. Assigning an outsider would put a piece
    // in a queue belonging to someone who cannot see the workspace.
    expect((await assignContentPiece(piece.id, tenant.id, outsider.id, db)).ok).toBe(false);
    const [after] = await db.select().from(contentPieces).where(eq(contentPieces.id, piece.id));
    expect(after.assignedTo).toBeNull();
  });
});
```

**Verified for you:** `users` requires only `email` (NOT NULL and **unique** — hence the `Date.now()` in the fixtures; two tests seeding the same literal address would collide in the shared database). `tenantMembers` requires `tenantId` and `userId`; the fixture sets `role` explicitly regardless.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/content/board.test.ts
```

Expected: FAIL — `canMove` is not exported.

- [ ] **Step 3: Implement**

`canMove` is a lookup over an explicit allowed-pairs table, not a set of negations — a table is readable and a negation list silently permits whatever nobody thought to forbid.

`moveContentPiece`: load the piece scoped to `tenantId`; return `{ ok: false }` if absent; reject unless `canMove(piece.status, to)`; require `scheduledFor` when `to === "scheduled"` and write it; set `scheduledFor: null` on any move away from `scheduled`; update `status` only — there is no `updatedAt` column on this table.

`assignContentPiece`: load the piece scoped to `tenantId`; when `userId` is non-null, confirm a `tenantMembers` row joins that user to this tenant before writing.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/content/board.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 5: Prove four guards bite**

1. Make `canMove` return `true` unconditionally — the "never allows" tests must FAIL.
2. Drop the tenant predicate from `moveContentPiece`'s load — "refuses a piece belonging to another tenant" must FAIL.
3. Remove the `scheduledFor: null` on exit — "clears the scheduled time on the way out" must FAIL.
4. Remove the membership check in `assignContentPiece` — "refuses a user who is not in the workspace" must FAIL.

Restore each and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/content/board.ts tests/lib/content/board.test.ts
git commit -m "feat: move and assign content pieces, with the rules enforced server-side"
```

---

### Task 3: The board UI

**Files:**
- Create: `src/app/(dashboard)/board/page.tsx`, `board.tsx`, `column.tsx`, `card.tsx`, `actions.ts`
- Modify: `src/app/(dashboard)/nav-links.tsx`

**Interfaces:**
- Consumes: `readBoard`, `moveContentPiece`, `assignContentPiece`, `BOARD_COLUMNS`, `BoardCard` (Tasks 1–2); `listWorkspaceMembers(tenantId, database?)` from `src/lib/workspace/members.ts`, returning `{ userId, email, name, role, createdAt }[]`; `generateDraft(contentPieceId)` from `src/app/(dashboard)/briefs/actions.ts`.

- [ ] **Step 1: Build the page**

`page.tsx` is an async Server Component: `requireSession`, then `readBoard` and `listWorkspaceMembers` for that tenant. If it reads `searchParams` (for the assignee filter) it must **await** it — a Promise in Next.js 16; copy the pattern from `src/app/(dashboard)/signals/page.tsx`.

Five columns in `BOARD_COLUMNS` order, each headed with its name and count.

- [ ] **Step 2: Build the card**

Title (linking to `/drafts/[id]`), content-type badge, assignee picker, and `scheduledFor` when set, rendered in local time.

On a `brief`-status card, show that it is awaiting generation — with `generationError` if set — and a **Generate draft** button calling `generateDraft`. That is the only way out of `brief`; there is no drag.

On a `draft`-status card with `generationError` set, show it as a warning rather than a failure. That combination means the post-generation name scan matched something, not that generation failed.

- [ ] **Step 3: Wire the moves**

**Use `@dnd-kit/core` for the drag interaction. Do not hand-roll it.** Install it
(`npm install @dnd-kit/core`); version 6.3.1 declares `react: ">=16.8.0"`, which
this project's React 19.2.4 satisfies, so there is no peer conflict and no
`--legacy-peer-deps`. If the install reports one anyway, STOP and report rather
than forcing it.

`@dnd-kit/core` alone — **not** `@dnd-kit/sortable`. The board never reorders
within a column; `readBoard` returns each column already ordered by `createdAt`
descending and the only gesture is moving a card between columns. Sortable would
add reordering semantics with no column to persist them to.

Use `DndContext` around the board, `useDraggable` on cards, `useDroppable` on
columns, and `onDragEnd` to call the action. Take dnd-kit's keyboard sensor as
well as the pointer one — a board that can only be operated by mouse is worse
than a board with buttons.

`actions.ts` carries `"use server"` and may export **only async functions** — a synchronous export there breaks the production build while every test passes. Two thin wrappers taking the session's tenant and delegating to Task 2:

```typescript
export async function moveCard(id: string, to: BoardColumn, scheduledForIso?: string): Promise<MoveResult>
export async function assignCard(id: string, userId: string | null): Promise<MoveResult>
```

Render drop targets only for moves `canMove` permits, so the UI matches the server. `published` is read-only and `brief` accepts no drops.

On `{ ok: false }` show `result.error`. Do not swallow it — a refused move must not look like a successful one.

- [ ] **Step 4: The scheduling picker**

Entering `scheduled` opens a picker for **date and time**, not date alone. Use a native `datetime-local` input, which yields local wall-clock time; convert to an instant before sending, and render `scheduledFor` back in local time so a piece scheduled for 09:00 reads as 09:00.

Say in the UI that scheduling does not publish — nothing auto-publishes at that time, and a column called "scheduled" otherwise reads as a promise the system does not keep.

- [ ] **Step 5: Nav**

Add a Board entry to the `NAV` array in `src/app/(dashboard)/nav-links.tsx` with a lucide icon that is not already imported there (`Columns3` fits).

- [ ] **Step 6: Verify**

```bash
npm run build
npm run typecheck
npx eslint "src/app/(dashboard)/board" src/app/\(dashboard\)/nav-links.tsx
npm run test
npm run test
```

**Browser verification is NOT possible** — the dev preview is behind an OAuth wall. Do not attempt it, do not start a dev server, and state plainly in your report that the UI was not visually verified.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/board" "src/app/(dashboard)/nav-links.tsx"
git commit -m "feat: the pipeline board"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `/board`, five columns, nothing replaced | 1, 3 |
| Cards show type, assignee, scheduledFor, generation state | 1 (fields), 3 (render) |
| `brief → draft` is generation, not a drag | 2 (`canMove`), 3 (Generate button) |
| Nothing draggable into `published` | 2 (`canMove`), 3 (read-only column) |
| `draft ↔ review ↔ scheduled` draggable | 2 |
| Rules enforced server-side | 2 (all four guard proofs) |
| Scheduling takes date AND time | 3 (step 4) |
| Leaving `scheduled` clears `scheduledFor` | 2 |
| No auto-publish, and the UI says so | 3 (step 4) |
| Assignment from workspace members, advisory | 2, 3 |
| Published column capped, link to `/history` | 1, 3 |
| No schema change | — none made |

**Type consistency:** `BoardColumn` and `BoardCard` are defined in Task 1 and consumed under those names in Tasks 2 and 3. `MoveResult` is defined in Task 2 and is the return type of Task 3's wrappers.

**Known gaps carried forward:**

- Retiring `/drafts` in favour of the board.
- The briefs rail from the design doc.
- `reviewStatus` (the AI review) and the `review` pipeline status have confusingly similar names and are unrelated.
