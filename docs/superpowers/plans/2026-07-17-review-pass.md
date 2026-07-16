# Post-Generation Review Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a draft is generated, review it against the brand requirements; if it violates them, rewrite once and re-check; store the (possibly revised) draft with its review outcome; gate auto-publish on the result and surface the outcome in the drafts UI.

**Architecture:** A new `review-draft.ts` module reviews and reconciles a draft (`reviewAndReconcile`). `runBatchForWorkspace` calls it between generation and storage; `claimBatchAndCreateUpdate` persists the outcome on new `updates` columns; the auto-publish gate requires a passing review. The drafts list/detail surface the status via a pure `reviewStatusLabel` helper.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres, `ai` v7 (`generateObject`), Zod, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`; this plan touches no new Next.js APIs.
- **Review model:** `process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"`.
- **Statuses:** `passed` (compliant first check) / `revised` (rewritten, now compliant) / `failed` (still non-compliant after one revision) / `error` (review unavailable after a retry). `passed` and `revised` allow auto-publish; `failed` and `error` block it.
- **Retry policy:** the FIRST review is retried once on error; the re-review of a revision is a single call (no retry). If review still errors after the retry → `error`, fail-safe (held as draft).
- **The review runs on every generated update** (scheduled, threshold, and manual `runNow` all go through `runBatchForWorkspace`).
- **Scope:** brand-voice compliance only (tone / reading level / do / don't / preferred phrasing) — not factual accuracy; one revision pass; no re-run/override UI.
- Test command: `npm test` (`vitest run`); `npm test -- <name>` filters. Migrations: `npm run db:generate` then `npm run db:migrate`. Type-check: `npx tsc --noEmit`.

---

### Task 1: Review columns on `updates` + migration

**Files:**
- Modify: `src/db/schema.ts` (add `reviewStatusEnum` near line 50; add 3 columns to the `updates` table)
- Create: `src/db/migrations/0012_*.sql` (generated)
- Test: `tests/lib/update-review-columns.test.ts`

**Interfaces:**
- Produces: `updates.reviewStatus` (`review_status` enum `passed`/`revised`/`failed`/`error`, nullable), `updates.reviewIssues` (`review_issues` jsonb `string[]` default `[]`), `updates.reviewedAt` (`reviewed_at` timestamptz nullable). Consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/update-review-columns.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, updates } from "../../src/db/schema";

const NAME = "Review Columns Test Tenant";

describe("updates review columns", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, NAME));
  });

  it("defaults review columns and round-trips a review outcome", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db
      .insert(updates)
      .values({ tenantId: tenant.id, title: "t", body: "b", category: "new", sourceItems: [] })
      .returning();
    expect(defaulted.reviewStatus).toBeNull();
    expect(defaulted.reviewIssues).toEqual([]);
    expect(defaulted.reviewedAt).toBeNull();

    const [reviewed] = await db
      .insert(updates)
      .values({
        tenantId: tenant.id, title: "t2", body: "b2", category: "improved", sourceItems: [],
        reviewStatus: "failed", reviewIssues: ["too salesy", "wrong tone"], reviewedAt: new Date(),
      })
      .returning();
    expect(reviewed.reviewStatus).toBe("failed");
    expect(reviewed.reviewIssues).toEqual(["too salesy", "wrong tone"]);
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- update-review-columns`
Expected: FAIL — DB error `column "review_status" of relation "updates" does not exist`.

- [ ] **Step 3: Add the enum and columns to the schema**

In `src/db/schema.ts`, add the enum immediately after the `updateStatusEnum` declaration (line 50):

```ts
export const reviewStatusEnum = pgEnum("review_status", ["passed", "revised", "failed", "error"]);
```

Inside the `updates` table definition, after the `editedBy` column and before the closing `});`, add:

```ts
  reviewStatus: reviewStatusEnum("review_status"),
  reviewIssues: jsonb("review_issues").$type<string[]>().notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
```

(`pgEnum`, `jsonb`, and `timestamp` are already imported.)

- [ ] **Step 4: Generate and apply the migration**

Run: `npm run db:generate`
Expected: creates `src/db/migrations/0012_*.sql` with `CREATE TYPE "review_status"` and three `ALTER TABLE "updates" ADD COLUMN` statements.

Run: `npm run db:migrate`
Expected: applies cleanly.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- update-review-columns`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all existing tests still PASS (additive change).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/update-review-columns.test.ts
git commit -m "feat: add review columns to updates"
```

---

### Task 2: `review-draft` module

**Files:**
- Create: `src/lib/review-draft.ts`
- Test: `tests/lib/review-draft.test.ts`

**Interfaces:**
- Consumes: `UpdateDraft` type from `./generation`.
- Produces:
  - `ReviewResultSchema` (Zod) / `ReviewResult = { compliant: boolean; issues: string[]; revised: { title: string; body: string } | null }`
  - `type ReviewStatus = "passed" | "revised" | "failed" | "error"`
  - `type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] }`
  - `buildReviewPrompt(draft, brandProfile): string`
  - `reviewDraft(draft, brandProfile): Promise<ReviewResult>`
  - `reviewAndReconcile(draft, brandProfile): Promise<ReviewOutcome>`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/review-draft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildReviewPrompt, reviewAndReconcile } from "../../src/lib/review-draft";

const draft = { title: "Big news!!!", body: "Buy now.", category: "new" as const };
const brand = { tone: "calm", readingLevel: "simple", doList: ["be factual"], dontList: ["hype"], examplePhrases: ["ship"], industry: null, userPersonas: [] };

function ok(object: unknown) { return { object } as never; }

describe("buildReviewPrompt", () => {
  it("includes the brand rules and the draft", () => {
    const prompt = buildReviewPrompt(draft, brand as never);
    expect(prompt).toContain("Tone: calm.");
    expect(prompt).toContain("Reading level: simple.");
    expect(prompt).toContain("Do: be factual.");
    expect(prompt).toContain("Avoid: hype.");
    expect(prompt).toContain("Preferred phrasing: ship.");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("Buy now.");
  });
});

describe("reviewAndReconcile", () => {
  beforeEach(() => vi.mocked(generateObject).mockReset());

  it("returns passed and the original draft when the first review is compliant", async () => {
    vi.mocked(generateObject).mockResolvedValue(ok({ compliant: true, issues: [], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "passed", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("revises and returns 'revised' when the rewrite becomes compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["too hypey"], revised: { title: "News", body: "We shipped X." } }))
      .mockResolvedValueOnce(ok({ compliant: true, issues: [], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("revised");
    expect(out.finalDraft).toEqual({ title: "News", body: "We shipped X.", category: "new" });
    expect(out.issues).toEqual([]);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("returns 'failed' with issues when the rewrite is still non-compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["too hypey"], revised: { title: "News", body: "Still hype." } }))
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["still hypey"], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.issues).toEqual(["still hypey"]);
    expect(out.finalDraft).toEqual({ title: "News", body: "Still hype.", category: "new" });
  });

  it("returns 'failed' with the original draft when non-compliant with no revision offered", async () => {
    vi.mocked(generateObject).mockResolvedValue(ok({ compliant: false, issues: ["bad"], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "failed", issues: ["bad"] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("retries the first review once, then returns 'error' if it keeps failing", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("review down"));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "error", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- review-draft`
Expected: FAIL — `Cannot find module '../../src/lib/review-draft'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/review-draft.ts`:

```ts
import { generateObject } from "ai";
import { z } from "zod";
import type { brandProfiles } from "../db/schema";
import type { UpdateDraft } from "./generation";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

export const ReviewResultSchema = z.object({
  compliant: z.boolean(),
  issues: z.array(z.string()),
  revised: z.object({ title: z.string(), body: z.string() }).nullable(),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export type ReviewStatus = "passed" | "revised" | "failed" | "error";
export type ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] };

const REVIEW_SYSTEM = [
  "You are a brand-compliance reviewer for product update announcements.",
  "Check the draft against the brand requirements.",
  "If it fully complies, set compliant true, issues [], revised null.",
  "If it violates any requirement, set compliant false, list the specific issues, and provide a revised",
  "title and body that fix them while keeping the same facts.",
].join(" ");

export function buildReviewPrompt(draft: UpdateDraft, brandProfile: BrandProfileRow): string {
  const rules = [
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
    brandProfile.examplePhrases.length > 0 ? `Preferred phrasing: ${brandProfile.examplePhrases.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  const rubric = rules.length > 0 ? rules.join(" ") : "No specific brand requirements are configured.";
  return `Brand requirements:\n${rubric}\n\nDraft to review:\nTitle: ${draft.title}\nBody:\n${draft.body}`;
}

export async function reviewDraft(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewResult> {
  const result = await generateObject({
    model: process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: ReviewResultSchema,
    system: REVIEW_SYSTEM,
    prompt: buildReviewPrompt(draft, brandProfile),
  });
  return result.object;
}

/**
 * Reviews a draft against brand requirements and reconciles the outcome:
 * passed (compliant first try), revised (rewritten and now compliant), failed
 * (still non-compliant after one rewrite), or error (review unavailable after a
 * retry — fail-safe, held as draft). The first review is retried once on error;
 * the re-review of a revision is a single call.
 */
export async function reviewAndReconcile(draft: UpdateDraft, brandProfile: BrandProfileRow): Promise<ReviewOutcome> {
  let first: ReviewResult;
  try {
    first = await reviewDraft(draft, brandProfile);
  } catch {
    try {
      first = await reviewDraft(draft, brandProfile);
    } catch {
      return { finalDraft: draft, status: "error", issues: [] };
    }
  }

  if (first.compliant) return { finalDraft: draft, status: "passed", issues: [] };
  if (!first.revised) return { finalDraft: draft, status: "failed", issues: first.issues };

  const revisedDraft: UpdateDraft = { title: first.revised.title, body: first.revised.body, category: draft.category };

  let second: ReviewResult;
  try {
    second = await reviewDraft(revisedDraft, brandProfile);
  } catch {
    // Re-review failed; keep the revision but hold it (can't confirm compliance).
    return { finalDraft: revisedDraft, status: "failed", issues: first.issues };
  }

  return second.compliant
    ? { finalDraft: revisedDraft, status: "revised", issues: [] }
    : { finalDraft: revisedDraft, status: "failed", issues: second.issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- review-draft`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/review-draft.ts tests/lib/review-draft.test.ts
git commit -m "feat: add draft review-and-reconcile module"
```

---

### Task 3: `reviewStatusLabel` helper + drafts UI

**Files:**
- Create: `src/lib/review-status.ts`
- Test: `tests/lib/review-status.test.ts`
- Modify: `src/app/(dashboard)/drafts/page.tsx` (status badge)
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx` (issue list for held drafts)

**Interfaces:**
- Consumes: `updates.reviewStatus` / `updates.reviewIssues` (Task 1).
- Produces: `reviewStatusLabel(status: string | null): string | null` — `failed` → "Failed review", `revised` → "Auto-revised", `error` → "Review unavailable", `passed`/null/unknown → `null` (no badge).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/review-status.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reviewStatusLabel } from "../../src/lib/review-status";

describe("reviewStatusLabel", () => {
  it("labels the actionable statuses", () => {
    expect(reviewStatusLabel("failed")).toBe("Failed review");
    expect(reviewStatusLabel("revised")).toBe("Auto-revised");
    expect(reviewStatusLabel("error")).toBe("Review unavailable");
  });

  it("returns null for passed, null, and unknown", () => {
    expect(reviewStatusLabel("passed")).toBeNull();
    expect(reviewStatusLabel(null)).toBeNull();
    expect(reviewStatusLabel("weird")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- review-status`
Expected: FAIL — `Cannot find module '../../src/lib/review-status'`.

- [ ] **Step 3: Write the helper**

Create `src/lib/review-status.ts`:

```ts
// Maps a stored review_status to a short badge label, or null when no badge
// should show (compliant, un-reviewed, or an unrecognized value).
export function reviewStatusLabel(status: string | null): string | null {
  switch (status) {
    case "failed":
      return "Failed review";
    case "revised":
      return "Auto-revised";
    case "error":
      return "Review unavailable";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- review-status`
Expected: PASS.

- [ ] **Step 5: Add the badge to the drafts list**

In `src/app/(dashboard)/drafts/page.tsx`, add the import:

```ts
import { reviewStatusLabel } from "@/lib/review-status";
```

Replace the draft card's `CardContent` block (the `<Link>` + category `<Badge>`) with a version that also shows the review badge when present:

```tsx
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <Link href={`/drafts/${d.id}`} className="font-medium hover:underline">
                {d.title}
              </Link>
              <div className="flex items-center gap-2">
                {reviewStatusLabel(d.reviewStatus) && (
                  <Badge variant={d.reviewStatus === "failed" ? "destructive" : "outline"}>
                    {reviewStatusLabel(d.reviewStatus)}
                  </Badge>
                )}
                <Badge variant="secondary">{d.category}</Badge>
              </div>
            </CardContent>
```

- [ ] **Step 6: Add the issue list to the draft detail page**

In `src/app/(dashboard)/drafts/[updateId]/page.tsx`, add the import:

```ts
import { reviewStatusLabel } from "@/lib/review-status";
```

Directly inside the top-level `<div className="space-y-8">` (before the `saveDraft` form), add a review panel that renders only when there is a label to show:

```tsx
      {reviewStatusLabel(update.reviewStatus) && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-medium">{reviewStatusLabel(update.reviewStatus)}</p>
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {update.reviewIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
```

- [ ] **Step 7: Verify build and full suite**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `npm test`
Expected: all PASS.

- [ ] **Step 8: Manually verify the drafts UI (per the `verify` skill)**

Open `/drafts` with a seeded `failed` update: the list shows a "Failed review" badge and the detail page shows the issue list. A `passed`/null update shows no review badge.

- [ ] **Step 9: Commit**

```bash
git add src/lib/review-status.ts tests/lib/review-status.test.ts "src/app/(dashboard)/drafts/page.tsx" "src/app/(dashboard)/drafts/[updateId]/page.tsx"
git commit -m "feat: surface review status and issues in the drafts UI"
```

---

### Task 4: `claimBatchAndCreateUpdate` persists the review outcome

**Files:**
- Modify: `src/lib/change-item-batch.ts`
- Test: `tests/lib/change-item-batch.test.ts` (add a case)

**Interfaces:**
- Consumes: `ReviewStatus` type (Task 2); review columns (Task 1).
- Produces: `claimBatchAndCreateUpdate(input: { tenantId; changeItemIds; draft; review? }, database?)` — when `review` is provided, the created update carries `reviewStatus`, `reviewIssues`, and `reviewedAt = now()`. `review` is `{ status: ReviewStatus; issues: string[] }`.

- [ ] **Step 1: Write the failing test**

In `tests/lib/change-item-batch.test.ts`, add this test inside the existing `describe("change-item-batch", ...)` block (it reuses the file's `seed()` helper):

```ts
  it("claimBatchAndCreateUpdate persists the review outcome when provided", async () => {
    const { tenant, repoA } = await seed();
    const [item] = await db
      .insert(changeItems)
      .values({ tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a" })
      .returning();

    const update = await claimBatchAndCreateUpdate({
      tenantId: tenant.id,
      changeItemIds: [item.id],
      draft: { title: "T", body: "B", category: "new" },
      review: { status: "failed", issues: ["too salesy"] },
    });

    expect(update!.reviewStatus).toBe("failed");
    expect(update!.reviewIssues).toEqual(["too salesy"]);
    expect(update!.reviewedAt).toBeInstanceOf(Date);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- change-item-batch`
Expected: FAIL — `claimBatchAndCreateUpdate` ignores `review`, so `reviewStatus` is `null`.

- [ ] **Step 3: Extend `claimBatchAndCreateUpdate`**

In `src/lib/change-item-batch.ts`, add the import for the review status type:

```ts
import type { ReviewStatus } from "./review-draft";
```

Change the function signature and the `updates` insert to persist the review outcome:

```ts
export async function claimBatchAndCreateUpdate(
  input: {
    tenantId: string;
    changeItemIds: string[];
    draft: DraftInput;
    review?: { status: ReviewStatus; issues: string[] };
  },
  database: typeof defaultDb = defaultDb
): Promise<UpdateRow | null> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(changeItems)
      .set({ status: "batched" })
      .where(and(inArray(changeItems.id, input.changeItemIds), eq(changeItems.status, "pending")))
      .returning({ id: changeItems.id });

    if (claimed.length === 0) return null;

    const claimedIds = claimed.map((c) => c.id);

    const [update] = await tx
      .insert(updates)
      .values({
        tenantId: input.tenantId,
        title: input.draft.title,
        body: input.draft.body,
        category: input.draft.category,
        sourceItems: claimedIds,
        ...(input.review
          ? { reviewStatus: input.review.status, reviewIssues: input.review.issues, reviewedAt: new Date() }
          : {}),
      })
      .returning();

    await tx.update(changeItems).set({ updateId: update.id }).where(inArray(changeItems.id, claimedIds));

    return update;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- change-item-batch`
Expected: PASS — the new test plus all existing change-item-batch tests (they call `claimBatchAndCreateUpdate` without `review`, so the review columns stay null/default).

- [ ] **Step 5: Commit**

```bash
git add src/lib/change-item-batch.ts tests/lib/change-item-batch.test.ts
git commit -m "feat: persist review outcome on created updates"
```

---

### Task 5: Wire review into `runBatchForWorkspace` and gate auto-publish

**Files:**
- Modify: `src/lib/run-schedule.ts`
- Test: `tests/lib/auto-publish.test.ts` (stub review; add failed/error cases), `tests/lib/run-schedule.test.ts` (stub review)

**Interfaces:**
- Consumes: `reviewAndReconcile` (Task 2); `claimBatchAndCreateUpdate`'s `review` param (Task 4).
- Produces: `runBatchForWorkspace` reviews each draft, stores `review.finalDraft` + outcome, and auto-publishes only when the review passed/revised.

- [ ] **Step 1: Stub the review module in the integration tests and add failed/error cases**

The review adds a second LLM step. Rather than teach the shared `generateObject` mock two shapes, stub `reviewAndReconcile` in the two integration test files so it returns a passthrough `passed` by default; new tests override it.

In `tests/lib/auto-publish.test.ts`:
- After the existing `vi.mock("ai", ...)` line, add:

```ts
vi.mock("../../src/lib/review-draft", () => ({ reviewAndReconcile: vi.fn() }));
```

- Add to the imports:

```ts
import { reviewAndReconcile } from "../../src/lib/review-draft";
```

- In `beforeEach`, set the default passthrough (a compliant review that keeps the draft):

```ts
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "passed", issues: [] }));
  });
```

- Add two new tests after the existing ones:

```ts
  it("stays a draft (no publish) when the review fails, even with autoPublish + webhook", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s" });
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "failed", issues: ["too salesy"] }));

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(update.reviewStatus).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stays a draft (no publish) when the review errors", async () => {
    const tenant = await seed(true);
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", secret: "s" });
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "error", issues: [] }));

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const [update] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
    expect(update.status).toBe("draft");
    expect(update.reviewStatus).toBe("error");
    expect(fetch).not.toHaveBeenCalled();
  });
```

In `tests/lib/run-schedule.test.ts`:
- After the existing `vi.mock("ai", ...)` line, add:

```ts
vi.mock("../../src/lib/review-draft", () => ({ reviewAndReconcile: vi.fn() }));
```

- Add to the imports:

```ts
import { reviewAndReconcile } from "../../src/lib/review-draft";
```

- Add a `beforeEach` inside the `describe` block that sets the passthrough default (leave the existing `afterEach` as-is):

```ts
  beforeEach(() => {
    vi.mocked(reviewAndReconcile).mockImplementation(async (draft) => ({ finalDraft: draft, status: "passed", issues: [] }));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- auto-publish`
Expected: FAIL — `runBatchForWorkspace` does not yet call `reviewAndReconcile` or gate on it, so the new "review fails → stays draft" test still publishes (status `published`, `reviewStatus` null).

- [ ] **Step 3: Wire the review into `runBatchForWorkspace`**

In `src/lib/run-schedule.ts`, add the import:

```ts
import { reviewAndReconcile } from "./review-draft";
```

In `runBatchForWorkspace`, after the `draft` is produced by the generation try/catch block (the block ending with `return false;` on double failure), insert the review and use its result for storage:

```ts
  const review = await reviewAndReconcile(draft, brandProfile);

  const update = await claimBatchAndCreateUpdate(
    {
      tenantId,
      changeItemIds: pending.map((p) => p.id),
      draft: review.finalDraft,
      review: { status: review.status, issues: review.issues },
    },
    database
  );
  if (!update) return false;
```

(This replaces the existing `const update = await claimBatchAndCreateUpdate({ tenantId, changeItemIds: pending.map((p) => p.id), draft }, database); if (!update) return false;` block.)

Then change the auto-publish condition to require a passing review:

```ts
  const reviewPassed = review.status === "passed" || review.status === "revised";
  if (tenant?.autoPublish && activeWebhook && reviewPassed) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auto-publish run-schedule`
Expected: PASS — the failed/error reviews block publish; the passthrough `passed` default keeps the existing publish/draft and scheduler tests green.

- [ ] **Step 5: Run the full suite and type-check**

Run: `npm test`
Expected: all PASS.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/run-schedule.ts tests/lib/auto-publish.test.ts tests/lib/run-schedule.test.ts
git commit -m "feat: review generated drafts and gate auto-publish on the result"
```

---

## Self-Review

**Spec coverage:**
- §1 data model (review_status enum + 3 columns + migration) → Task 1. ✓
- §2 review module (ReviewResult, buildReviewPrompt, reviewDraft, reviewAndReconcile with revise-once + retry-once + fail-safe error) → Task 2. ✓
- §3 wiring (reviewAndReconcile between generation and storage; store finalDraft + outcome; auto-publish gated on passed/revised) → Task 4 (persistence) + Task 5 (wiring + gate). ✓
- §4 UI (status badge on list, issues on detail, reviewStatusLabel helper) → Task 3. ✓
- §5 testing (buildReviewPrompt; reviewAndReconcile all paths incl. retry; run-schedule blocks on failed/error; migration round-trip; reviewStatusLabel) → Tasks 1–5. ✓
- Scope boundaries: brand-voice only; one revision; no re-run/override UI; generation output unchanged. ✓

**Placeholder scan:** No TBD/TODO/"handle appropriately"/"similar to Task N". Every code step is complete and literal. ✓

**Type consistency:** `ReviewStatus` defined in Task 2 is imported by Task 4 (`review` param) and produced by `reviewAndReconcile` used in Task 5. `ReviewOutcome.finalDraft` is `UpdateDraft` (from `generation.ts`), matching `DraftInput`'s `{title, body, category}` shape that `claimBatchAndCreateUpdate` consumes. Column names (`reviewStatus`/`review_status`, `reviewIssues`/`review_issues`, `reviewedAt`/`reviewed_at`) are consistent between schema (Task 1) and consumers (Tasks 3, 4). `reviewStatusLabel` takes `string | null`, matching `updates.reviewStatus`'s type. ✓

**Integration-test risk addressed:** D adds a second `generateObject` call. Task 5 stubs `reviewAndReconcile` in `auto-publish.test.ts` and `run-schedule.test.ts` (passthrough `passed` default) so the existing generation mock is untouched and the review path is driven explicitly — the failed/error cases override the stub. The `reviewAndReconcile` module itself is unit-tested in Task 2 against a mocked `ai`. ✓

**Ordering:** Task 1 first. Tasks 2, 3, 4 depend only on Task 1 (3 reads the columns; 4 needs the columns + Task 2's `ReviewStatus` type — so 4 depends on 1 and 2). Task 5 needs 2 (`reviewAndReconcile`) and 4 (`review` param). Safe sequence: 1 → 2 → 3 → 4 → 5.
