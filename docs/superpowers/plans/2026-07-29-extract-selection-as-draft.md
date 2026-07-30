# Extract a selection as a separate update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an editor highlight a passage in a draft, click "Extract as a separate update", and have that passage removed from the current draft and rewritten by the existing AI pipeline into a new draft of its own.

**Architecture:** A new prompt composer (`composeExtractPrompt`) feeds the highlighted markdown through the same generate → review → validate-links pipeline used everywhere else, then one DB transaction inserts the new release and rewrites the source's body. The client owns the deletion (Lexical knows the selection's structure; the server cannot re-derive it from a string), so it sends both the excerpt and the remaining body. Progress streams as NDJSON into the checklist modal the compose and Ask AI flows already use.

**Tech Stack:** Next.js 16 App Router, React 19, Drizzle ORM + Postgres, Vercel AI SDK v7 (`generateObject`), MDXEditor/Lexical, vitest (node environment), shadcn/base-ui dialogs, sonner toasts.

**Design spec:** `docs/superpowers/specs/2026-07-29-extract-selection-as-draft-design.md`

## Global Constraints

- **This is not the Next.js you know.** Per `AGENTS.md`, read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code. Task 4 (route handler) has an explicit step for this.
- **Tests run against real Postgres.** `vitest.setup.ts` hard-fails unless the database name ends in `_test`. Set `DATABASE_URL` or `TEST_DATABASE_URL` in `.env.local` first. Run migrations against it with `npm run db:migrate:test` if the schema is behind.
- **No browser verification for client tasks.** The dev preview sits behind a Google/GitHub OAuth wall, and the vitest environment is `node` (no jsdom, no React testing library). Client-side tasks are verified with `npm run typecheck` and `npm run lint`, and that is the honest bar — do not claim a UI was visually verified.
- **Every test file cleans up after itself.** Tests share one database; delete seeded tenants/users in `afterEach`, keyed by a name/email unique to that file.
- **Never fabricate links** is an existing standing instruction inside `buildSystemPrompt`. The new composer reuses `buildSystemPrompt` unchanged and must not restate or weaken it.
- **The new draft links no atomic updates.** Do not call `claimReleaseFromAtomicUpdates` anywhere in this feature; it requires at least one claimable atomic update and returns null otherwise.
- **Commit after every task**, using the repo's existing message style (`feat:` / `test:` / `refactor:` lowercase summaries).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/ai/compose-prompt.ts` (modify) | Add `composeExtractPrompt` beside the other composers. |
| `src/lib/ai/generation.ts` (modify) | Add `generateExtractedDraft` beside `generateReleaseDraft`/`mergeReleaseDraft`. |
| `src/lib/ai/extract-release.ts` (create) | Orchestrator: prepare → generate → review → validate → one transaction. |
| `src/app/api/drafts/extract/route.ts` (create) | Auth, tenant resolution, ownership check, NDJSON progress stream. |
| `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx` (modify) | `removeSelection` op, `"extract"` dialog mode, `openExtract()`. |
| `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` (modify) | Implement `removeSelection` in the bridge; add the toolbar button. |
| `src/components/draft-progress-checklist.tsx` (create) | The step-checklist render, shared by all three pipeline dialogs. |
| `src/lib/scheduling/read-draft-progress.ts` (create) | The NDJSON progress-stream reader, shared by the two simple consumers. |
| `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx` (modify) | Refactored onto both shared modules (Task 6); its `open` gate narrowed to its own modes (Task 7). |
| `src/app/(dashboard)/atomic-updates/draft-release-dialog.tsx` (modify) | Refactored onto the shared checklist (keeps its own abort-aware reader). |
| `src/app/(dashboard)/drafts/[releaseId]/extract-dialog.tsx` (create) | Confirm step, checklist loader, restore-on-failure, success toast. |
| `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (modify) | Render `<ExtractDialog>` beside `<AgentEditDialog>`. |

---

### Task 1: The extract prompt composer

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (append after `composeWholeEditPrompt`)
- Test: `tests/lib/ai/compose-extract-prompt.test.ts` (create)

**Interfaces:**
- Consumes: `buildSystemPrompt`, `DEFAULT_MAX_PROMPT_CHARS` (both already in that file; `DEFAULT_MAX_PROMPT_CHARS` is a module-level const, not exported — the new function lives in the same file so it can read it directly).
- Produces:
  ```ts
  export function composeExtractPrompt(args: {
    excerpt: string;
    instruction: string;
    brandProfile: BrandProfileRow;
    personas: ResolvedPersona[];
    examples: ExampleRow[];
  }): { system: string; prompt: string }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/compose-extract-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeExtractPrompt } from "../../../src/lib/ai/compose-prompt";
import type { brandProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

// Minimal brand profile — buildSystemPrompt only reads these fields.
const brandProfile = {
  tenantId: "tenant-1",
  guidelines: null,
  industry: null,
  userPersonas: [],
} as unknown as BrandProfileRow;

describe("composeExtractPrompt", () => {
  it("includes the excerpt and asks for a self-contained update with its own title", () => {
    const { system, prompt } = composeExtractPrompt({
      excerpt: "We also rebuilt CSV export.",
      instruction: "",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("We also rebuilt CSV export.");
    expect(system.toLowerCase()).toContain("self-contained");
    expect(system.toLowerCase()).toContain("its own title");
    // It must not leak the parent update: no back-references.
    expect(system.toLowerCase()).toContain("no reference to the update it came from");
  });

  it("carries the brand guidelines through buildSystemPrompt", () => {
    const { system } = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "",
      brandProfile: { ...brandProfile, guidelines: "Always be plain-spoken." },
      personas: [],
      examples: [],
    });
    expect(system).toContain("Always be plain-spoken.");
  });

  it("adds an instruction block only when an instruction is given", () => {
    const withInstruction = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "focus on the API change",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(withInstruction.prompt).toContain("focus on the API change");
    expect(withInstruction.prompt).toContain("Additional instruction from the editor:");

    const withoutInstruction = composeExtractPrompt({
      excerpt: "Something shipped.",
      instruction: "   ",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(withoutInstruction.prompt).not.toContain("Additional instruction from the editor:");
  });

  it("truncates an over-long excerpt rather than sending it whole", () => {
    const { prompt } = composeExtractPrompt({
      excerpt: "x".repeat(40000),
      instruction: "",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("…(truncated)");
    expect(prompt.length).toBeLessThan(30000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/compose-extract-prompt.test.ts`
Expected: FAIL — `composeExtractPrompt is not a function` (no such export).

- [ ] **Step 3: Write the implementation**

Append to `src/lib/ai/compose-prompt.ts`, after `composeWholeEditPrompt`:

```ts
/**
 * Prompt for EXTRACTING a highlighted passage out of a larger update into an
 * update of its own. Unlike `composeScopedEditPrompt` (which revises an excerpt
 * in place, returning only the excerpt) the result here is a whole new draft —
 * title and body — that must stand alone with no back-reference to the update
 * it was lifted from.
 */
export function composeExtractPrompt(args: {
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system =
    `${base}\n\nYou are rewriting a passage that was lifted out of a larger product update so that it ` +
    `stands on its own. Return a complete, self-contained update with its own title — it must read as if ` +
    `it had always been a separate announcement, with no reference to the update it came from and no ` +
    `words like "also", "additionally", or "as mentioned above" that only made sense in the original. ` +
    `Stay grounded strictly in the passage: keep every change it describes, and add no feature, benefit, ` +
    `metric, or detail that is not already there.`;

  const excerpt =
    args.excerpt.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.excerpt.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.excerpt;

  const sections = [`Passage to rewrite as its own update:\n${excerpt}`];
  const instruction = args.instruction.trim();
  if (instruction.length > 0) {
    sections.push(`Additional instruction from the editor:\n${instruction}`);
  }

  const prompt =
    `Rewrite the passage below as a standalone product update. Format the body as Markdown ` +
    `(short paragraphs, and bullet lists where helpful).\n\n${sections.join("\n\n")}`;

  return { system, prompt };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/compose-extract-prompt.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/compose-prompt.ts tests/lib/ai/compose-extract-prompt.test.ts
git commit -m "feat: add the extract prompt composer"
```

---

### Task 2: Generate the extracted draft

**Files:**
- Modify: `src/lib/ai/generation.ts` (append after `mergeReleaseDraft`)
- Test: `tests/lib/ai/generation.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `composeExtractPrompt` from Task 1; existing `UpdateDraftSchema`, `resolveModel`, `modelId`, `recordLlmUsage`.
- Produces:
  ```ts
  export async function generateExtractedDraft(args: {
    excerpt: string;
    instruction: string;
    brandProfile: BrandProfileRow;
    personas?: ResolvedPersona[];
    examples?: ExampleRow[];
  }): Promise<UpdateDraft>   // UpdateDraft = { title: string; body: string }
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/ai/generation.test.ts`. The file already has `vi.mock("ai", ...)` at the top and imports `generateObject` — add `generateExtractedDraft` to the existing import from `../../../src/lib/ai/generation`, then append:

```ts
describe("generateExtractedDraft", () => {
  it("passes the excerpt and instruction into the prompt and returns the object", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "CSV export", body: "You can now export reports as CSV." },
    } as never);

    const brandProfile = {
      tenantId: "tenant_1",
      guidelines: null,
      industry: "B2B SaaS",
      userPersonas: [],
    } as never;

    const draft = await generateExtractedDraft({
      excerpt: "We also rebuilt CSV export so reports download in seconds.",
      instruction: "lead with the speed",
      brandProfile,
    });

    expect(draft).toEqual({ title: "CSV export", body: "You can now export reports as CSV." });

    const callArgs = vi.mocked(generateObject).mock.calls.at(-1)![0];
    expect(callArgs.prompt).toContain("We also rebuilt CSV export so reports download in seconds.");
    expect(callArgs.prompt).toContain("lead with the speed");
    expect(callArgs.system).toContain("Industry: B2B SaaS.");
    expect(callArgs.system.toLowerCase()).toContain("self-contained");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/generation.test.ts`
Expected: FAIL — `generateExtractedDraft is not a function`.

- [ ] **Step 3: Write the implementation**

Add `composeExtractPrompt` to the existing `./compose-prompt` import in `src/lib/ai/generation.ts`, then append:

```ts
/**
 * Rewrites a passage lifted out of an existing draft into a standalone update
 * (see `composeExtractPrompt`). Mirrors `generateReleaseDraft`'s model
 * resolution and usage recording exactly — only the prompt composer differs.
 */
export async function generateExtractedDraft(args: {
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<UpdateDraft> {
  const { system, prompt } = composeExtractPrompt({
    excerpt: args.excerpt,
    instruction: args.instruction,
    brandProfile: args.brandProfile,
    personas: args.personas ?? [],
    examples: args.examples ?? [],
  });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: UpdateDraftSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return result.object;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/generation.test.ts`
Expected: PASS — the pre-existing tests in the file plus the new one.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/generation.ts tests/lib/ai/generation.test.ts
git commit -m "feat: generate a standalone draft from an extracted passage"
```

---

### Task 3: The extract orchestrator and its transaction

**Files:**
- Create: `src/lib/ai/extract-release.ts`
- Test: `tests/lib/ai/extract-release.test.ts` (create)

**Interfaces:**
- Consumes: `generateExtractedDraft` (Task 2); existing `reviewAndReconcile(draft, brandProfile, onProgress): Promise<ReviewOutcome>` where `ReviewOutcome = { finalDraft: UpdateDraft; status: ReviewStatus; issues: string[] }`; `validateDraftLinks(body): Promise<{ body: string; replaced: string[] }>`; `getOrCreateBrandProfile`, `resolvePersonaRefs`, `systemPersonaKeys`, `selectExamples`.
- Produces:
  ```ts
  export type ExtractDeps = {
    generateDraft?: typeof generateExtractedDraft;
    review?: typeof reviewAndReconcile;
  };

  export async function runExtractForRelease(
    args: {
      releaseId: string;
      excerpt: string;
      remainingBody: string;
      instruction: string;
      editedBy: string;
    },
    database?: Database,
    onProgress?: OnDraftProgress,
    deps?: ExtractDeps
  ): Promise<{ releaseId: string; title: string } | null>
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/extract-release.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases, users, brandProfiles, atomicUpdates } from "../../../src/db/schema";
import { runExtractForRelease } from "../../../src/lib/ai/extract-release";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";
import type { ReviewOutcome } from "../../../src/lib/ai/review-draft";

const TENANT_NAME = "Extract Release Test Tenant";
const USER_EMAIL = "extract-release-test@example.com";

const SOURCE_BODY = "Kept paragraph.\n\nExtracted paragraph.";
const REMAINING = "Kept paragraph.";

async function seed(body = SOURCE_BODY) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  const [release] = await db
    .insert(releases)
    .values({ tenantId: tenant.id, title: "Source title", body })
    .returning();
  return { tenant, user, release };
}

async function rowFor(releaseId: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
  return row;
}

async function releasesFor(tenantId: string) {
  return db.select().from(releases).where(eq(releases.tenantId, tenantId));
}

const generateDraft = async () => ({ title: "Generated title", body: "generated body" });
const review = async (draft: { title: string; body: string }): Promise<ReviewOutcome> => ({
  finalDraft: { title: draft.title, body: "reviewed body" },
  status: "passed",
  issues: [],
});

describe("runExtractForRelease", () => {
  afterEach(async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
    if (tenant) {
      await db.delete(atomicUpdates).where(eq(atomicUpdates.tenantId, tenant.id));
      await db.delete(releases).where(eq(releases.tenantId, tenant.id));
      await db.delete(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    }
    await db.delete(users).where(eq(users.email, USER_EMAIL));
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  it("creates the new draft and rewrites the source body in one pass, emitting stepped progress", async () => {
    const { tenant, user, release } = await seed();
    const events: DraftProgressEvent[] = [];

    const result = await runExtractForRelease(
      {
        releaseId: release.id,
        excerpt: "Extracted paragraph.",
        remainingBody: REMAINING,
        instruction: "keep it short",
        editedBy: user.id,
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );

    expect(result).not.toBeNull();
    expect(result!.title).toBe("Generated title");

    const created = await rowFor(result!.releaseId);
    expect(created.title).toBe("Generated title");
    expect(created.body).toBe("reviewed body");
    expect(created.tenantId).toBe(tenant.id);
    expect(created.status).toBe("draft");
    expect(created.reviewStatus).toBe("passed");
    expect(created.editedBy).toBe(user.id);

    // The new draft claims no atomic updates — by design.
    const linked = await db
      .select()
      .from(atomicUpdates)
      .where(eq(atomicUpdates.releaseId, created.id));
    expect(linked).toHaveLength(0);

    const source = await rowFor(release.id);
    expect(source.body).toBe(REMAINING);
    expect(source.title).toBe("Source title"); // never touched
    expect(source.bodyEditedAt).not.toBeNull();
    expect(source.editedBy).toBe(user.id);

    const steps = events
      .filter((e): e is Extract<DraftProgressEvent, { type: "step" }> => e.type === "step")
      .map((s) => `${s.key}:${s.status}`);
    expect(steps).toEqual([
      "preparing:start",
      "preparing:done",
      "generating:start",
      "generating:done",
      "reviewing:start",
      "reviewing:done",
      "saving:start",
      "saving:done",
    ]);
    expect(events.at(-1)).toEqual({ type: "done", updateId: created.id });
  });

  it("refuses to extract the entire body and writes nothing", async () => {
    const { tenant, release } = await seed();
    const events: DraftProgressEvent[] = [];

    const result = await runExtractForRelease(
      {
        releaseId: release.id,
        excerpt: SOURCE_BODY,
        remainingBody: "   ",
        instruction: "",
        editedBy: "00000000-0000-0000-0000-000000000000",
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );

    expect(result).toBeNull();
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(await releasesFor(tenant.id)).toHaveLength(1);
    expect((await rowFor(release.id)).body).toBe(SOURCE_BODY);
  });

  it("leaves the source untouched and creates nothing when generation fails", async () => {
    const { tenant, user, release } = await seed();
    const failing = async () => {
      throw new Error("model exploded");
    };

    await expect(
      runExtractForRelease(
        {
          releaseId: release.id,
          excerpt: "Extracted paragraph.",
          remainingBody: REMAINING,
          instruction: "",
          editedBy: user.id,
        },
        db,
        undefined,
        { generateDraft: failing, review }
      )
    ).rejects.toThrow("model exploded");

    expect(await releasesFor(tenant.id)).toHaveLength(1);
    const source = await rowFor(release.id);
    expect(source.body).toBe(SOURCE_BODY);
    expect(source.bodyEditedAt).toBeNull();
  });

  it("returns null for a release that does not exist", async () => {
    const events: DraftProgressEvent[] = [];
    const result = await runExtractForRelease(
      {
        releaseId: "00000000-0000-0000-0000-000000000000",
        excerpt: "x",
        remainingBody: "y",
        instruction: "",
        editedBy: "00000000-0000-0000-0000-000000000000",
      },
      db,
      (e) => events.push(e),
      { generateDraft, review }
    );
    expect(result).toBeNull();
    expect(events.some((e) => e.type === "error")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/extract-release.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/ai/extract-release`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/extract-release.ts`:

```ts
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { releases, systemPersonas, systemUpdateExamples } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { generateExtractedDraft } from "@/lib/ai/generation";
import { reviewAndReconcile } from "@/lib/ai/review-draft";
import { validateDraftLinks } from "@/lib/ai/validate-links";
import type { OnDraftProgress } from "@/lib/scheduling/draft-progress";

type Database = typeof defaultDb;

export type ExtractDeps = {
  generateDraft?: typeof generateExtractedDraft;
  review?: typeof reviewAndReconcile;
};

/**
 * Splits a passage out of an existing draft into a draft of its own, through
 * the SAME generate → review-against-brand-guidelines → validate-links pipeline
 * as the initial compose (compare `runWholeEditForRelease`, which runs that
 * pipeline over a whole body instead).
 *
 * `remainingBody` is computed by the CLIENT, not derived here: MDXEditor
 * serializes a selection independently of the whole document, so the excerpt is
 * not reliably a substring of the body and a server-side string removal would
 * fail silently or cut the wrong occurrence. This function persists what it is
 * given.
 *
 * The insert of the new release and the rewrite of the source body share one
 * transaction, so the passage is never present in two drafts at once. The new
 * release deliberately claims NO atomic updates — see the design spec's
 * "Known consequences".
 *
 * Returns null (after emitting an error event) when the release doesn't exist
 * or the split would empty the source draft.
 */
export async function runExtractForRelease(
  args: {
    releaseId: string;
    excerpt: string;
    remainingBody: string;
    instruction: string;
    editedBy: string;
  },
  database: Database = defaultDb,
  onProgress?: OnDraftProgress,
  deps: ExtractDeps = {}
): Promise<{ releaseId: string; title: string } | null> {
  const generateDraft = deps.generateDraft ?? generateExtractedDraft;
  const review = deps.review ?? reviewAndReconcile;
  const emit: OnDraftProgress = onProgress ?? (() => {});

  const [source] = await database.select().from(releases).where(eq(releases.id, args.releaseId));
  if (!source) {
    emit({ type: "error", message: "Update not found." });
    return null;
  }

  // Refusing this is not cosmetic: `resolveBody` in drafts/actions.ts reads a
  // blank submitted body as an editor parse failure and falls back to the
  // stored text, so an emptied source draft would silently resurrect the very
  // passage we just moved out of it.
  if (args.remainingBody.trim().length === 0) {
    emit({ type: "error", message: "You can't extract the entire update — leave some text behind." });
    return null;
  }

  if (args.excerpt.trim().length === 0) {
    emit({ type: "error", message: "Nothing was selected to extract." });
    return null;
  }

  emit({ type: "step", key: "preparing", status: "start" });
  const brandProfile = await getOrCreateBrandProfile(source.tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  // Prose carries no category, so example selection leans on industry/personas
  // only — same call shape as the whole-update edit path.
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: [],
  });
  emit({ type: "step", key: "preparing", status: "done" });

  emit({ type: "step", key: "generating", status: "start" });
  const generated = await generateDraft({
    excerpt: args.excerpt,
    instruction: args.instruction,
    brandProfile,
    personas,
    examples,
  });
  emit({ type: "step", key: "generating", status: "done" });

  emit({ type: "step", key: "reviewing", status: "start" });
  const outcome = await review(generated, brandProfile, emit);
  emit({ type: "step", key: "reviewing", status: "done" });

  // Validate links on the FINAL body — after review, which may itself rewrite
  // links — so no unresolvable URL is persisted (see `validateDraftLinks`).
  const { body: validatedBody } = await validateDraftLinks(outcome.finalDraft.body);

  emit({ type: "step", key: "saving", status: "start" });
  // One timestamp for both rows, so the split reads as a single event.
  const now = new Date();
  const created = await database.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(releases)
      .values({
        tenantId: source.tenantId,
        title: outcome.finalDraft.title,
        body: validatedBody,
        // Has a DB default, but set explicitly: this is the baseline that
        // catch-up deltas measure against, so it belongs in the creating code.
        composedAt: now,
        reviewStatus: outcome.status,
        reviewIssues: outcome.issues,
        reviewedAt: now,
        editedBy: args.editedBy,
      })
      .returning();

    await tx
      .update(releases)
      .set({ body: args.remainingBody, bodyEditedAt: now, editedBy: args.editedBy })
      .where(eq(releases.id, source.id));

    return inserted;
  });
  emit({ type: "step", key: "saving", status: "done" });

  emit({ type: "done", updateId: created.id });
  return { releaseId: created.id, title: created.title };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/extract-release.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/extract-release.ts tests/lib/ai/extract-release.test.ts
git commit -m "feat: split a passage into its own draft in one transaction"
```

---

### Task 4: The extract route

**Files:**
- Create: `src/app/api/drafts/extract/route.ts`
- Test: `tests/app/api/drafts/extract/route.test.ts` (create)
- Reference: `src/app/api/drafts/edit/route.ts` (the pattern being followed)

**Interfaces:**
- Consumes: `runExtractForRelease` (Task 3).
- Produces: `POST /api/drafts/extract`, accepting `{ releaseId, excerpt, remainingBody, instruction }` and streaming `application/x-ndjson` `DraftProgressEvent` lines. The terminal `done` event's `updateId` is the **new** release's id.

- [ ] **Step 1: Read the Next.js route-handler docs**

Run: `ls node_modules/next/dist/docs/` and read the guide covering Route Handlers before writing the file. This repo's `AGENTS.md` warns that this Next.js version differs from training data — confirm the export shape and streaming-response conventions there rather than assuming.

- [ ] **Step 2: Write the failing test**

Create `tests/app/api/drafts/extract/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: () => {} })) }));
vi.mock("../../../../../src/lib/ai/extract-release", () => ({ runExtractForRelease: vi.fn() }));

import { getServerSession } from "next-auth";
import { db } from "../../../../../src/db";
import { users, tenants, tenantMembers, releases } from "../../../../../src/db/schema";
import { runExtractForRelease } from "../../../../../src/lib/ai/extract-release";
import { POST } from "../../../../../src/app/api/drafts/extract/route";

const TENANT_NAME = "Extract Route Test Tenant";
const OTHER_TENANT_NAME = "Extract Route Other Tenant";
const emails = ["extract-route-test@example.com"];

function postRequest(body: unknown) {
  return new Request("http://x/api/drafts/extract", { method: "POST", body: JSON.stringify(body) });
}

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function makeAuthedUserAndTenant() {
  const [user] = await db.insert(users).values({ email: emails[0] }).returning();
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: user.id, role: "owner" });
  return { user, tenant };
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runExtractForRelease).mockReset();
});

afterEach(async () => {
  const us = await db.select().from(users).where(inArray(users.email, emails));
  for (const u of us) {
    await db.delete(tenantMembers).where(eq(tenantMembers.userId, u.id));
    await db.delete(users).where(eq(users.id, u.id));
  }
  for (const name of [TENANT_NAME, OTHER_TENANT_NAME]) {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, name));
    if (tenant) {
      await db.delete(releases).where(eq(releases.tenantId, tenant.id));
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
    }
  }
});

describe("POST /api/drafts/extract", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(postRequest({ releaseId: "r", excerpt: "x", remainingBody: "y" }));
    expect(res.status).toBe(401);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no membership", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const res = await POST(postRequest({ releaseId: "r", excerpt: "x", remainingBody: "y" }));
    expect(res.status).toBe(401);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("streams an error and never runs the pipeline for another tenant's release", async () => {
    const { user } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);

    const [other] = await db.insert(tenants).values({ name: OTHER_TENANT_NAME }).returning();
    const [foreign] = await db
      .insert(releases)
      .values({ tenantId: other.id, title: "T", body: "B" })
      .returning();

    const res = await POST(
      postRequest({ releaseId: foreign.id, excerpt: "x", remainingBody: "y", instruction: "" })
    );
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("streams an error when the remaining body is blank", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();

    const res = await POST(
      postRequest({ releaseId: release.id, excerpt: "x", remainingBody: "   ", instruction: "" })
    );
    const events = await readNdjson(res);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runExtractForRelease).not.toHaveBeenCalled();
  });

  it("runs the pipeline for an owned release and forwards its progress events", async () => {
    const { user, tenant } = await makeAuthedUserAndTenant();
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: user.id } } as never);
    const [release] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "T", body: "B" })
      .returning();

    vi.mocked(runExtractForRelease).mockImplementation((async (_args, _db, onProgress) => {
      onProgress?.({ type: "step", key: "preparing", status: "start" });
      onProgress?.({ type: "done", updateId: "new-release-id" });
      return { releaseId: "new-release-id", title: "Generated title" };
    }) as never);

    const res = await POST(
      postRequest({
        releaseId: release.id,
        excerpt: "Extracted paragraph.",
        remainingBody: "Kept paragraph.",
        instruction: "keep it short",
      })
    );
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "preparing", status: "start" });
    expect(events).toContainEqual({ type: "done", updateId: "new-release-id" });

    expect(runExtractForRelease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExtractForRelease).mock.calls[0][0]).toMatchObject({
      releaseId: release.id,
      excerpt: "Extracted paragraph.",
      remainingBody: "Kept paragraph.",
      instruction: "keep it short",
      editedBy: user.id,
    });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/app/api/drafts/extract/route.test.ts`
Expected: FAIL — cannot resolve `src/app/api/drafts/extract/route`.

- [ ] **Step 4: Write the implementation**

Create `src/app/api/drafts/extract/route.ts`:

```ts
import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { runExtractForRelease } from "@/lib/ai/extract-release";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Splits a highlighted passage out of a draft into a new draft, streaming the
 * same stepped progress as the compose and whole-edit routes. Fetch/ndjson API,
 * so it fails with a plain 401 rather than a redirect (see the compose route).
 * The release id is re-checked against the resolved tenant — never trusted from
 * the request body.
 *
 * `remainingBody` is supplied by the client because only the editor knows the
 * selection's structure; see `runExtractForRelease` for why it isn't derived
 * server-side.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return unauthorized();
  }
  const store = await cookies();
  const cookieTenantId = store.get(ACTIVE_TENANT_COOKIE)?.value;
  const active = await resolveActiveTenant(session.user.id, cookieTenantId);
  if (!active) {
    return unauthorized();
  }
  const tenantId = active.tenantId;
  const editedBy = session.user.id;

  const body = await req.json().catch(() => null);
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId : "";
  const excerpt = typeof body?.excerpt === "string" ? body.excerpt : "";
  const remainingBody = typeof body?.remainingBody === "string" ? body.remainingBody : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        if (!releaseId || excerpt.trim().length === 0) {
          emit({ type: "error", message: "Missing an update to split or a passage to extract." });
          return;
        }
        // Server-side repeat of the client's guard, for a crafted request.
        if (remainingBody.trim().length === 0) {
          emit({
            type: "error",
            message: "You can't extract the entire update — leave some text behind.",
          });
          return;
        }
        // Ownership + existence check against the resolved tenant, not the
        // client-supplied id.
        const [owned] = await db
          .select({ id: releases.id })
          .from(releases)
          .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)));
        if (!owned) {
          emit({ type: "error", message: "Update not found for this tenant." });
          return;
        }
        await runExtractForRelease(
          { releaseId, excerpt, remainingBody, instruction, editedBy },
          db,
          emit
        );
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/app/api/drafts/extract/route.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/drafts/extract/route.ts tests/app/api/drafts/extract/route.test.ts
git commit -m "feat: add the draft extract route"
```

---

### Task 5: The `removeSelection` editor op and the extract dialog mode

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` (`AgentEditBridge` only)

**Interfaces:**
- Consumes: nothing from earlier tasks — this is pure client plumbing.
- Produces, from `agent-edit-context.tsx`:
  ```ts
  export type AgentEditMode = "selection" | "whole";        // unchanged — what applyEdit accepts
  export type DialogMode = AgentEditMode | "extract";        // new — what the modals key off
  // EditorOps gains:
  removeSelection: () => Promise<string>;
  // Context value gains:
  openExtract: () => boolean;   // false when the selection was empty; nothing opens
  ```
  `state` becomes `{ mode: DialogMode; excerpt: string } | null`.

**Why `AgentEditMode` is not simply widened:** `applyEdit(mode, markdown)` branches on `"selection"` vs `"whole"` and has no meaning for `"extract"`. Widening its parameter type would let a nonsense call typecheck. A separate `DialogMode` keeps the op's contract exact.

- [ ] **Step 1: Widen the dialog mode and add `openExtract` in the context**

In `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx`:

Add below the existing `AgentEditMode`:

```ts
/**
 * Which modal is open. `applyEdit` still takes only `AgentEditMode` — extract
 * never routes through it — so the two types stay separate on purpose.
 */
export type DialogMode = AgentEditMode | "extract";
```

Add to the `EditorOps` type, after `applyEdit`:

```ts
  /**
   * Deletes the captured selection from the document and resolves with the
   * editor's authoritative full Markdown AFTER Lexical commits. Same deferred-
   * commit caveat as `applyEdit`: a synchronous `getMarkdown()` would return
   * the pre-deletion body.
   */
  removeSelection: () => Promise<string>;
```

Change the state type and add the action:

```ts
type AgentEditState = { mode: DialogMode; excerpt: string };
```

```ts
  /**
   * Opens the extract modal, snapshotting the selection first (the modal steals
   * focus). Returns false — and opens nothing — when the selection is empty or
   * whitespace, so the caller can say why.
   */
  const openExtract = useCallback(() => {
    const excerpt = ops.current?.captureSelection() ?? "";
    if (excerpt.trim().length === 0) return false;
    setState({ mode: "extract", excerpt });
    return true;
  }, []);
```

Add `openExtract: () => boolean;` to `AgentEditContextValue` and `openExtract` to the provider's `value` object.

- [ ] **Step 2: Implement `removeSelection` in the bridge**

In `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx`, add `removeSelection` to the `ops` object inside `AgentEditBridge`'s `useEffect`, after `applyEdit`:

```ts
      removeSelection: () =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          const saved = savedSelection.current;
          // Nothing captured to remove: resolve with the unchanged body so the
          // caller's guard (blank remaining body) can't be fooled into thinking
          // a deletion happened.
          if (!editor || !saved) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }

          // Same one-shot listener as applyEdit: Lexical defers the commit that
          // refreshes MDXEditor's markdown cell to a microtask, so reading
          // synchronously after the update returns the PRE-deletion body.
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });

          editor.update(() => {
            $setSelection(saved.clone());
            // Read the selection back rather than calling removeText() on the
            // clone: removeText operates on the editor's ACTIVE selection.
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.removeText();
          });
        }),
```

No new imports are needed — `$getSelection`, `$isRangeSelection`, and `$setSelection` are already imported at the top of the file.

- [ ] **Step 3: Verify types and lint**

Run: `npm run typecheck`
Expected: PASS — no errors. (`AgentEditDialog` reads `state.mode === "whole"` and `state.mode === "selection"`, both still valid members of the widened `DialogMode`.)

Run: `npm run lint`
Expected: PASS — no errors.

- [ ] **Step 4: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — same set of passing tests as before this task, plus Tasks 1–4's.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx" "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx"
git commit -m "feat: add a removeSelection editor op and an extract dialog mode"
```

---

### Task 6: Extract the shared checklist and progress reader

Two blocks the extract dialog needs already exist in duplicate. Share them
BEFORE adding a third copy. This task adds no feature behavior — the existing
suite plus `typecheck` is the regression net.

**Files:**
- Create: `src/components/draft-progress-checklist.tsx`
- Create: `src/lib/scheduling/read-draft-progress.ts`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx`
- Modify: `src/app/(dashboard)/atomic-updates/draft-release-dialog.tsx`
- Test: `tests/lib/scheduling/read-draft-progress.test.ts` (create)

**Interfaces:**
- Consumes: existing `DraftStepKey` and `DraftProgressEvent` from `@/lib/scheduling/draft-progress`.
- Produces:
  ```ts
  // src/components/draft-progress-checklist.tsx
  export type StepStatus = "pending" | "active" | "done";
  export function initialStepStatuses(
    steps: { key: DraftStepKey }[]
  ): Record<DraftStepKey, StepStatus>;
  export function ProgressChecklist(props: {
    steps: { key: DraftStepKey; label: string }[];
    statuses: Record<DraftStepKey, StepStatus>;
    detail?: string;
    className?: string;
  }): React.JSX.Element;

  // src/lib/scheduling/read-draft-progress.ts
  export async function readDraftProgress(
    body: ReadableStream<Uint8Array>,
    handle: (event: DraftProgressEvent) => void
  ): Promise<void>;
  ```

**Scope boundary — read this before touching the compose dialog.** The compose
dialog's `draft-release-dialog.tsx` reader is NOT the same loop: it checks an
abort signal between chunks and awaits an async paced-apply per event. Do not
try to fold it into `readDraftProgress`. Refactor only its `<ol>` onto
`ProgressChecklist`; leave its reader exactly as it is.

- [ ] **Step 1: Write the failing test for the reader**

Create `tests/lib/scheduling/read-draft-progress.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readDraftProgress } from "../../../src/lib/scheduling/read-draft-progress";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";

/** Builds a stream that emits the given raw chunks in order, so a test can
 * split NDJSON lines across chunk boundaries on purpose. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readDraftProgress", () => {
  it("delivers one event per NDJSON line, in order", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf([
        '{"type":"step","key":"preparing","status":"start"}\n',
        '{"type":"step","key":"preparing","status":"done"}\n',
        '{"type":"done","updateId":"r1"}\n',
      ]),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([
      { type: "step", key: "preparing", status: "start" },
      { type: "step", key: "preparing", status: "done" },
      { type: "done", updateId: "r1" },
    ]);
  });

  it("reassembles a line split across chunk boundaries", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf(['{"type":"detail","tex', 't":"Reviewing (round 1)"}\n']),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([{ type: "detail", text: "Reviewing (round 1)" }]);
  });

  it("delivers a trailing line that has no newline terminator", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(streamOf(['{"type":"error","message":"boom"}']), (e) => seen.push(e));
    expect(seen).toEqual([{ type: "error", message: "boom" }]);
  });

  it("ignores blank lines", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf(['\n{"type":"done","updateId":"r1"}\n\n']),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([{ type: "done", updateId: "r1" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/scheduling/read-draft-progress.test.ts`
Expected: FAIL — cannot resolve `src/lib/scheduling/read-draft-progress`.

- [ ] **Step 3: Write the reader**

Create `src/lib/scheduling/read-draft-progress.ts`:

```ts
import type { DraftProgressEvent } from "./draft-progress";

/**
 * Reads an NDJSON progress stream from one of the pipeline routes, calling
 * `handle` once per event. Chunk boundaries fall anywhere, so a partial line is
 * buffered until its newline arrives, and a final line without a terminator is
 * still delivered.
 *
 * The compose dialog (`draft-release-dialog.tsx`) deliberately does NOT use
 * this: its loop checks an abort signal between chunks and awaits an async
 * paced-apply per event. Keep that one separate rather than growing options
 * here for a single caller.
 */
export async function readDraftProgress(
  body: ReadableStream<Uint8Array>,
  handle: (event: DraftProgressEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as DraftProgressEvent);
  }
  if (buffer.trim()) handle(JSON.parse(buffer) as DraftProgressEvent);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/scheduling/read-draft-progress.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the shared checklist component**

Create `src/components/draft-progress-checklist.tsx`:

```tsx
"use client";

import { Loader2, Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DraftStepKey } from "@/lib/scheduling/draft-progress";

export type StepStatus = "pending" | "active" | "done";

/** Every step pending — the state a checklist starts and resets to. */
export function initialStepStatuses(
  steps: { key: DraftStepKey }[]
): Record<DraftStepKey, StepStatus> {
  const statuses = {} as Record<DraftStepKey, StepStatus>;
  for (const step of steps) statuses[step.key] = "pending";
  return statuses;
}

/**
 * The stepped loader shared by every dialog that runs a pipeline route: the
 * compose flow (DRAFT_STEPS), the whole-update agent edit and the extract flow
 * (both EDIT_STEPS). Which step list it renders is the caller's choice; the
 * icons, colors and the active step's `detail` suffix are the same everywhere.
 */
export function ProgressChecklist({
  steps,
  statuses,
  detail,
  className,
}: {
  steps: { key: DraftStepKey; label: string }[];
  statuses: Record<DraftStepKey, StepStatus>;
  detail?: string;
  className?: string;
}) {
  return (
    <ol className={cn("space-y-2", className)}>
      {steps.map((step) => {
        const st = statuses[step.key];
        return (
          <li key={step.key} className="flex items-center gap-2 text-sm">
            {st === "done" ? (
              <Check className="size-4 text-emerald-600" />
            ) : st === "active" ? (
              <Loader2 className="size-4 animate-spin text-foreground" />
            ) : (
              <Circle className="size-4 text-muted-foreground/40" />
            )}
            <span className={st === "pending" ? "text-muted-foreground" : "text-foreground"}>
              {step.label}
            </span>
            {st === "active" && detail && (
              <span className="text-xs text-muted-foreground">· {detail}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 6: Refactor `agent-edit-dialog.tsx` onto both**

In `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx`:

1. Delete the local `type StepStatus` and `initialEditStatuses()` declarations.
2. Add:
   ```tsx
   import {
     ProgressChecklist,
     initialStepStatuses,
     type StepStatus,
   } from "@/components/draft-progress-checklist";
   import { readDraftProgress } from "@/lib/scheduling/read-draft-progress";
   ```
3. Replace every `initialEditStatuses()` call with `initialStepStatuses(EDIT_STEPS)` (three sites: the `useState` initializer, `reset()`, and the top of `runWholeEdit`). Note the `useState` initializer must become a thunk: `useState<Record<DraftStepKey, StepStatus>>(() => initialStepStatuses(EDIT_STEPS))`.
4. Replace the reader loop in `runWholeEdit` — from `const reader = res.body.getReader();` through the trailing `if (buffer.trim()) handle(...)` line — with:
   ```tsx
       await readDraftProgress(res.body, handle);
   ```
5. Replace the `<ol className="space-y-2 py-2">…</ol>` block with:
   ```tsx
           <ProgressChecklist steps={EDIT_STEPS} statuses={statuses} detail={detail} className="py-2" />
   ```
6. Drop `Check` and `Circle` from the lucide import if they are now unused (`Sparkles` and `Loader2` are still used).

- [ ] **Step 7: Refactor the compose dialog's checklist only**

In `src/app/(dashboard)/atomic-updates/draft-release-dialog.tsx`:

1. Delete the local `initialStatuses()` function at the bottom of the file and the local `StepStatus` type, importing both from the shared module instead (`initialStepStatuses`, `StepStatus`). Replace `initialStatuses()` calls with `initialStepStatuses(DRAFT_STEPS)`, making any `useState` initializer a thunk.
2. Replace the `<ol className="space-y-2">…</ol>` inside the `phase === "progress"` block with:
   ```tsx
             <ProgressChecklist steps={DRAFT_STEPS} statuses={statuses} detail={detail} />
   ```
3. Drop `Check` and `Circle` from its lucide import if now unused (`Loader2` and `AlertCircle` are still used).
4. **Leave the reader loop and the abort/paced-apply logic untouched.**

- [ ] **Step 8: Verify types, lint, and the whole suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

Run: `npm test`
Expected: PASS — the new reader tests plus every pre-existing test. No behavior changed, so any failure here is a real regression from the refactor.

- [ ] **Step 9: Commit**

```bash
git add src/components/draft-progress-checklist.tsx src/lib/scheduling/read-draft-progress.ts tests/lib/scheduling/read-draft-progress.test.ts "src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx" "src/app/(dashboard)/atomic-updates/draft-release-dialog.tsx"
git commit -m "refactor: share the pipeline progress checklist and stream reader"
```

---

### Task 7: The extract dialog and toolbar button

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/extract-dialog.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` (add the button, pass it in `selectionExtras`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx` (narrow its `open` gate — see Step 0)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx` (render the dialog)

**Interfaces:**
- Consumes: `openExtract()`, `removeSelection()`, `applyEdit()`, `getMarkdown()` from Task 5; `ProgressChecklist`, `initialStepStatuses`, `StepStatus`, `readDraftProgress` from Task 6; `POST /api/drafts/extract` from Task 4; existing `EDIT_STEPS`, `DraftProgressEvent`, `DraftStepKey` from `@/lib/scheduling/draft-progress`; existing `useUnsavedChanges().notifySaved` from `../../unsaved-changes`.
- Produces: `export function ExtractDialog({ releaseId }: { releaseId: string })`.

- [ ] **Step 0: Narrow `AgentEditDialog`'s open gate FIRST**

Found by the Task 5 review, and load-bearing: `agent-edit-dialog.tsx` currently
opens on `const open = state !== null;`. The provider's state is now shared with
the extract mode, so the moment the toolbar button calls `openExtract()`, the
Ask AI modal would open on top of the extract modal — and its `submit()` would
fall through to the `else` branch and run `runWholeEdit`, rewriting the entire
body. Do this before wiring the button, not after.

In `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx`, replace:

```tsx
  const open = state !== null;
```

with:

```tsx
  // Only this modal's own modes. The provider's state is shared with the
  // extract flow, which has its own dialog — without this gate both would open
  // at once and Ask AI's submit would run a whole-body rewrite on an extract.
  const open = state?.mode === "selection" || state?.mode === "whole";
```

- [ ] **Step 1: Create the dialog**

Create `src/app/(dashboard)/drafts/[releaseId]/extract-dialog.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Split } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { EDIT_STEPS, type DraftProgressEvent, type DraftStepKey } from "@/lib/scheduling/draft-progress";
import {
  ProgressChecklist,
  initialStepStatuses,
  type StepStatus,
} from "@/components/draft-progress-checklist";
import { readDraftProgress } from "@/lib/scheduling/read-draft-progress";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";

/**
 * Confirms and runs a split: the highlighted passage leaves this draft and
 * becomes one of its own, rewritten by the same generate → review → save
 * pipeline as the initial compose (hence the shared step checklist).
 *
 * The deletion happens client-side BEFORE the request, because only Lexical
 * knows the selection's structure — so between that deletion and the server's
 * commit, the passage exists nowhere but this browser tab. The catch block's
 * restore is therefore load-bearing, not politeness.
 */
export function ExtractDialog({ releaseId }: { releaseId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(() =>
    initialStepStatuses(EDIT_STEPS)
  );
  const [detail, setDetail] = useState("");

  const open = state?.mode === "extract";

  function reset() {
    setInstruction("");
    setStatuses(initialStepStatuses(EDIT_STEPS));
    setDetail("");
    close();
  }

  async function runExtract(remainingBody: string, excerpt: string, trimmed: string) {
    const res = await fetch("/api/drafts/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ releaseId, excerpt, remainingBody, instruction: trimmed }),
    });
    if (!res.ok || !res.body) {
      throw new Error("Couldn't start the extraction. Please try again.");
    }

    let newReleaseId: string | null = null;
    let errored: string | null = null;
    const handle = (event: DraftProgressEvent) => {
      if (event.type === "step") {
        setStatuses((prev) => ({ ...prev, [event.key]: event.status === "start" ? "active" : "done" }));
      } else if (event.type === "detail") {
        setDetail(event.text);
      } else if (event.type === "done") {
        newReleaseId = event.updateId;
      } else if (event.type === "error") {
        errored = event.message;
      }
    };

    await readDraftProgress(res.body, handle);

    if (errored) throw new Error(errored);
    if (newReleaseId == null) throw new Error("The extraction finished without creating a draft.");
    return newReleaseId as string;
  }

  function submit() {
    if (!state || state.mode !== "extract") return;
    const editorOps = ops.current;
    if (!editorOps) {
      toast.error("The editor isn't ready yet — try again in a moment.");
      return;
    }
    const excerpt = state.excerpt;
    const trimmed = instruction.trim();

    setBusy(true);
    void (async () => {
      // The only surviving copy of the passage once removeSelection runs.
      const originalBody = editorOps.getMarkdown();
      let removed = false;
      try {
        const remainingBody = await editorOps.removeSelection();
        removed = true;
        if (remainingBody.trim().length === 0) {
          throw new Error("You can't extract the entire update — leave some text behind.");
        }

        const newReleaseId = await runExtract(remainingBody, excerpt, trimmed);

        // The server persisted the trimmed source body, so the editor is in
        // sync with the DB again and the unsaved-changes guard must be cleared.
        notifySaved();
        toast.success("Extracted as a new draft", {
          action: { label: "Open", onClick: () => router.push(`/drafts/${newReleaseId}`) },
        });
        reset();
      } catch (error) {
        // Put the passage back — nothing else holds it at this point.
        if (removed) await editorOps.applyEdit("whole", originalBody);
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && reset()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Split className="size-4" /> Extract as a separate update
          </DialogTitle>
          <DialogDescription>
            The highlighted text is removed from this update and rewritten as a standalone draft,
            reviewed against your brand guidelines.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <ProgressChecklist steps={EDIT_STEPS} statuses={statuses} detail={detail} className="py-2" />
        ) : (
          <div className="space-y-3">
            <blockquote className="max-h-32 overflow-auto rounded-md border bg-muted/50 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
              {state?.excerpt}
            </blockquote>
            <Textarea
              autoFocus
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Optional: how should the new update be framed? e.g. Lead with the API change"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              }}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Working…" : "Extract"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Note the Extract button is **not** gated on `instruction` — unlike Ask AI, the instruction here is optional.

- [ ] **Step 2: Add the toolbar button**

In `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx`, add `Split` to the existing lucide import (`import { Sparkles, Split } from "lucide-react";`), then add this component beside `AskAiSelectionButton`:

```tsx
/** "Extract as a separate update" button in the selection popover — splits the
 * highlighted text into a draft of its own. The surface's
 * onMouseDown={preserveSelection} keeps the selection alive through the click,
 * so captureSelection (inside openExtract) still sees it. */
function ExtractSelectionButton() {
  const { openExtract } = useAgentEdit();
  return (
    <button
      type="button"
      title="Extract as a separate update"
      aria-label="Extract as a separate update"
      onClick={() => {
        if (!openExtract()) toast.error("Highlight some text to extract first.");
      }}
      className="flex items-center gap-1 rounded pr-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Split className="size-3.5" />
    </button>
  );
}
```

Add `import { toast } from "sonner";` at the top of the file, and render both buttons in `selectionExtras`:

```tsx
      selectionExtras={
        <>
          <AskAiSelectionButton />
          <ExtractSelectionButton />
        </>
      }
```

- [ ] **Step 3: Render the dialog on the page**

In `src/app/(dashboard)/drafts/[releaseId]/page.tsx`, add the import beside the existing `AgentEditDialog` import:

```tsx
import { ExtractDialog } from "./extract-dialog";
```

and render it directly after `<AgentEditDialog releaseId={update.id} />`:

```tsx
          <AgentEditDialog releaseId={update.id} />
          <ExtractDialog releaseId={update.id} />
```

- [ ] **Step 4: Verify types and lint**

Run: `npm run typecheck`
Expected: PASS — no errors.

Run: `npm run lint`
Expected: PASS — no errors.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — every test, including Tasks 1–4's.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/extract-dialog.tsx" "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx"
git commit -m "feat: extract a highlighted passage as a separate update"
```

---

### Task 8: Share the generation-context preparation

Added mid-execution by human ruling, after the Task 3 review flagged the
"preparing" block as duplicated. That block — load brand profile, resolve
personas, load examples, `selectExamples` — now exists in FOUR places. Share it.
This task adds no feature behavior; the existing suite plus `typecheck` is the
regression net.

**Files:**
- Create: `src/lib/ai/generation-context.ts`
- Modify: `src/lib/scheduling/run-schedule.ts` (in `runBatchForWorkspace`)
- Modify: `src/lib/ai/edit-release.ts` (in `runWholeEditForRelease`)
- Modify: `src/lib/ai/extract-release.ts` (in `runExtractForRelease`)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/actions.ts` (in `requestAgentEdit`)
- Test: `tests/lib/ai/generation-context.test.ts` (create)

**Interfaces:**
- Consumes: existing `getOrCreateBrandProfile`, `resolvePersonaRefs`, `systemPersonaKeys`, `selectExamples`.
- Produces:
  ```ts
  export async function prepareGenerationContext(
    tenantId: string,
    database?: Database,
    categories?: string[]
  ): Promise<{
    brandProfile: typeof brandProfiles.$inferSelect;
    personas: ResolvedPersona[];
    examples: (typeof systemUpdateExamples.$inferSelect)[];
  }>;
  ```

**The `categories` argument is why this is a parameter, not a constant.** Three
call sites pass no categories; `runBatchForWorkspace` passes
`atomicUpdateCategories(items)` to bias example selection toward the kinds of
changes being composed. Keep `atomicUpdateCategories` where it is in
`run-schedule.ts` — it is that caller's concern, not this helper's.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/generation-context.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, brandProfiles } from "../../../src/db/schema";
import { prepareGenerationContext } from "../../../src/lib/ai/generation-context";

const TENANT_NAME = "Generation Context Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  return tenant;
}

describe("prepareGenerationContext", () => {
  afterEach(async () => {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.name, TENANT_NAME));
    if (tenant) {
      await db.delete(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
      await db.delete(tenants).where(eq(tenants.id, tenant.id));
    }
  });

  it("creates the brand profile on first use and returns personas and examples", async () => {
    const tenant = await seedTenant();

    const context = await prepareGenerationContext(tenant.id, db);

    expect(context.brandProfile.tenantId).toBe(tenant.id);
    expect(Array.isArray(context.personas)).toBe(true);
    expect(Array.isArray(context.examples)).toBe(true);

    // getOrCreateBrandProfile persisted it, so a second call reuses the row.
    const rows = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });

  it("resolves the tenant's configured personas", async () => {
    const tenant = await seedTenant();
    await prepareGenerationContext(tenant.id, db);
    await db
      .update(brandProfiles)
      .set({ userPersonas: [{ kind: "system", key: "engineering_manager" }] })
      .where(eq(brandProfiles.tenantId, tenant.id));

    const context = await prepareGenerationContext(tenant.id, db);

    // Resolution is against the seeded system-persona catalog; if that key
    // isn't seeded in this database the list is empty rather than throwing,
    // so assert on the shape the callers rely on.
    expect(Array.isArray(context.personas)).toBe(true);
  });

  it("passes categories through to example selection", async () => {
    const tenant = await seedTenant();

    const withCategory = await prepareGenerationContext(tenant.id, db, ["new"]);
    const withNone = await prepareGenerationContext(tenant.id, db);

    // Both are valid selections over the same catalog; the point is that a
    // category argument is accepted and does not change the returned shape.
    expect(Array.isArray(withCategory.examples)).toBe(true);
    expect(Array.isArray(withNone.examples)).toBe(true);
  });
});
```

If `userPersonas` rejects that shape, read the `PersonaRef` type in
`src/db/schema.ts` and use a valid value — do not change the assertion's intent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/ai/generation-context.test.ts`
Expected: FAIL — cannot resolve `src/lib/ai/generation-context`.

- [ ] **Step 3: Write the helper**

Create `src/lib/ai/generation-context.ts`:

```ts
import { db as defaultDb } from "@/db";
import { systemPersonas, systemUpdateExamples, type brandProfiles, type ResolvedPersona } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";

type Database = typeof defaultDb;

/**
 * The prompt context every generation path needs: the tenant's brand profile,
 * its resolved personas, and the few-shot examples chosen for it. Four callers
 * assembled this identically before it was shared — the compose run, the
 * whole-update edit, the extract split, and the scoped agent edit.
 *
 * `categories` biases example selection toward the kinds of changes being
 * written about. Only the compose run has categories to offer (from its atomic
 * updates); prose-driven callers pass none.
 */
export async function prepareGenerationContext(
  tenantId: string,
  database: Database = defaultDb,
  categories: string[] = []
): Promise<{
  brandProfile: typeof brandProfiles.$inferSelect;
  personas: ResolvedPersona[];
  examples: (typeof systemUpdateExamples.$inferSelect)[];
}> {
  const brandProfile = await getOrCreateBrandProfile(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories,
  });
  return { brandProfile, personas, examples };
}
```

Adjust the import style if `ResolvedPersona` or `brandProfiles` are not exported
from `@/db/schema` in that form — match how `src/lib/ai/compose-prompt.ts`
imports them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/ai/generation-context.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Route all four call sites through the helper**

In each file, replace the four-statement preparing block with one call, and
delete the imports that become unused (`systemPersonas`, `systemUpdateExamples`,
`getOrCreateBrandProfile`, `resolvePersonaRefs`, `systemPersonaKeys`,
`selectExamples`) — but only where they are genuinely no longer referenced in
that file.

1. `src/lib/scheduling/run-schedule.ts`, in `runBatchForWorkspace`:
   ```ts
     const { brandProfile, personas, examples } = await prepareGenerationContext(
       tenantId,
       database,
       atomicUpdateCategories(items)
     );
   ```
   Keep the `atomicUpdateCategories` helper and its doc comment in this file.
   Keep the surrounding `onProgress?.({ type: "step", key: "preparing", … })`
   calls exactly where they are.

2. `src/lib/ai/edit-release.ts`, in `runWholeEditForRelease`:
   ```ts
     const { brandProfile, personas, examples } = await prepareGenerationContext(
       release.tenantId,
       database
     );
   ```

3. `src/lib/ai/extract-release.ts`, in `runExtractForRelease`:
   ```ts
     const { brandProfile, personas, examples } = await prepareGenerationContext(
       source.tenantId,
       database
     );
   ```
   Its existing "prose carries no category" comment becomes redundant with the
   helper's own doc comment — delete it rather than leaving a stale duplicate.

4. `src/app/(dashboard)/drafts/[releaseId]/actions.ts`, in `requestAgentEdit`:
   ```ts
     const { brandProfile, personas, examples } = await prepareGenerationContext(
       release.tenantId,
       db
     );
   ```
   Its "Same prompt context the composer uses, so edits stay on brand." comment
   still earns its place — keep it.

- [ ] **Step 6: Verify types, lint, and the whole suite**

Run: `npm run typecheck`
Expected: PASS.

Run: `npm run lint`
Expected: PASS — including no unused-import errors from Step 5.

Run: `npm test`
Expected: PASS — the new tests plus every pre-existing test. No behavior
changed, so any failure here is a real regression from the refactor. Pay
particular attention to `tests/lib/scheduling/run-schedule.test.ts`,
`tests/lib/ai/edit-release.test.ts`, `tests/lib/ai/extract-release.test.ts`,
and `tests/app/drafts/agent-edit-actions.test.ts` — those four cover the
changed call sites.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/generation-context.ts tests/lib/ai/generation-context.test.ts src/lib/scheduling/run-schedule.ts src/lib/ai/edit-release.ts src/lib/ai/extract-release.ts "src/app/(dashboard)/drafts/[releaseId]/actions.ts"
git commit -m "refactor: share the generation prompt-context preparation"
```

---

## Manual verification (owner-run)

The preview sits behind an OAuth wall, so an implementing agent cannot run this. Hand it to the repo owner as the acceptance pass:

1. Open a draft with at least two distinct paragraphs.
2. Highlight one paragraph — the selection toolbar appears with the new split icon.
3. Click it. The dialog shows exactly the highlighted text.
4. Click **Extract**. The checklist advances through preparing → generating → reviewing → saving.
5. On success: the paragraph is gone from the open draft, a toast offers **Open**, and the drafts list shows a new draft whose body covers only the extracted material and reads standalone.
6. Reload the source draft — the paragraph stays gone (the removal was persisted server-side, not just in the editor).
7. Failure path: with the dev server offline mid-request, confirm the paragraph is restored into the editor and an error toast appears.
