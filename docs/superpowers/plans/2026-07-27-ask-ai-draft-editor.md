# Ask AI Edits in the Draft Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user ask the composer agent to revise a product-update draft from inside the editor — a surgical edit on highlighted text, or an instruction applied to the whole body — with a compose-style loader, applied and auto-saved.

**Architecture:** Two entry points (a button in the existing selection popover; a button in the action row next to "Save changes") open one shared modal. The modal calls a `requestAgentEdit` server action (single `generateObject` call, no DB write) that returns revised Markdown. The client applies it — surgically via MDXEditor's Lexical `insertMarkdown` over a captured-and-restored selection, or wholesale via `setMarkdown` — then persists with a focused `saveDraftBody` action and clears the dirty flag.

**Tech Stack:** Next.js 16 (App Router, server actions), React client components, `@mdxeditor/editor` v4 (Lexical), `lexical`, `@ai-sdk/anthropic` + `ai` (`generateObject`), Drizzle/Postgres, Vitest, Base UI dialog, Tailwind, lucide-react.

## Global Constraints

- **Read the Next.js guides first.** Per `AGENTS.md`, this Next.js version has breaking changes — before writing server-action or App Router code, read the relevant guide in `node_modules/next/dist/docs/`.
- **LLM provider is direct Anthropic** via `@ai-sdk/anthropic` — do NOT route through the Vercel AI Gateway.
- **Model spec:** `process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5"` (match `generation.ts` exactly).
- **Scope is the body only** — never the title.
- **No token streaming** — single blocking `generateObject`, consistent with the initial compose.
- **Tests:** Vitest, `environment: "node"`, run with `npm test`. Server-action tests hit a **real** test Postgres (run `npm run db:migrate:test` once if the test DB isn't migrated). There is **no** React Testing Library — client components (Tasks 4–7) are verified by `npm run typecheck` + `npm run lint`, then **manual browser verification by the user** (dev preview sits behind an OAuth wall and can't be self-verified).
- **Tenant safety:** every action re-derives ownership from `requireSession()` via `loadOwnedDraft(tenantId, releaseId)` — never trust a client-supplied id.
- Match surrounding code style: comment density, naming, and the "don't import a sibling route's private helper — copy it" convention already in these files.

---

## File Structure

**New**
- `src/lib/ai/edit.ts` — `editReleaseBody` generator + `stripWrapping` helper.
- `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx` — modal state + editor-ops registry (client).
- `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx` — the shared modal (client).
- `src/app/(dashboard)/drafts/[releaseId]/ask-ai-button.tsx` — action-row (whole-update) button (client).

**Modified**
- `src/lib/ai/compose-prompt.ts` — add `composeScopedEditPrompt`, `composeWholeEditPrompt`.
- `src/app/(dashboard)/drafts/[releaseId]/actions.ts` — add `requestAgentEdit`, `saveDraftBody`.
- `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — editor ref, `AgentEditBridge`, "Ask AI" selection button.
- `src/app/(dashboard)/drafts/[releaseId]/page.tsx` — mount `AgentEditProvider` + `AgentEditDialog`, place `AskAiButton`.

**New tests**
- `tests/lib/ai/compose-edit-prompts.test.ts`
- `tests/lib/ai/edit.test.ts`
- `tests/app/drafts/agent-edit-actions.test.ts`

---

## Task 1: Scoped & whole edit prompt builders

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts` (append after `composeMergePrompt`, ~line 144)
- Test: `tests/lib/ai/compose-edit-prompts.test.ts`

**Interfaces:**
- Consumes: existing `buildSystemPrompt`, module const `DEFAULT_MAX_PROMPT_CHARS`, types `BrandProfileRow`/`ResolvedPersona`/`ExampleRow` (already in the file).
- Produces:
  - `composeScopedEditPrompt(args: { fullBody: string; excerpt: string; instruction: string; brandProfile: BrandProfileRow; personas: ResolvedPersona[]; examples: ExampleRow[] }): { system: string; prompt: string }`
  - `composeWholeEditPrompt(args: { currentBody: string; instruction: string; brandProfile: BrandProfileRow; personas: ResolvedPersona[]; examples: ExampleRow[] }): { system: string; prompt: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/compose-edit-prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { composeScopedEditPrompt, composeWholeEditPrompt } from "../../../src/lib/ai/compose-prompt";
import type { brandProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

// Minimal brand profile — buildSystemPrompt only reads these fields.
const brandProfile = {
  tenantId: "tenant-1",
  industry: null,
  tone: null,
  readingLevel: null,
  doList: [],
  dontList: [],
  examplePhrases: [],
  updatesStyleSummary: null,
  userPersonas: [],
} as unknown as BrandProfileRow;

describe("composeScopedEditPrompt", () => {
  it("includes the excerpt, instruction and full body, and constrains output to the excerpt only", () => {
    const { system, prompt } = composeScopedEditPrompt({
      fullBody: "Para one.\n\nThe old sentence.\n\nPara three.",
      excerpt: "The old sentence.",
      instruction: "make it punchier",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("The old sentence.");
    expect(prompt).toContain("make it punchier");
    expect(prompt).toContain("Para one.");
    expect(system.toLowerCase()).toContain("only the revised excerpt");
    expect(system.toLowerCase()).toContain("no code fences");
  });
});

describe("composeWholeEditPrompt", () => {
  it("includes the instruction and current body, and asks for the full revised body preserving wording", () => {
    const { system, prompt } = composeWholeEditPrompt({
      currentBody: "The whole update body.",
      instruction: "shorten everything",
      brandProfile,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("shorten everything");
    expect(prompt).toContain("The whole update body.");
    expect(system.toLowerCase()).toContain("full revised body");
    expect(system.toLowerCase()).toContain("rather than rewrite");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compose-edit-prompts`
Expected: FAIL — `composeScopedEditPrompt` / `composeWholeEditPrompt` are not exported.

- [ ] **Step 3: Implement the builders**

Append to `src/lib/ai/compose-prompt.ts`:

```ts
/**
 * Prompt for a SURGICAL edit of one highlighted excerpt: the full body is
 * context only, and the model must return just the revised excerpt so the
 * client can splice it back in place (see `replaceSelection`). Contrast
 * `composeWholeEditPrompt`, which returns the whole body.
 */
export function composeScopedEditPrompt(args: {
  fullBody: string;
  excerpt: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system = `${base}\n\nYou are revising ONE excerpt of an existing product update, not writing a fresh one. Return only the revised excerpt as Markdown — no surrounding text, no explanation, no code fences. Match the voice and formatting of the rest of the update, and change only what the instruction asks; keep the facts and meaning otherwise intact.`;

  const fullBody =
    args.fullBody.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.fullBody.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.fullBody;

  const prompt = `Full update, for context only — do not return it:\n${fullBody}\n\nExcerpt to revise:\n${args.excerpt}\n\nInstruction: ${args.instruction}\n\nReturn only the revised excerpt.`;
  return { system, prompt };
}

/**
 * Prompt for a WHOLE-update edit: apply an instruction across the body and
 * return the full revised body, preserving existing wording where the
 * instruction doesn't call for change (same "revise, don't rewrite" stance as
 * `composeMergePrompt`).
 */
export function composeWholeEditPrompt(args: {
  currentBody: string;
  instruction: string;
  brandProfile: BrandProfileRow;
  personas: ResolvedPersona[];
  examples: ExampleRow[];
}): { system: string; prompt: string } {
  const base = buildSystemPrompt(args.brandProfile, args.personas, args.examples);
  const system = `${base}\n\nYou are revising an existing product update per an instruction — not writing a fresh one. Preserve the current wording and structure wherever the instruction doesn't call for a change; edit and extend rather than rewrite from scratch. Return the full revised body as Markdown — no explanation, no code fences.`;

  const currentBody =
    args.currentBody.length > DEFAULT_MAX_PROMPT_CHARS
      ? `${args.currentBody.slice(0, DEFAULT_MAX_PROMPT_CHARS)}\n…(truncated)`
      : args.currentBody;

  const prompt = `Apply this instruction to the product update below and return the full revised body. Format as Markdown (short paragraphs, and bullet lists where helpful).\n\nInstruction: ${args.instruction}\n\nCurrent body:\n${currentBody}`;
  return { system, prompt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- compose-edit-prompts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/compose-prompt.ts tests/lib/ai/compose-edit-prompts.test.ts
git commit -m "feat: add scoped and whole edit prompt builders"
```

---

## Task 2: `editReleaseBody` generator + `stripWrapping`

**Files:**
- Create: `src/lib/ai/edit.ts`
- Test: `tests/lib/ai/edit.test.ts`

**Interfaces:**
- Consumes: `composeScopedEditPrompt` / `composeWholeEditPrompt` (Task 1); `resolveModel`, `modelId` from `./model`; `recordLlmUsage` from `./llm-usage`; `generateObject` from `ai`.
- Produces:
  - `stripWrapping(raw: string): string`
  - `editReleaseBody(args: { mode: "selection" | "whole"; instruction: string; currentBody: string; excerpt: string; brandProfile: BrandProfileRow; personas?: ResolvedPersona[]; examples?: ExampleRow[] }): Promise<string>` — returns the revised text (excerpt for `selection`, full body for `whole`), already `stripWrapping`-cleaned.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ai/edit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { brandProfiles } from "../../../src/db/schema";

type BrandProfileRow = typeof brandProfiles.$inferSelect;

const generateObject = vi.fn();
vi.mock("ai", () => ({ generateObject: (...args: unknown[]) => generateObject(...args) }));
vi.mock("../../../src/lib/ai/model", () => ({
  resolveModel: vi.fn(() => "test-model"),
  modelId: vi.fn(() => "test-model-id"),
}));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { editReleaseBody, stripWrapping } from "../../../src/lib/ai/edit";

const brandProfile = { tenantId: "t1", industry: null, tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], updatesStyleSummary: null, userPersonas: [] } as unknown as BrandProfileRow;

describe("stripWrapping", () => {
  it("removes a wrapping code fence", () => {
    expect(stripWrapping("```md\nhello world\n```")).toBe("hello world");
  });
  it("removes surrounding quotes", () => {
    expect(stripWrapping('"hello"')).toBe("hello");
  });
  it("leaves clean text untouched", () => {
    expect(stripWrapping("hello world")).toBe("hello world");
  });
});

describe("editReleaseBody", () => {
  beforeEach(() => generateObject.mockReset());

  it("uses the scoped prompt in selection mode and strips wrapping from the result", async () => {
    generateObject.mockResolvedValue({ object: { text: "```\nrevised excerpt\n```" }, usage: {} });
    const out = await editReleaseBody({
      mode: "selection", instruction: "punchier", currentBody: "full body", excerpt: "old excerpt", brandProfile,
    });
    expect(out).toBe("revised excerpt");
    const call = generateObject.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("only the revised excerpt");
    expect(call.prompt).toContain("old excerpt");
  });

  it("uses the whole prompt in whole mode", async () => {
    generateObject.mockResolvedValue({ object: { text: "new full body" }, usage: {} });
    const out = await editReleaseBody({
      mode: "whole", instruction: "shorten", currentBody: "long body", excerpt: "", brandProfile,
    });
    expect(out).toBe("new full body");
    const call = generateObject.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("full revised body");
    expect(call.prompt).toContain("long body");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/lib/ai/edit`
Expected: FAIL — module `src/lib/ai/edit.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/ai/edit.ts`**

```ts
import { generateObject } from "ai";
import { z } from "zod";
import type { brandProfiles, ResolvedPersona, systemUpdateExamples } from "@/db/schema";
import { composeScopedEditPrompt, composeWholeEditPrompt } from "./compose-prompt";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

type BrandProfileRow = typeof brandProfiles.$inferSelect;
type ExampleRow = typeof systemUpdateExamples.$inferSelect;

const EditResultSchema = z.object({ text: z.string() });

/**
 * Strips a single wrapping code-fence or matching quote pair the model may add
 * around the returned text, so a surgical replacement doesn't inject stray
 * Markdown into the middle of the body.
 */
export function stripWrapping(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1);
  }
  return text;
}

/**
 * Single-call agent edit of a draft body. In `selection` mode it returns just
 * the revised excerpt (spliced back in place client-side); in `whole` mode it
 * returns the full revised body. Mirrors `generateReleaseDraft`'s model
 * resolution and usage recording.
 */
export async function editReleaseBody(args: {
  mode: "selection" | "whole";
  instruction: string;
  currentBody: string;
  excerpt: string;
  brandProfile: BrandProfileRow;
  personas?: ResolvedPersona[];
  examples?: ExampleRow[];
}): Promise<string> {
  const personas = args.personas ?? [];
  const examples = args.examples ?? [];

  const { system, prompt } =
    args.mode === "selection"
      ? composeScopedEditPrompt({
          fullBody: args.currentBody,
          excerpt: args.excerpt,
          instruction: args.instruction,
          brandProfile: args.brandProfile,
          personas,
          examples,
        })
      : composeWholeEditPrompt({
          currentBody: args.currentBody,
          instruction: args.instruction,
          brandProfile: args.brandProfile,
          personas,
          examples,
        });

  const spec = process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5";
  const result = await generateObject({
    model: resolveModel(spec),
    schema: EditResultSchema,
    system,
    prompt,
  });

  await recordLlmUsage({
    tenantId: args.brandProfile.tenantId,
    operation: "generation",
    model: modelId(spec),
    usage: result.usage,
  });

  return stripWrapping(result.object.text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/lib/ai/edit`
Expected: PASS (all `stripWrapping` + `editReleaseBody` cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/edit.ts tests/lib/ai/edit.test.ts
git commit -m "feat: add editReleaseBody generator for agent edits"
```

---

## Task 3: `requestAgentEdit` + `saveDraftBody` server actions

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/actions.ts`
- Test: `tests/app/drafts/agent-edit-actions.test.ts`

**Interfaces:**
- Consumes: `editReleaseBody` (Task 2); existing `loadOwnedDraft`, `requireSession`, `db`, `releases`; brand context helpers `getOrCreateBrandProfile` (`@/lib/workspace/brand-profile`), `systemPersonas`/`systemUpdateExamples` (`@/db/schema`), `resolvePersonaRefs`/`systemPersonaKeys` (`@/lib/workspace/personas`), `selectExamples` (`@/lib/ai/select-examples`).
- Produces:
  - `requestAgentEdit(input: { releaseId: string; mode: "selection" | "whole"; instruction: string; fullBody: string; excerpt?: string }): Promise<{ text: string }>`
  - `saveDraftBody(input: { releaseId: string; body: string }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/drafts/agent-edit-actions.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases, users } from "../../../src/db/schema";

const TENANT_NAME = "Agent Edit Test Tenant";
const OTHER_NAME = "Agent Edit Other Tenant";
const USER_EMAIL = "agent-edit-test@example.com";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const editReleaseBody = vi.fn(async () => "revised text");
vi.mock("../../../src/lib/ai/edit", () => ({ editReleaseBody: (...a: unknown[]) => editReleaseBody(...a) }));

import { requestAgentEdit, saveDraftBody } from "../../../src/app/(dashboard)/drafts/[releaseId]/actions";

async function seed(body = "Original body") {
  const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
  const [user] = await db.insert(users).values({ email: USER_EMAIL }).returning();
  currentTenantId = tenant.id;
  currentUserId = user.id;
  const [release] = await db.insert(releases).values({ tenantId: tenant.id, title: "T", body }).returning();
  return { tenant, release };
}
async function rowFor(id: string) {
  const [row] = await db.select().from(releases).where(eq(releases.id, id));
  return row;
}

describe("requestAgentEdit", () => {
  afterEach(async () => {
    editReleaseBody.mockClear();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(tenants).where(eq(tenants.name, OTHER_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("returns the agent text for an owned release and passes the live body through", async () => {
    const { release } = await seed();
    const result = await requestAgentEdit({
      releaseId: release.id,
      mode: "selection",
      instruction: "punchier",
      fullBody: "live edited body",
      excerpt: "old",
    });
    expect(result).toEqual({ text: "revised text" });
    expect(editReleaseBody).toHaveBeenCalledTimes(1);
    expect(editReleaseBody.mock.calls[0][0]).toMatchObject({
      mode: "selection",
      instruction: "punchier",
      currentBody: "live edited body",
      excerpt: "old",
    });
  });

  it("refuses a foreign release and never calls the agent", async () => {
    await seed();
    const [other] = await db.insert(tenants).values({ name: OTHER_NAME }).returning();
    const [foreign] = await db.insert(releases).values({ tenantId: other.id, title: "X", body: "b" }).returning();
    await expect(
      requestAgentEdit({ releaseId: foreign.id, mode: "whole", instruction: "x", fullBody: "b" })
    ).rejects.toThrow();
    expect(editReleaseBody).not.toHaveBeenCalled();
  });
});

describe("saveDraftBody", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
    await db.delete(users).where(eq(users.email, USER_EMAIL));
  });

  it("updates only the body and stamps bodyEditedAt, leaving the title intact", async () => {
    const { release } = await seed("Original body");
    await saveDraftBody({ releaseId: release.id, body: "Agent-revised body" });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Agent-revised body");
    expect(row.title).toBe("T");
    expect(row.bodyEditedAt).not.toBeNull();
  });

  it("keeps the existing body when handed a blank one (blank-guard)", async () => {
    const { release } = await seed("Original body");
    await saveDraftBody({ releaseId: release.id, body: "   " });
    const row = await rowFor(release.id);
    expect(row.body).toBe("Original body");
    expect(row.bodyEditedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent-edit-actions`
Expected: FAIL — `requestAgentEdit` / `saveDraftBody` are not exported.

- [ ] **Step 3: Add imports and the two actions to `actions.ts`**

Add these imports at the top of `src/app/(dashboard)/drafts/[releaseId]/actions.ts` (alongside the existing ones):

```ts
import { systemPersonas, systemUpdateExamples } from "@/db/schema";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { resolvePersonaRefs, systemPersonaKeys } from "@/lib/workspace/personas";
import { selectExamples } from "@/lib/ai/select-examples";
import { editReleaseBody } from "@/lib/ai/edit";
```

(`db`, `releases`, `and`, `eq`, `revalidatePath`, `requireSession`, and `loadOwnedDraft` are already imported/defined in this file.)

Append the actions:

```ts
/**
 * Runs a single-call agent edit against the draft's live body. `fullBody` comes
 * from the client editor (so unsaved edits are respected) — the DB row is used
 * only for the tenant-ownership check, never as the prompt's body. No DB write:
 * for a surgical edit the final body only exists after the client splices the
 * returned excerpt in, so persistence is a separate `saveDraftBody` call.
 */
export async function requestAgentEdit(input: {
  releaseId: string;
  mode: "selection" | "whole";
  instruction: string;
  fullBody: string;
  excerpt?: string;
}): Promise<{ text: string }> {
  const session = await requireSession();
  const release = await loadOwnedDraft(session.user.tenantId, input.releaseId);

  // Same prompt context the composer uses, so edits stay on brand.
  const brandProfile = await getOrCreateBrandProfile(release.tenantId, db);
  const catalog = await db.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await db.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: [],
  });

  const text = await editReleaseBody({
    mode: input.mode,
    instruction: input.instruction,
    currentBody: input.fullBody,
    excerpt: input.excerpt ?? "",
    brandProfile,
    personas,
    examples,
  });

  return { text };
}

/**
 * Persists a body-only change (the agent edit, applied client-side). Updates
 * just `body` — never the title — so it can't clobber an unsaved title. Same
 * blank-guard and `bodyEditedAt` stamping as `saveDraft`.
 */
export async function saveDraftBody(input: { releaseId: string; body: string }): Promise<void> {
  const session = await requireSession();
  const existing = await loadOwnedDraft(session.user.tenantId, input.releaseId);

  const body =
    input.body.trim().length === 0 && existing.body.trim().length > 0 ? existing.body : input.body;
  const bodyChanged = body !== existing.body;

  await db
    .update(releases)
    .set({
      body,
      editedBy: session.user.id,
      ...(bodyChanged ? { bodyEditedAt: new Date() } : {}),
    })
    .where(eq(releases.id, input.releaseId));

  revalidatePath(`/drafts/${input.releaseId}`);
}
```

Note: this file's existing `import { revalidatePath } from "next/cache"` and `import { db } from "@/db"` etc. already exist — do not duplicate them. Add only the five new imports above.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent-edit-actions`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck, then commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/actions.ts" tests/app/drafts/agent-edit-actions.test.ts
git commit -m "feat: add requestAgentEdit and saveDraftBody actions"
```

---

## Task 4: Agent-edit context (modal state + editor-ops registry)

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx`

**Interfaces:**
- Produces:
  - `type AgentEditMode = "selection" | "whole"`
  - `type EditorOps = { captureSelection: () => string; replaceSelection: (markdown: string) => void; setBody: (markdown: string) => void; getMarkdown: () => string }`
  - `AgentEditProvider({ children })` — client provider.
  - `useAgentEdit()` → `{ ops: React.MutableRefObject<EditorOps | null>; registerOps: (ops: EditorOps | null) => void; state: { mode: AgentEditMode; excerpt: string } | null; openSelectionEdit: () => void; openWholeEdit: () => void; close: () => void }`

- [ ] **Step 1: Create the context file**

```tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

export type AgentEditMode = "selection" | "whole";

/**
 * Imperative editor operations the modal needs, registered by a bridge that
 * lives inside the MDXEditor realm (only there can it reach the Lexical editor
 * and the editor's imperative ref).
 */
export type EditorOps = {
  /** Snapshots the current selection for later restore and returns the
   * highlighted excerpt as Markdown ("" if nothing is selected). */
  captureSelection: () => string;
  /** Replaces the snapshotted selection with `markdown` (surgical edit). */
  replaceSelection: (markdown: string) => void;
  /** Replaces the entire editor body with `markdown` (whole-update edit). */
  setBody: (markdown: string) => void;
  /** The current full editor body as Markdown. */
  getMarkdown: () => string;
};

type AgentEditState = { mode: AgentEditMode; excerpt: string };

type AgentEditContextValue = {
  ops: MutableRefObject<EditorOps | null>;
  registerOps: (ops: EditorOps | null) => void;
  state: AgentEditState | null;
  openSelectionEdit: () => void;
  openWholeEdit: () => void;
  close: () => void;
};

const AgentEditContext = createContext<AgentEditContextValue | null>(null);

/**
 * Coordinates the two "Ask AI" entry points and the shared modal. `ops` is a
 * ref (not state) because the editor registers it asynchronously after mount
 * and a ref update must not force the action-row button to re-render.
 */
export function AgentEditProvider({ children }: { children: ReactNode }) {
  const ops = useRef<EditorOps | null>(null);
  const [state, setState] = useState<AgentEditState | null>(null);

  const registerOps = useCallback((next: EditorOps | null) => {
    ops.current = next;
  }, []);

  const openSelectionEdit = useCallback(() => {
    // Snapshot the selection now, while it is still alive, before the modal
    // steals focus.
    const excerpt = ops.current?.captureSelection() ?? "";
    setState({ mode: "selection", excerpt });
  }, []);

  const openWholeEdit = useCallback(() => setState({ mode: "whole", excerpt: "" }), []);
  const close = useCallback(() => setState(null), []);

  return (
    <AgentEditContext.Provider
      value={{ ops, registerOps, state, openSelectionEdit, openWholeEdit, close }}
    >
      {children}
    </AgentEditContext.Provider>
  );
}

export function useAgentEdit() {
  const ctx = useContext(AgentEditContext);
  if (!ctx) throw new Error("useAgentEdit must be used within an AgentEditProvider");
  return ctx;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (file compiles; not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/agent-edit-context.tsx"
git commit -m "feat: add agent-edit context for the draft editor"
```

---

## Task 5: Editor bridge + "Ask AI" selection button in `mdx-editor.tsx`

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx`

**Interfaces:**
- Consumes: `useAgentEdit` + `EditorOps` (Task 4); MDXEditor `MDXEditorMethods`, `activeEditor$`, `useCellValue` (already imported); `lexical` primitives `$getSelection`, `$isRangeSelection`, `$setSelection`.
- Produces: registered `EditorOps` (via `AgentEditBridge`) and a selection-popover button that calls `openSelectionEdit()`. No new exported symbols.

- [ ] **Step 1: Add imports**

In `mdx-editor.tsx`, add to the `@mdxeditor/editor` import block: `activeEditor$` and the type `MDXEditorMethods`. Add new import lines:

```tsx
import { Sparkles } from "lucide-react";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
import { useAgentEdit, type EditorOps } from "./agent-edit-context";
```

(`useCellValue`, `usePublisher`, `useEffect`, `useRef`, `useState` are already imported.)

- [ ] **Step 2: Create an editor ref and pass it into the toolbar**

In `MdxEditor`, add a ref and attach it to `<MDXEditor>`, and pass it to `EditorSurfaces`:

```tsx
export default function MdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  // ...unchanged JSX until the <MDXEditor> element:
```

On the `<MDXEditor>` element add `ref={editorRef}`, and change the toolbar line to:

```tsx
          toolbarPlugin({
            toolbarClassName: "mdx-toolbar-host",
            toolbarContents: () => <EditorSurfaces editorRef={editorRef} />,
          }),
```

- [ ] **Step 3: Add the bridge and the button, and wire them into `EditorSurfaces`**

Change `EditorSurfaces`' signature to accept the ref, render `AgentEditBridge`, and add the "Ask AI" button inside the `.mdx-surface-selection` div (after `<CreateLink />`):

```tsx
function EditorSurfaces({ editorRef }: { editorRef: React.RefObject<MDXEditorMethods | null> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { mode, pos, selectionSurfaceRef, insertSurfaceRef } = useSelectionSurface(hostRef);
  const preserveSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      <ViewModeBridge />
      <AgentEditBridge editorRef={editorRef} />

      <div ref={hostRef} className="mdx-surface-anchor" />

      <div
        ref={selectionSurfaceRef}
        className="mdx-surface mdx-surface-selection"
        data-open={mode === "selection"}
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={preserveSelection}
      >
        <BoldItalicUnderlineToggles />
        <BlockTypeSelect />
        <ListsToggle />
        <CreateLink />
        <AskAiSelectionButton />
      </div>

      <div
        ref={insertSurfaceRef}
        className="mdx-surface mdx-surface-insert"
        data-open={mode === "insert"}
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={preserveSelection}
      >
        <InsertImage />
        <InsertCodeBlock />
      </div>
    </>
  );
}

/**
 * Registers imperative editor ops (used by the Ask AI modal) into the agent-edit
 * context. Lives inside the MDXEditor realm so it can reach the Lexical editor
 * for deterministic selection capture/restore — the modal steals focus, so we
 * can't rely on the live DOM selection surviving.
 */
function AgentEditBridge({ editorRef }: { editorRef: React.RefObject<MDXEditorMethods | null> }) {
  const activeEditor = useCellValue(activeEditor$);
  const { registerOps } = useAgentEdit();
  const activeEditorRef = useRef<LexicalEditor | null>(null);
  const savedSelection = useRef<RangeSelection | null>(null);
  activeEditorRef.current = activeEditor;

  useEffect(() => {
    const ops: EditorOps = {
      captureSelection: () => {
        const editor = activeEditorRef.current;
        if (editor) {
          editor.getEditorState().read(() => {
            const sel = $getSelection();
            savedSelection.current = $isRangeSelection(sel) ? sel.clone() : null;
          });
        }
        return editorRef.current?.getSelectionMarkdown() ?? "";
      },
      replaceSelection: (markdown: string) => {
        const editor = activeEditorRef.current;
        const saved = savedSelection.current;
        if (!editor || !saved) return;
        // Restore the captured range, then insertMarkdown replaces it:
        // MDXEditor's insertMarkdown$ reads $getSelection() and $insertNodes()
        // over a non-collapsed range, which deletes the selected content first.
        editor.update(() => {
          $setSelection(saved.clone());
        });
        editorRef.current?.insertMarkdown(markdown);
      },
      setBody: (markdown: string) => editorRef.current?.setMarkdown(markdown),
      getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
    };
    registerOps(ops);
    return () => registerOps(null);
  }, [registerOps, editorRef]);

  return null;
}

/** "Ask AI" button in the selection popover — opens the modal scoped to the
 * highlighted text. The surface's onMouseDown={preserveSelection} keeps the
 * selection alive through the click, so captureSelection sees it. */
function AskAiSelectionButton() {
  const { openSelectionEdit } = useAgentEdit();
  return (
    <button
      type="button"
      title="Ask AI to edit the selection"
      aria-label="Ask AI to edit the selection"
      onClick={() => openSelectionEdit()}
      className="ml-1 flex items-center gap-1 rounded border-l border-border/60 pl-2 pr-1 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Sparkles className="size-3.5" />
    </button>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (If `MDXEditorMethods` isn't found, confirm it's added to the `@mdxeditor/editor` import; it is exported from that package.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx"
git commit -m "feat: register editor ops and add Ask AI selection button"
```

---

## Task 6: The shared modal `agent-edit-dialog.tsx`

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx`

**Interfaces:**
- Consumes: `useAgentEdit` (Task 4); `requestAgentEdit`, `saveDraftBody` (Task 3); `useUnsavedChanges` from `../../unsaved-changes`; UI `Dialog*`, `Button`, `Textarea`; icons `Sparkles`, `Loader2`.
- Produces: `AgentEditDialog({ releaseId }: { releaseId: string })`.

- [ ] **Step 1: Create the modal**

```tsx
"use client";

import { useState, useTransition } from "react";
import { Sparkles, Loader2 } from "lucide-react";
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
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { requestAgentEdit, saveDraftBody } from "./actions";

/**
 * Shared "Ask AI" modal for both entry points. Reads the live editor body,
 * asks the agent, applies the result (surgical splice for selection mode, full
 * replace for whole mode), persists it, and clears the body's dirty flag — all
 * behind a compose-style spinner. Rendered once at page level; open state and
 * mode come from the agent-edit context.
 */
export function AgentEditDialog({ releaseId }: { releaseId: string }) {
  const { state, close, ops } = useAgentEdit();
  const { setSectionDirty } = useUnsavedChanges();
  const [instruction, setInstruction] = useState("");
  const [isPending, startTransition] = useTransition();

  const open = state !== null;

  function reset() {
    setInstruction("");
    close();
  }

  function submit() {
    if (!state || !instruction.trim()) return;
    const editorOps = ops.current;
    if (!editorOps) {
      toast.error("The editor isn't ready yet — try again in a moment.");
      return;
    }
    const fullBody = editorOps.getMarkdown();
    const mode = state.mode;
    const excerpt = state.excerpt;

    startTransition(async () => {
      try {
        const { text } = await requestAgentEdit({
          releaseId,
          mode,
          instruction: instruction.trim(),
          fullBody,
          excerpt: mode === "selection" ? excerpt : undefined,
        });

        if (mode === "selection") editorOps.replaceSelection(text);
        else editorOps.setBody(text);

        // Read the authoritative body straight from the editor (no reliance on
        // the hidden input having re-rendered) and persist it.
        const body = editorOps.getMarkdown();
        await saveDraftBody({ releaseId, body });
        setSectionDirty("body", false);

        toast.success("Update revised");
        reset();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isPending && reset()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" /> Ask AI to edit
          </DialogTitle>
          <DialogDescription>
            {state?.mode === "selection"
              ? "Your instruction is applied to the highlighted text only."
              : "Your instruction is applied across the whole update."}
          </DialogDescription>
        </DialogHeader>

        {isPending ? (
          <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Rewriting your update…
          </div>
        ) : (
          <div className="space-y-3">
            {state?.mode === "selection" && state.excerpt.trim() && (
              <blockquote className="max-h-32 overflow-auto rounded-md border bg-muted/50 p-2 text-sm whitespace-pre-wrap text-muted-foreground">
                {state.excerpt}
              </blockquote>
            )}
            <Textarea
              autoFocus
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Make this more concise and benefit-led"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
              }}
            />
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={isPending} />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={isPending || !instruction.trim()}>
            {isPending ? "Rewriting…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (Confirm `DialogClose` supports the `render` prop — it does; the same pattern is used in `catch-up-banner.tsx`.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx"
git commit -m "feat: add shared Ask AI edit modal"
```

---

## Task 7: Action-row button + page wiring

**Files:**
- Create: `src/app/(dashboard)/drafts/[releaseId]/ask-ai-button.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx`

**Interfaces:**
- Consumes: `useAgentEdit` (Task 4); `AgentEditProvider` (Task 4); `AgentEditDialog` (Task 6); `Button`, `Sparkles`.
- Produces: `AskAiButton()` and the fully wired page.

- [ ] **Step 1: Create the action-row button**

`src/app/(dashboard)/drafts/[releaseId]/ask-ai-button.tsx`:

```tsx
"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentEdit } from "./agent-edit-context";

/** Whole-update entry point, placed next to "Save changes" in the action row.
 * Not disabled while the editor mounts — if clicked too early the modal's
 * submit reports the editor isn't ready. */
export function AskAiButton() {
  const { openWholeEdit } = useAgentEdit();
  return (
    <Button type="button" variant="outline" onClick={() => openWholeEdit()}>
      <Sparkles className="size-4" /> Ask AI
    </Button>
  );
}
```

- [ ] **Step 2: Wire the provider, button, and modal into `page.tsx`**

Add imports:

```tsx
import { AgentEditProvider } from "./agent-edit-context";
import { AgentEditDialog } from "./agent-edit-dialog";
import { AskAiButton } from "./ask-ai-button";
```

Wrap the existing `<DraftEditorProvider>` children with `<AgentEditProvider>`: change line 63 area so the provider nests directly inside `DraftEditorProvider` and wraps everything down to line 128, i.e.:

```tsx
      <DraftEditorProvider>
        <AgentEditProvider>
          {/* ...all existing children unchanged... */}
          <AgentEditDialog releaseId={update.id} />
        </AgentEditProvider>
      </DraftEditorProvider>
```

Add `<AgentEditDialog releaseId={update.id} />` as the last child inside `<AgentEditProvider>` (after the `linkedinConfig && <LinkedinPanel .../>` block).

Place the button in the action row — change the action row (lines 110–116) to:

```tsx
          <div className="flex items-center gap-3 pt-4">
            <RejectButton />
            <SaveChangesButton />
            <AskAiButton />
            <div className="ml-auto">
              <PublishDialog targets={publishTargets} />
            </div>
          </div>
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all suites pass (including the three new ones from Tasks 1–3).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/ask-ai-button.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx"
git commit -m "feat: wire Ask AI provider, modal, and action-row button into the draft editor"
```

- [ ] **Step 6: Manual browser verification (user)**

The dev preview is behind an OAuth wall, so this can't be self-verified — the user should confirm in the browser:
1. Highlight text in a draft body → the selection popover shows a **✦ Ask AI** button → click → modal opens showing the excerpt → enter an instruction → **Apply** → spinner → **only the highlighted span** is replaced, the rest is byte-identical, and the change is saved (reload shows it persisted).
2. Click **Ask AI** next to "Save changes" → enter an instruction → the whole body is revised and saved.
3. Confirm the selection replacement lands in the right place (this is the one behavior that can't be unit-tested). If the selection is lost when the modal opens, the fallback is documented in the "Risks" section of the spec — capture is already deterministic here via `savedSelection`, so this should hold.

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-27-ask-ai-draft-editor-design.md`):
- Selection-popover "Ask AI" button → Task 5. ✓
- Action-row button next to "Save changes" → Task 7. ✓
- Shared modal, mode-aware copy, compose-style loader, non-dismissible while pending → Task 6. ✓
- Scoped prompt / whole prompt reusing `buildSystemPrompt` → Task 1. ✓
- `editReleaseBody` single `generateObject`, `GENERATION_MODEL`, `recordLlmUsage`, output hygiene → Task 2. ✓
- `requestAgentEdit` (tenant check, brand context, live `fullBody`, no DB write) → Task 3. ✓
- Surgical apply via Lexical capture/restore + `insertMarkdown`; whole via `setMarkdown` → Tasks 4–5. ✓
- Auto-save via `saveDraftBody` (body-only) + clear dirty via `setSectionDirty("body", false)` → Tasks 3, 6. ✓
- Body-only scope, no title edits → Tasks 1–3 (no title path anywhere). ✓

**Placeholder scan:** No TBD/TODO; every code step has full code; tests contain real assertions.

**Type consistency:** `EditorOps` (captureSelection/replaceSelection/setBody/getMarkdown) defined in Task 4, consumed identically in Tasks 5–6. `requestAgentEdit`/`saveDraftBody` signatures defined in Task 3 match their calls in Task 6. `editReleaseBody` returns `string` (Task 2) and is wrapped to `{ text }` by `requestAgentEdit` (Task 3), consumed as `{ text }` in Task 6. `AgentEditMode` used consistently.

**Known minor limitation (documented, not a gap):** after an agent edit, `saveDraftBody` persists and `setSectionDirty("body", false)` clears the flag, but `DraftBodyEditor`'s internal `baseline` ref isn't re-synced (no `cleanToken` bump, since we intentionally avoid a form submit to dodge the stale-hidden-input race). Practical effect is negligible — the content is saved and shown; only a subsequent manual revert-to-exact-saved-text edge case could mis-flag dirtiness, which a later real save corrects.
