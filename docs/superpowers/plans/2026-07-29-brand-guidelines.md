# Brand Guidelines Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the six brand-style columns with a single markdown guidelines document, edited on its own top-level "Brand guidelines" page using the draft editor.

**Architecture:** Additive-then-subtractive. Task 1 adds the `guidelines` column beside the old ones; Tasks 2–5 move every reader and writer onto it; Task 6 drops the six now-unread columns. Every task leaves `npm run typecheck`, `npm run lint` and `npm test` green, so any task can be reviewed and rejected on its own.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, Vitest (against a real `_test` database), MDXEditor 4, AI SDK v7, shadcn/base-ui components.

## Global Constraints

- **Read the docs first.** This is not stock Next.js — `AGENTS.md` requires reading the relevant guide in `node_modules/next/dist/docs/` before writing framework code.
- **Tests need a real database.** `vitest.setup.ts` hard-fails unless the target database name ends in `_test`. Set `DATABASE_URL` or `TEST_DATABASE_URL` in `.env.local`.
- **Every migration must be applied twice:** `npm run db:migrate` (dev) and `npm run db:migrate:test` (the database vitest uses). A generated-but-unapplied migration produces confusing test failures.
- **Never hand-write migration SQL.** Change `src/db/schema.ts`, then run `npm run db:generate`.
- **No data backfill.** Existing values in the six dropped columns are discarded deliberately. Do not add `UPDATE` statements to any migration.
- **Column name:** `guidelines` (SQL `guidelines`), nullable text.
- **Prompt cap:** `MAX_GUIDELINES_CHARS = 6000`, truncation marker `\n…(truncated)` (note: a real ellipsis character, matching `composeMergePrompt`).
- **Route:** `/brand-guidelines`. **Nav label:** `Brand guidelines`, last entry in `NAV`.
- **Verification per task:** `npm run typecheck && npm run lint && npm test`.

---

### Task 1: Add the `guidelines` column

Additive only. Nothing reads it yet; this task just makes the column exist so later tasks have somewhere to write.

**Files:**
- Modify: `src/db/schema.ts:220-237`
- Create: `src/db/migrations/00XX_*.sql` (generated — do not name it yourself)
- Test: `tests/lib/workspace/brand-profile-columns.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `brandProfiles.guidelines` — `text`, nullable, no default. Type `string | null` on `typeof brandProfiles.$inferSelect`.

- [ ] **Step 1: Write the failing test**

Add this `it` block inside the existing `describe("brand_profiles updates-page columns", …)` in `tests/lib/workspace/brand-profile-columns.test.ts`, after the existing test:

```ts
  it("defaults guidelines to null and round-trips a markdown document", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db.insert(brandProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.guidelines).toBeNull();

    const doc = "## Voice and tone\n\nPlain and direct.\n\n## Don't\n\n- No hype.";
    const [updated] = await db
      .update(brandProfiles)
      .set({ guidelines: doc })
      .where(eq(brandProfiles.id, defaulted.id))
      .returning();
    expect(updated.guidelines).toBe(doc);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/workspace/brand-profile-columns.test.ts
```

Expected: FAIL. The typecheck error is `Object literal may only specify known properties, and 'guidelines' does not exist`; if the cast slips past, Postgres errors with `column "guidelines" does not exist`.

- [ ] **Step 3: Add the column to the schema**

In `src/db/schema.ts`, inside `brandProfiles`, add the column immediately after the `tenantId` field:

```ts
  // The team's product-update communication guidelines, as Markdown. Null until
  // they save for the first time — the editor shows a starter template instead,
  // and the prompt builders omit the guidelines block entirely while it is null.
  guidelines: text("guidelines"),
```

Leave `tone`, `readingLevel`, `doList`, `dontList`, `examplePhrases`, `updatesStyleSummary` in place — Task 6 removes them.

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate && npm run db:migrate && npm run db:migrate:test
```

Confirm the generated SQL is a single `ALTER TABLE "brand_profiles" ADD COLUMN "guidelines" text;` with no other statements.

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/lib/workspace/brand-profile-columns.test.ts
```

Expected: PASS, both tests in the file.

- [ ] **Step 6: Verify the whole suite is still green**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass. Nothing else changed yet.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/workspace/brand-profile-columns.test.ts
git commit -m "feat: add guidelines column to brand_profiles"
```

---

### Task 2: Prompt builders read the guidelines document

Switches both prompt paths off the six style fields and onto `guidelines`. After this task the model is steered by the document — which is null for every workspace until Task 3's importer or Task 5's page writes one, so generation temporarily runs without brand steering. That is expected and resolves in Task 5.

**Files:**
- Modify: `src/lib/ai/compose-prompt.ts:16-51`
- Modify: `src/lib/ai/review-draft.ts:63-73`
- Test: `tests/lib/ai/compose-prompt.test.ts`
- Test: `tests/lib/ai/review-draft.test.ts:8-35`

**Interfaces:**
- Consumes: `brandProfiles.guidelines` (Task 1).
- Produces:
  - `truncateGuidelines(guidelines: string | null): string | null` — exported from `src/lib/ai/compose-prompt.ts`. Trims; returns `null` for null/blank; caps at 6000 chars with a `\n…(truncated)` suffix.
  - `buildSystemPrompt` keeps its existing signature `(brandProfile: BrandProfileRow, personas: ResolvedPersona[], examples: ExampleRow[]) => string`.

- [ ] **Step 1: Write the failing tests for `buildSystemPrompt`**

In `tests/lib/ai/compose-prompt.test.ts`, replace the whole `describe("buildSystemPrompt", …)` block (lines 5–29) with:

```ts
describe("buildSystemPrompt", () => {
  const baseBrand = { guidelines: null, industry: null, userPersonas: [] };

  it("wraps the guidelines document in a delimited block when set", () => {
    const doc = "## Voice and tone\n\nPlain and direct.";
    const system = buildSystemPrompt({ ...baseBrand, guidelines: doc } as never, [], []);
    expect(system).toContain("Follow these brand writing guidelines, written by the team:");
    expect(system).toContain("<brand-guidelines>");
    expect(system).toContain(doc);
    expect(system).toContain("</brand-guidelines>");
  });

  it("omits the block entirely when guidelines are null or blank", () => {
    expect(buildSystemPrompt(baseBrand as never, [], [])).not.toContain("<brand-guidelines>");
    const blank = buildSystemPrompt({ ...baseBrand, guidelines: "   \n  " } as never, [], []);
    expect(blank).not.toContain("<brand-guidelines>");
  });

  it("truncates a document longer than the cap and marks it", () => {
    const system = buildSystemPrompt({ ...baseBrand, guidelines: "x".repeat(6500) } as never, [], []);
    expect(system).toContain("…(truncated)");
    expect(system).not.toContain("x".repeat(6100));
  });

  it("renders persona identity in parentheses when a description is present", () => {
    const withDesc = buildSystemPrompt(baseBrand as never, [{ name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" }], []);
    expect(withDesc).toContain("Developer (Engineers who integrate): cares about APIs");
    const withoutDesc = buildSystemPrompt(baseBrand as never, [{ name: "Ops", brief: "runs infra" }], []);
    expect(withoutDesc).toContain("Ops: runs infra");
    expect(withoutDesc).not.toContain("Ops (");
  });

  it("keeps the examples block after the guidelines block", () => {
    const system = buildSystemPrompt(
      { ...baseBrand, guidelines: "## Do\n\n- Be brief." } as never,
      [],
      [{ category: "new", title: "Dark mode", body: "We shipped dark mode." } as never]
    );
    expect(system.indexOf("</brand-guidelines>")).toBeLessThan(system.indexOf("Dark mode"));
  });
});
```

Also update the two shared fixtures further down the same file so they stop naming dropped columns:

- Line 59 (`composeReleasePrompt` test): replace the inline `brandProfile: { tone: null, … } as never` with `brandProfile: BASE_BRAND`.
- Lines 68–77 (`BASE_BRAND`): replace with

```ts
const BASE_BRAND = { guidelines: null, industry: null, userPersonas: [] } as never;
```

`BASE_BRAND` is declared at line 68 but the `composeReleasePrompt` describe at line 55 now references it. `const` declarations are hoisted-but-uninitialized (TDZ), and the reference only executes when the test body runs — after module evaluation — so this is safe. If it reads awkwardly, move the `BASE_BRAND` declaration above line 55 instead.

- [ ] **Step 2: Write the failing tests for `brandRubric`**

In `tests/lib/ai/review-draft.test.ts`, replace line 9 with:

```ts
const brand = { guidelines: "Tone: calm. Do: be factual. Avoid: hype.", industry: null, userPersonas: [] };
```

Replace the `describe("buildReviewPrompt", …)` block (lines 15–26) with:

```ts
describe("buildReviewPrompt", () => {
  it("includes the guidelines document verbatim and the draft", () => {
    const prompt = buildReviewPrompt(draft, brand as never);
    expect(prompt).toContain("Tone: calm. Do: be factual. Avoid: hype.");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("Buy now.");
  });

  it("falls back to a stated absence when no guidelines are configured", () => {
    const prompt = buildReviewPrompt(draft, { guidelines: null, industry: null, userPersonas: [] } as never);
    expect(prompt).toContain("No specific brand requirements are configured.");
  });
});
```

In the `describe("buildRevisionPrompt", …)` block, change the `expect(prompt).toContain("Tone: calm.")` assertion at line 31 to:

```ts
    expect(prompt).toContain("Tone: calm. Do: be factual. Avoid: hype.");
```

- [ ] **Step 3: Run both test files to verify they fail**

```bash
npx vitest run tests/lib/ai/compose-prompt.test.ts tests/lib/ai/review-draft.test.ts
```

Expected: FAIL — the `<brand-guidelines>` assertions fail because `buildSystemPrompt` ignores the field, and `buildReviewPrompt` still emits `Tone: …` from the dropped columns.

- [ ] **Step 4: Rewrite `buildSystemPrompt`**

In `src/lib/ai/compose-prompt.ts`, add the cap constant next to `DEFAULT_MAX_PROMPT_CHARS` (line 6):

```ts
const MAX_GUIDELINES_CHARS = 6000;
```

Add the exported helper above `buildSystemPrompt`:

```ts
/**
 * The team's brand guidelines document, prepared for prompt injection: trimmed,
 * and capped so a very long document can't crowd out the material being
 * summarized. Returns null when nothing is configured, so callers omit the
 * block entirely rather than injecting an empty one.
 */
export function truncateGuidelines(guidelines: string | null): string | null {
  const trimmed = guidelines?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_GUIDELINES_CHARS
    ? `${trimmed.slice(0, MAX_GUIDELINES_CHARS)}\n…(truncated)`
    : trimmed;
}
```

Replace the body of `buildSystemPrompt` (lines 16–51) with:

```ts
export function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[]
): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    "Write only about this company's own product. Never name, compare to, or reference competitors or other companies.",
    "Ground every statement strictly in the source material you are given. Only describe changes that appear in that material; never invent or embellish features, capabilities, benefits, use cases, metrics, numbers, dates, version names, quotes, or any other specifics. If a detail is not in the source, leave it out rather than guessing — an omission is always better than a fabrication.",
    "Never fabricate links. Only include a URL if it appears verbatim in the source material; do not construct, complete, shorten, or recall a URL from memory, and do not guess a plausible one. If a link would be helpful but no verified URL is present in the source, write the literal placeholder [add link] in its place so an editor can fill it in — never emit a made-up or guessed URL.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    personas.length > 0
      ? `Audience personas — tailor the update to appeal to each: ${personas.map(renderPersona).join(" ")}`
      : null,
  ].filter((line): line is string => Boolean(line));

  // The fixed instructions read as one paragraph, but the guidelines document is
  // Markdown — joining it with " " like the lines above would flatten its
  // structure, so it becomes its own block. Delimiters keep the team's prose
  // from reading as further instructions to the model.
  const blocks = [lines.join(" ")];

  const guidelines = truncateGuidelines(brandProfile.guidelines);
  if (guidelines) {
    blocks.push(
      `Follow these brand writing guidelines, written by the team:\n<brand-guidelines>\n${guidelines}\n</brand-guidelines>`
    );
  }

  if (examples.length > 0) {
    blocks.push(
      [
        "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
        ...examples.map(renderExample),
      ].join("\n\n")
    );
  }

  return blocks.join("\n\n");
}
```

- [ ] **Step 5: Rewrite `brandRubric`**

In `src/lib/ai/review-draft.ts`, add to the imports at the top (it already imports from `./generation`, `./model`, `./llm-usage` with relative paths — match that):

```ts
import { truncateGuidelines } from "./compose-prompt";
```

Replace `brandRubric` (lines 63–73) with:

```ts
function brandRubric(brandProfile: BrandProfileRow): string {
  return truncateGuidelines(brandProfile.guidelines) ?? "No specific brand requirements are configured.";
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/ai/compose-prompt.test.ts tests/lib/ai/review-draft.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verify the whole suite**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass. `tests/lib/ai/generation.test.ts`, `edit.test.ts` and `compose-edit-prompts.test.ts` still list the dropped fields in their fixtures, but those objects are cast with `as never` / `as unknown as BrandProfileRow`, which suppresses excess-property checks — they keep compiling and their assertions don't touch the brand lines. Task 6 cleans them up.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/compose-prompt.ts src/lib/ai/review-draft.ts tests/lib/ai/compose-prompt.test.ts tests/lib/ai/review-draft.test.ts
git commit -m "feat: steer generation and review from the brand guidelines document"
```

---

### Task 3: Importer derives a markdown document

The URL analyzer stops emitting six fields and emits one markdown document plus `industry`. Also introduces the starter template, because the analysis prompt and the editor's empty state must ask for the same headings.

**Files:**
- Create: `src/lib/workspace/guidelines-template.ts`
- Modify: `src/lib/workspace/analyze-brand-style.ts`
- Modify: `src/lib/workspace/brand-import.ts:31-57`
- Test: `tests/lib/workspace/analyze-brand-style.test.ts:32-55`
- Test: `tests/lib/workspace/brand-import.test.ts:14-48`
- Create: `tests/lib/workspace/guidelines-template.test.ts`

**Interfaces:**
- Consumes: `brandProfiles.guidelines` (Task 1).
- Produces:
  - `GUIDELINES_TEMPLATE: string` and `GUIDELINES_HEADINGS: readonly string[]` — exported from `src/lib/workspace/guidelines-template.ts`. `GUIDELINES_HEADINGS` lists the five `## …` heading texts without their `## ` prefix.
  - `DerivedBrandProfile = { guidelines: string | null; industry: string | null }`.
  - `analyzeBrandStyle(pageText: string, tenantId: string): Promise<DerivedBrandProfile>` — signature unchanged.
  - `importBrandStyleForTenant(tenantId, url, deps?)` — signature unchanged; `deps.analyze` now returns the two-field shape.

- [ ] **Step 1: Write the failing test for the template**

Create `tests/lib/workspace/guidelines-template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GUIDELINES_TEMPLATE, GUIDELINES_HEADINGS } from "../../../src/lib/workspace/guidelines-template";

describe("GUIDELINES_TEMPLATE", () => {
  it("is a non-empty markdown document", () => {
    expect(GUIDELINES_TEMPLATE.trim().length).toBeGreaterThan(0);
  });

  // The analysis prompt asks the model for these exact headings and the editor
  // seeds an empty workspace with them. If the two drift apart, an imported
  // document and a hand-written one stop looking like the same artifact.
  it("contains every heading listed in GUIDELINES_HEADINGS", () => {
    for (const heading of GUIDELINES_HEADINGS) {
      expect(GUIDELINES_TEMPLATE).toContain(`## ${heading}`);
    }
  });

  it("lists five headings", () => {
    expect(GUIDELINES_HEADINGS).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run tests/lib/workspace/guidelines-template.test.ts
```

Expected: FAIL with `Failed to resolve import "…/guidelines-template"`.

- [ ] **Step 3: Create the template module**

Create `src/lib/workspace/guidelines-template.ts`:

```ts
// The shape of a brand guidelines document. Two consumers depend on these
// headings agreeing: the URL analyzer is asked to produce them, and the editor
// seeds an empty workspace with them — so an imported document and a
// hand-written one look like the same artifact.
export const GUIDELINES_HEADINGS = [
  "Voice and tone",
  "Do",
  "Don't",
  "How we structure updates",
  "Words and phrases we use",
] as const;

/**
 * Seeded into the editor when a workspace has no guidelines yet, so people edit
 * rather than face a blank page. Deliberately not written to the database on
 * load — the column stays null until the user saves, which is what lets the
 * prompt builders tell "never configured" apart from "configured".
 */
export const GUIDELINES_TEMPLATE = `## Voice and tone

How should updates sound? Formal or casual, playful or plain.

## Do

- Things every update should do.

## Don't

- Things updates should never do.

## How we structure updates

Typical length, sections, and how an update opens and closes.

## Words and phrases we use

Vocabulary that sounds like us, and terms to avoid.
`;
```

- [ ] **Step 4: Run the template test to verify it passes**

```bash
npx vitest run tests/lib/workspace/guidelines-template.test.ts
```

Expected: PASS, three tests.

- [ ] **Step 5: Write the failing tests for the analyzer**

In `tests/lib/workspace/analyze-brand-style.test.ts`, replace line 33 with:

```ts
    const derived = { guidelines: "## Voice and tone\n\nFriendly and plain.", industry: "SaaS" };
```

and replace the assertion object at lines 52–54 with:

```ts
    expect(await analyzeBrandStyle("text", tenantId)).toEqual({ guidelines: null, industry: null });
```

- [ ] **Step 6: Write the failing tests for the importer**

In `tests/lib/workspace/brand-import.test.ts`, replace the first test's `analyze` stub and assertions (lines 19–32) with:

```ts
      analyze: async () => ({
        guidelines: "## Voice and tone\n\nFriendly and plain.\n\n## Don't\n\n- No hype.",
        industry: "SaaS",
      }),
    });

    expect(result.ok).toBe(true);
    const [profile] = await db.select().from(brandProfiles).where(eq(brandProfiles.tenantId, tenant.id));
    expect(profile.guidelines).toBe("## Voice and tone\n\nFriendly and plain.\n\n## Don't\n\n- No hype.");
    expect(profile.industry).toBe("SaaS");
    expect(profile.updatesPageUrl).toBe("https://acme.com/changelog");
```

and in the second test replace the `analyze` stub at lines 40–42 with:

```ts
      analyze: async () => ({ guidelines: null, industry: null }),
```

- [ ] **Step 7: Run both to verify they fail**

```bash
npx vitest run tests/lib/workspace/analyze-brand-style.test.ts tests/lib/workspace/brand-import.test.ts
```

Expected: FAIL — typecheck rejects the two-field `analyze` stub against the six-field `DerivedBrandProfile`, and `profile.guidelines` is null.

- [ ] **Step 8: Rewrite the analyzer**

Replace `src/lib/workspace/analyze-brand-style.ts` lines 6–36 with:

```ts
import { GUIDELINES_HEADINGS } from "@/lib/workspace/guidelines-template";

export const DerivedBrandProfileSchema = z.object({
  guidelines: z.string().nullable(),
  industry: z.string().nullable(),
});

export type DerivedBrandProfile = z.infer<typeof DerivedBrandProfileSchema>;

const EMPTY: DerivedBrandProfile = { guidelines: null, industry: null };

const ANALYSIS_SYSTEM = [
  "You analyze a company's product updates / changelog page to infer how they communicate product updates,",
  "then write their communication guidelines as a Markdown document a person on their team could edit.",
  `Use exactly these level-2 headings, in this order: ${GUIDELINES_HEADINGS.map((h) => `## ${h}`).join(", ")}.`,
  "Under each, write concrete, actionable guidance in their own terms — short paragraphs under the prose",
  "headings, bullet lists under Do and Don't. Cover voice and register, typical length and structure, how an",
  "update opens and closes, and signature vocabulary they actually use.",
  "Also determine whether updates end with a sign-off / signature and by whom (a person, a role, or a team, e.g.",
  "\"— The Acme Team\" or \"— Jane, Head of Product\"). If they do, add a \"## Sign-off\" section quoting it verbatim;",
  "if updates deliberately never sign off, add a bullet under Don't saying not to add a sign-off. Only assert a",
  "signature when there is clear evidence on the page.",
  "Infer only from evidence on the page. Omit a heading entirely rather than inventing guidance for it, and",
  "return null for guidelines if the page gives you nothing to go on.",
  "Separately, infer the company's industry, or null if you cannot.",
].join(" ");

export function buildAnalysisPrompt(pageText: string): string {
  return `Here is the text of a company's product updates / changelog page. Write their product-update communication guidelines.\n\n${pageText}`;
}
```

Leave `analyzeBrandStyle` itself unchanged — its body already returns `object` and falls back to `EMPTY`.

- [ ] **Step 9: Rewrite the importer's write and empty-check**

In `src/lib/workspace/brand-import.ts`, replace lines 32–53 (the `isEmptyDerivation` block through the `.set({…})` object) with:

```ts
  const isEmptyDerivation = derived.guidelines === null && derived.industry === null;
  if (isEmptyDerivation) return { ok: false, reason: "analysis-empty" };

  const profile = await getOrCreateBrandProfile(tenantId, database);

  await database
    .update(brandProfiles)
    .set({
      guidelines: derived.guidelines,
      industry: derived.industry,
      updatesPageUrl: url,
      updatedAt: new Date(),
    })
```

- [ ] **Step 10: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/workspace/analyze-brand-style.test.ts tests/lib/workspace/brand-import.test.ts tests/lib/workspace/guidelines-template.test.ts
```

Expected: PASS.

- [ ] **Step 11: Verify the whole suite**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/lib/workspace/guidelines-template.ts src/lib/workspace/analyze-brand-style.ts src/lib/workspace/brand-import.ts tests/lib/workspace
git commit -m "feat: derive brand guidelines as markdown from the updates page"
```

---

### Task 4: Extract the markdown editor into a shared component

Mechanical extraction, no behavior change. The draft editor keeps its view-mode bridge, agent-edit bridge and Ask AI button by passing them in.

**Files:**
- Create: `src/components/markdown/mdx-editor.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` (becomes a thin wrapper)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: default export from `src/components/markdown/mdx-editor.tsx`:

```tsx
export default function MdxEditor(props: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  editorRef?: React.RefObject<MDXEditorMethods | null>;
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
  contentEditableClassName?: string;
  placeholder?: React.ReactNode;
}): React.JSX.Element
```

There are no automated tests for this component — MDXEditor is browser-only and the existing draft editor has none either. Verification is typecheck, lint, and a manual check of the draft editor.

- [ ] **Step 1: Create the shared component**

Create `src/components/markdown/mdx-editor.tsx` by moving the generic parts of `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` verbatim. Copy these across **unchanged**, including their comments:

- the `"use client"` directive and the `import "@mdxeditor/editor/style.css"` line
- `CODE_BLOCK_LANGUAGES`
- `type SurfaceMode`
- `findContentEl`
- `clamp`
- `useSelectionSurface`

Do **not** copy `ViewModeBridge`, `AgentEditBridge`, or `AskAiSelectionButton` — those stay in the drafts file.

The import list narrows to what the shared file actually uses:

```tsx
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  imagePlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  diffSourcePlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  InsertCodeBlock,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import { useRef, useState } from "react";
```

`EditorSurfaces` becomes:

```tsx
function EditorSurfaces({
  realmChildren,
  selectionExtras,
}: {
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { mode, pos, selectionSurfaceRef, insertSurfaceRef } = useSelectionSurface(hostRef);

  // Keep the DOM selection intact when pressing a surface button. Without
  // this, mousedown's default action can move focus/selection out of
  // `.mdx-content` before the click completes, which fires `selectionchange`
  // and hides the surface mid-click -- swallowing the click.
  const preserveSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      {/* Consumer-supplied bridges. They live HERE, inside toolbarContents,
          because that is the only subtree rendered inside the MDXEditor realm
          -- useCellValue/usePublisher throw outside it. */}
      {realmChildren}

      {/* Anchor: not visible itself; gives the hook an offsetParent to measure against. */}
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
        {selectionExtras}
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
```

And the default export:

```tsx
export default function MdxEditor({
  markdown,
  onChange,
  editorRef,
  realmChildren,
  selectionExtras,
  contentEditableClassName = "mdx-content min-h-[65vh]",
  placeholder = <span className="text-muted-foreground/40">Update body</span>,
}: {
  markdown: string;
  // The second arg is true when the editor is normalizing the initial markdown
  // on mount rather than reacting to a user edit.
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  // Consumers that need imperative access (the drafts editor's Ask AI flow)
  // own the ref and pass it in, because they also build `realmChildren`, which
  // is constructed outside this component. Everyone else gets the internal one.
  editorRef?: React.RefObject<MDXEditorMethods | null>;
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
  contentEditableClassName?: string;
  placeholder?: React.ReactNode;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  const internalRef = useRef<MDXEditorMethods>(null);
  const ref = editorRef ?? internalRef;

  return (
    <div className="w-full space-y-2">
      {parseError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
          This content&apos;s Markdown couldn&apos;t be fully rendered ({parseError}). Switch to Source mode
          to view and edit the raw Markdown safely.
        </p>
      )}
      <MDXEditor
        ref={ref}
        markdown={markdown}
        onChange={onChange}
        onError={({ error, source }) => {
          // Never fail silently: a parse error previously left the editor
          // blank, which then submitted an empty body on save. Surface it.
          console.error("MDXEditor markdown parse error:", error, source);
          setParseError(error);
        }}
        className="w-full"
        contentEditableClassName={contentEditableClassName}
        // Styled node rather than a bare string so it matches the title's
        // placeholder regardless of the editor's own default styling.
        placeholder={placeholder}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          tablePlugin(),
          imagePlugin(),
          codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
          codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
          diffSourcePlugin({ viewMode: "rich-text" }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarClassName: "mdx-toolbar-host",
            toolbarContents: () => (
              <EditorSurfaces realmChildren={realmChildren} selectionExtras={selectionExtras} />
            ),
          }),
        ]}
      />
    </div>
  );
}
```

Note the parse-error copy changed from "This draft's Markdown" to "This content's Markdown" and dropped the drafts-specific "(the Source button in the action row)" pointer, since the component is no longer drafts-only.

- [ ] **Step 2: Reduce the drafts editor to a wrapper**

Replace the entire contents of `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` with the drafts-only pieces plus the wrapper. Keep `ViewModeBridge`, `AgentEditBridge` and `AskAiSelectionButton` **exactly as they are today** — copy their bodies and comments verbatim from the current file:

```tsx
"use client";

import { useEffect, useRef } from "react";
import {
  viewMode$,
  activeEditor$,
  usePublisher,
  useCellValue,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import { Sparkles } from "lucide-react";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  $getRoot,
  $createParagraphNode,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
import { useDraftEditorBridge } from "./draft-editor-context";
import { useAgentEdit, type EditorOps } from "./agent-edit-context";
import SharedMdxEditor from "@/components/markdown/mdx-editor";

// … ViewModeBridge, AgentEditBridge, AskAiSelectionButton copied verbatim
//    from the current file (lines 189–203, 257–335, 340–353) …

export default function MdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
}) {
  // The bridges need this ref, and they're built here rather than inside the
  // shared editor, so ownership of the ref sits here too.
  const editorRef = useRef<MDXEditorMethods>(null);

  return (
    <SharedMdxEditor
      markdown={markdown}
      onChange={onChange}
      editorRef={editorRef}
      realmChildren={
        <>
          <ViewModeBridge />
          <AgentEditBridge editorRef={editorRef} />
        </>
      }
      selectionExtras={<AskAiSelectionButton />}
    />
  );
}
```

`AgentEditBridge`'s existing prop type is `{ editorRef: React.RefObject<MDXEditorMethods | null> }`, which `useRef<MDXEditorMethods>(null)` satisfies — no change needed there.

`DraftBodyEditor` still does `dynamic(() => import("./mdx-editor"), { ssr: false })`, so the shared component stays inside the lazily-loaded chunk. Do not change that import.

- [ ] **Step 3: Verify types and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both pass with no errors.

- [ ] **Step 4: Verify the draft editor still works**

```bash
npm test
```

Expected: PASS (no test covers this component; this confirms nothing else regressed).

Then start the dev server and open any draft at `/drafts/<id>`. Confirm, by hand: the toolbar appears on text selection with bold/italic/block-type/list/link plus the Sparkles button; the Source toggle in the action row still switches view mode; Ask AI on a selection still applies an edit. Per `preview-behind-oauth-wall`, dashboard pages sit behind Google/GitHub login, so this check needs a logged-in browser session — if that isn't available, say so in the task report rather than claiming it was verified.

- [ ] **Step 5: Commit**

```bash
git add src/components/markdown/mdx-editor.tsx "src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx"
git commit -m "refactor: extract the markdown editor into a shared component"
```

---

### Task 5: Brand guidelines page

Creates the page, moves the brand controls out of Settings, and adds the nav entry.

**Files:**
- Create: `src/app/(dashboard)/brand-guidelines/page.tsx`
- Create: `src/app/(dashboard)/brand-guidelines/actions.ts`
- Create: `src/app/(dashboard)/brand-guidelines/guidelines-editor.tsx`
- Move: `src/app/(dashboard)/settings/industry-select.tsx` → `src/app/(dashboard)/brand-guidelines/industry-select.tsx`
- Move: `src/app/(dashboard)/settings/personas-editor.tsx` → `src/app/(dashboard)/brand-guidelines/personas-editor.tsx`
- Move: `src/app/(dashboard)/settings/brand-style-import.tsx` → `src/app/(dashboard)/brand-guidelines/brand-style-import.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (drop the Brand profile card and its imports)
- Modify: `src/app/(dashboard)/settings/actions.ts` (remove `saveBrandProfile`, `importBrandStyleFromUrl`, `splitList`)
- Modify: `src/app/(dashboard)/nav-links.tsx:9-15`
- Modify: `src/app/onboarding/brand/page.tsx:21,46` (copy that points at Settings)

**Interfaces:**
- Consumes: `GUIDELINES_TEMPLATE` (Task 3), the shared `MdxEditor` default export (Task 4), `brandProfiles.guidelines` (Task 1).
- Produces: server actions `saveBrandProfile(formData: FormData): Promise<void>` and `importBrandStyleFromUrl(url: string): Promise<{ ok: boolean; reason?: string }>` in `brand-guidelines/actions.ts`.

- [ ] **Step 1: Move the three client components**

```bash
git mv "src/app/(dashboard)/settings/industry-select.tsx" "src/app/(dashboard)/brand-guidelines/industry-select.tsx"
git mv "src/app/(dashboard)/settings/personas-editor.tsx" "src/app/(dashboard)/brand-guidelines/personas-editor.tsx"
git mv "src/app/(dashboard)/settings/brand-style-import.tsx" "src/app/(dashboard)/brand-guidelines/brand-style-import.tsx"
```

(`git mv` fails if the target directory doesn't exist — `mkdir -p "src/app/(dashboard)/brand-guidelines"` first.)

`industry-select.tsx` and `personas-editor.tsx` import only from `@/components/ui/*`, `@/lib/utils` and `@/db/schema`, so they need no edits. In `brand-style-import.tsx`, the action import `from "./actions"` now resolves to the new `brand-guidelines/actions.ts` — correct, no edit needed — and update the confirm dialog copy at lines 88–90 to:

```tsx
              This replaces your brand guidelines and industry with what we derive from the page.
```

and the panel description at lines 63–66 to:

```tsx
        Paste your changelog or &ldquo;what&apos;s new&rdquo; URL and we&apos;ll write your guidelines from it.
        This overwrites your current guidelines.
```

- [ ] **Step 2: Create the actions file**

Create `src/app/(dashboard)/brand-guidelines/actions.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { brandProfiles } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { importBrandStyleForTenant } from "@/lib/workspace/brand-import";
import { parsePersonas } from "@/lib/workspace/persona-form";

export async function saveBrandProfile(formData: FormData) {
  const session = await requireSession();
  const profile = await getOrCreateBrandProfile(session.user.tenantId);

  await db
    .update(brandProfiles)
    .set({
      guidelines: (formData.get("guidelines") as string)?.trim() || null,
      industry: (formData.get("industry") as string) || null,
      userPersonas: parsePersonas(formData),
      updatedAt: new Date(),
    })
    .where(eq(brandProfiles.id, profile.id));

  revalidatePath("/brand-guidelines");
}

/**
 * Re-derives the brand guidelines from a public updates page (the same
 * extraction used in onboarding) and overwrites them. Called from the import
 * panel, which confirms first since this replaces hand-written guidelines.
 * Returns the outcome so the client can show inline feedback.
 */
export async function importBrandStyleFromUrl(url: string): Promise<{ ok: boolean; reason?: string }> {
  const session = await requireSession();
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const result = await importBrandStyleForTenant(session.user.tenantId, trimmed);
  if (result.ok) revalidatePath("/brand-guidelines");
  return result;
}
```

- [ ] **Step 3: Create the editor client component**

Create `src/app/(dashboard)/brand-guidelines/guidelines-editor.tsx`. It mirrors `DraftBodyEditor`'s dirty-tracking and hidden-input pattern, but seeds the starter template when there is nothing stored:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "../unsaved-changes";
import { GUIDELINES_TEMPLATE } from "@/lib/workspace/guidelines-template";

const MdxEditor = dynamic(() => import("@/components/markdown/mdx-editor"), { ssr: false });

export function GuidelinesEditor({ defaultValue }: { defaultValue: string | null }) {
  // A workspace with nothing stored edits the template rather than a blank
  // page. Nothing is written until they save, so the column stays null and the
  // prompt builders can still tell "never configured" from "configured".
  const initial = defaultValue ?? GUIDELINES_TEMPLATE;
  const [guidelines, setGuidelines] = useState(initial);
  const { setSectionDirty, cleanToken } = useUnsavedChanges();
  const baseline = useRef(initial);
  const latest = useRef(initial);

  // Re-baseline once edits are committed, so a later revert is measured against
  // what was saved rather than what was originally loaded.
  useEffect(() => {
    baseline.current = latest.current;
  }, [cleanToken]);

  // Clear this field's flag when the page unmounts, so navigating away can't
  // leave a stale warning armed on another page.
  useEffect(() => () => setSectionDirty("guidelines", false), [setSectionDirty]);

  return (
    <div className="w-full">
      <input type="hidden" name="guidelines" value={guidelines} />
      <MdxEditor
        markdown={guidelines}
        contentEditableClassName="mdx-content min-h-[50vh]"
        placeholder={<span className="text-muted-foreground/40">Brand guidelines</span>}
        onChange={(md, initialMarkdownNormalize) => {
          setGuidelines(md);
          latest.current = md;

          // On mount the editor rewrites the stored markdown into its own
          // dialect (bullet characters, escaping, whitespace). That isn't a user
          // edit — it's the resting state — so it becomes the baseline instead
          // of counting as a change.
          if (initialMarkdownNormalize) {
            baseline.current = md;
            setSectionDirty("guidelines", false);
            return;
          }

          setSectionDirty("guidelines", md !== baseline.current);
        }}
      />
    </div>
  );
}
```

- [ ] **Step 4: Create the page**

Create `src/app/(dashboard)/brand-guidelines/page.tsx`:

```tsx
import { db } from "@/db";
import { systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { saveBrandProfile } from "./actions";
import { BrandStyleImport } from "./brand-style-import";
import { IndustrySelect } from "./industry-select";
import { PersonasEditor } from "./personas-editor";
import { GuidelinesEditor } from "./guidelines-editor";
import { ToastForm } from "../settings/toast-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default async function BrandGuidelinesPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const personaCatalog = await db
    .select({
      key: systemPersonas.key,
      name: systemPersonas.name,
      description: systemPersonas.description,
    })
    .from(systemPersonas)
    .orderBy(systemPersonas.sortOrder);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Brand guidelines</h1>
        <p className="text-sm text-muted-foreground">
          How your product updates should be written. Every draft is generated and reviewed against this.
        </p>
      </div>

      <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />

      <ToastForm action={saveBrandProfile} successMessage="Brand guidelines saved" className="space-y-6">
        <div className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Industry</Label>
            <IndustrySelect defaultValue={brandProfile.industry ?? ""} />
          </div>
          <div className="space-y-2">
            <Label>User personas</Label>
            <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
          </div>
        </div>

        <GuidelinesEditor defaultValue={brandProfile.guidelines} />

        <Button type="submit" variant="outline">
          Save
        </Button>
      </ToastForm>
    </div>
  );
}
```

The import panel sits outside the `ToastForm` on purpose: it is its own client component with its own async action, and nesting it would submit the form when its button is pressed.

- [ ] **Step 5: Add the nav entry**

In `src/app/(dashboard)/nav-links.tsx`, add to the end of `NAV` (after the Integrations entry):

```ts
  { href: "/brand-guidelines", label: "Brand guidelines" },
```

- [ ] **Step 6: Strip the brand card out of Settings**

In `src/app/(dashboard)/settings/page.tsx`:
- Delete the entire `<Card>` block for "Brand profile" (lines 64–120).
- Delete these now-unused imports: `systemPersonas` (from the `@/db/schema` import), `getOrCreateBrandProfile`, `saveBrandProfile`, `PersonasEditor`, `BrandStyleImport`, `IndustrySelect`, `Textarea`, `Label`.
- Delete the `brandProfile` and `personaCatalog` queries (lines 25 and 31–38).

Keep `Input`, `Button`, `Card*`, `ToastForm`, `MembersSection`, `ScheduleForm`, `saveWorkspaceName`, and the `tenants` / `scheduleConfigs` queries.

In `src/app/(dashboard)/settings/actions.ts`, delete `splitList` (lines 19–27), `saveBrandProfile` (lines 91–109) and `importBrandStyleFromUrl` (lines 111–125), then remove the imports that only they used: `brandProfiles`, `getOrCreateBrandProfile`, `importBrandStyleForTenant`, `parsePersonas`.

- [ ] **Step 7: Fix the onboarding copy that points at Settings**

Onboarding's brand step still tells people to refine their brand style in Settings, which is no longer where it lives. In `src/app/onboarding/brand/page.tsx`, change the `description` at line 21 to:

```tsx
        description="Paste your existing changelog or “what’s new” page and we’ll learn how you write. Refine it anytime under Brand guidelines."
```

and the failure hint at line 46 to:

```tsx
              We couldn&apos;t read that page. Try another URL, or skip and write your guidelines under Brand
              guidelines.
```

Leave the curly quotes in the description exactly as they are — they're intentional typography, and the surrounding copy uses them consistently.

No other onboarding change is needed: `src/app/onboarding/actions.ts` reaches the brand profile only through `importBrandStyleForTenant`, which Task 3 already updated. The other two "in Settings" strings (`schedule/page.tsx:17`, `workspace/page.tsx:25`) are still accurate — schedule and workspace name stay in Settings.

- [ ] **Step 8: Verify types, lint, and tests**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass. If typecheck reports an unused import in `settings/page.tsx` or `settings/actions.ts`, remove it — the list above should be complete, but verify rather than assume.

- [ ] **Step 9: Manually verify the page**

Start the dev server and visit `/brand-guidelines`. Confirm: the nav highlights "Brand guidelines" as the last item; a workspace with no guidelines shows the five template headings in the editor; editing then navigating away triggers the unsaved-changes dialog; Save shows the "Brand guidelines saved" toast and the text survives a reload; Settings no longer shows a Brand profile card. Same OAuth caveat as Task 4 — if you can't log in, report that instead of claiming verification.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(dashboard)/brand-guidelines" "src/app/(dashboard)/settings" "src/app/(dashboard)/nav-links.tsx" src/app/onboarding/brand/page.tsx
git commit -m "feat: add the Brand guidelines page and move brand settings into it"
```

---

### Task 6: Drop the six legacy columns

Nothing reads or writes them by now. This removes them from the schema and cleans the stale fixtures that still name them.

**Files:**
- Modify: `src/db/schema.ts` (remove six columns from `brandProfiles`)
- Create: `src/db/migrations/00XX_*.sql` (generated)
- Test: `tests/lib/workspace/brand-profile-columns.test.ts`
- Test: `tests/lib/ai/generation.test.ts:22-30`
- Test: `tests/lib/ai/edit.test.ts:16`
- Test: `tests/lib/ai/compose-edit-prompts.test.ts:8-19`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `typeof brandProfiles.$inferSelect` narrowed to `{ id, tenantId, guidelines, industry, updatesPageUrl, userPersonas, createdAt, updatedAt }`.

`tests/lib/scheduling/run-schedule.test.ts` and `tests/lib/ai/edit-release.test.ts` reference `brandProfiles` but never the dropped fields (verified: `run-schedule.test.ts:133` inserts only `tenantId`, `industry`, `userPersonas`; `edit-release.test.ts:29` only deletes rows). They need no changes.

- [ ] **Step 1: Update the fixtures that still name dropped fields**

In `tests/lib/workspace/brand-profile-columns.test.ts`, remove the two `updatesStyleSummary` assertions from the first test and drop it from the `.set({…})` call, leaving:

```ts
  it("defaults the new columns to null and round-trips values", async () => {
    const [tenant] = await db.insert(tenants).values({ name: NAME }).returning();

    const [defaulted] = await db.insert(brandProfiles).values({ tenantId: tenant.id }).returning();
    expect(defaulted.updatesPageUrl).toBeNull();

    const [updated] = await db
      .update(brandProfiles)
      .set({ updatesPageUrl: "https://acme.com/changelog" })
      .where(eq(brandProfiles.id, defaulted.id))
      .returning();
    expect(updated.updatesPageUrl).toBe("https://acme.com/changelog");
  });
```

In `tests/lib/ai/generation.test.ts`, replace the `brandProfile` fixture at lines 22–30 with:

```ts
    const brandProfile = {
      tenantId: "tenant_1",
      guidelines: "## Voice and tone\n\nFriendly and plain.\n\n## Do\n\n- Be concise.",
      industry: "B2B SaaS",
      userPersonas: [],
    } as never;
```

No other change is needed in that file — its assertions (lines 40–45) only check `Industry: B2B SaaS.`, the persona line, and the prompt body. None of them reference the dropped style fields.

In `tests/lib/ai/edit.test.ts`, replace line 16 with:

```ts
const brandProfile = { tenantId: "t1", guidelines: null, industry: null, userPersonas: [] } as unknown as BrandProfileRow;
```

In `tests/lib/ai/compose-edit-prompts.test.ts`, replace the fixture at lines 8–19 with:

```ts
// Minimal brand profile — buildSystemPrompt only reads these fields.
const brandProfile = {
  tenantId: "tenant-1",
  guidelines: null,
  industry: null,
  userPersonas: [],
} as unknown as BrandProfileRow;
```

- [ ] **Step 2: Run the suite to confirm it is green before the schema change**

```bash
npm test
```

Expected: PASS. These fixture edits are behaviour-neutral — the fields were already unread.

- [ ] **Step 3: Remove the columns from the schema**

In `src/db/schema.ts`, delete these six lines from `brandProfiles`:

```ts
  tone: text("tone"),
  readingLevel: text("reading_level"),
  doList: text("do_list").array().notNull().default([]),
  dontList: text("dont_list").array().notNull().default([]),
  examplePhrases: text("example_phrases").array().notNull().default([]),
  updatesStyleSummary: text("updates_style_summary"),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate && npm run db:migrate && npm run db:migrate:test
```

Confirm the generated SQL contains exactly six `ALTER TABLE "brand_profiles" DROP COLUMN …` statements and **no** `UPDATE` or `INSERT`. If drizzle-kit prompts about a column rename (it sometimes guesses one when columns are added and dropped across migrations), answer that these are drops, not renames.

- [ ] **Step 5: Verify everything**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all pass. A failure here naming one of the six columns means a reader was missed in Tasks 2–5 — fix that reader rather than restoring the column.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests
git commit -m "feat: drop the legacy brand style columns"
```

---

## Deployment note

The Vercel build runs migrations (`chore: run migrations in build`). Tasks 1 and 6 each add one. Deploying the branch as a unit applies both in order: add `guidelines`, then drop the six. There is no intermediate state a running deployment observes, because the code that stops reading the old columns ships in the same push.

Per `versional-vercel-deployment`, the repo-local git author email and the `framework: "nextjs"` setting in `vercel.ts` are load-bearing — do not change either while working on this.
