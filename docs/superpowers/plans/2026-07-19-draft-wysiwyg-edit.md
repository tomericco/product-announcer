# WYSIWYG Draft Editing + Category Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the draft detail page into an in-line WYSIWYG editing experience with a large full-width editor and correct list rendering, drop the redundant Preview button, and remove the Category field everywhere (UI, publishing, generation, DB column).

**Architecture:** Swap the Markdown-source editor for `@mdxeditor/editor` (WYSIWYG, still Markdown under the hood); relocate the Approve action off the removed Preview dialog; then remove `category` end-to-end with a DB migration.

**Tech Stack:** Next.js (App Router, server actions, `next/dynamic`), Drizzle + Postgres, `@mdxeditor/editor`, Vitest.

## Global Constraints

- Patched Next.js: verify `next/dynamic` with `{ ssr: false }` and a CSS `import` inside a client module against `node_modules/next/dist/docs/` before wiring the editor.
- The DB migration must be applied to BOTH databases: `npm run db:migrate` (dev) and `npm run db:migrate:test` (vitest test DB).
- `updateCategoryEnum` must NOT be dropped — it's still used by `change_items.suggested_category` and `system_update_examples.category`.
- Body stays Markdown in storage and the webhook payload. The editor is full **column** width (`w-full`), NOT broken out of `max-w-4xl`.
- Keep the explicit "Save changes" button (no autosave).

---

### Task 1: WYSIWYG editor (@mdxeditor) + list CSS + full-width

**Files:**
- Install: `@mdxeditor/editor`
- Create: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx`
- Modify: `src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: `DraftBodyEditor({ defaultValue })` unchanged in signature — still renders a hidden `<input name="body">` carrying the current Markdown. Internally now uses `@mdxeditor/editor`.

- [ ] **Step 1: Verify the patched-Next dynamic-import/CSS pattern**

Read the relevant guide under `node_modules/next/dist/docs/` for `next/dynamic` with `ssr: false` and importing CSS from a client component. Confirm the current `draft-body-editor.tsx` pattern (dynamic import, `ssr:false`) is still valid; note any deviation before writing.

- [ ] **Step 2: Install the editor**

Run: `npm i @mdxeditor/editor`
Expected: added to dependencies, no peer-dep errors that block install.

- [ ] **Step 3: Create the client editor wrapper**

Create `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx` (default export so it can be `dynamic`-imported):

```tsx
"use client";

import "@mdxeditor/editor/style.css";
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
} from "@mdxeditor/editor";

export default function MdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (md: string) => void;
}) {
  return (
    <MDXEditor
      markdown={markdown}
      onChange={onChange}
      className="w-full rounded-lg border border-border"
      contentEditableClassName="mdx-content min-h-[65vh]"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <>
              <UndoRedo />
              <BoldItalicUnderlineToggles />
              <ListsToggle />
              <BlockTypeSelect />
              <CreateLink />
            </>
          ),
        }),
      ]}
    />
  );
}
```

(If any named export above doesn't exist in the installed `@mdxeditor/editor` version, check the package's exports and use the correct name — the toolbar component names are the most likely to vary. Report any substitution.)

- [ ] **Step 4: Rewrite DraftBodyEditor to use it**

Replace the entire contents of `src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx` with:

```tsx
"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

const MdxEditor = dynamic(() => import("./mdx-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  return (
    <div className="w-full">
      <input type="hidden" name="body" value={body} />
      <MdxEditor markdown={body} onChange={setBody} />
    </div>
  );
}
```

(The old `@uiw/react-md-editor` import + CSS are gone from this file.)

- [ ] **Step 5: Restore list styling (bullet fix)**

Append to `src/app/globals.css` a scoped rule so lists render inside the editor (Tailwind preflight resets `ul/ol`):

```css
.mdx-content ul {
  list-style: disc;
  padding-left: 1.5rem;
}
.mdx-content ol {
  list-style: decimal;
  padding-left: 1.5rem;
}
.mdx-content li {
  margin: 0.25rem 0;
}
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass (no test touches this component).

- [ ] **Step 7: Manual smoke (deferred to controller)**

Interactive: open a draft, confirm the body renders as WYSIWYG (headings/bold/lists via toolbar), bullets are visible, the editor is full-width and tall, and Save persists edits. A subagent should statically confirm the wiring (hidden `body` input tracks the editor value) and note that interactive smoke is deferred.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json "src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx" "src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx" src/app/globals.css
git commit -m "feat: WYSIWYG draft body editor (@mdxeditor) with visible lists, full-width"
```

---

### Task 2: Remove the Preview button; relocate Approve & publish

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`
- Delete: `src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx`

**Interfaces:**
- Consumes: `approveDraft`, `rejectDraft` server actions (unchanged).

- [ ] **Step 1: Replace the Preview dialog with direct Approve + Reject buttons**

In `src/app/(dashboard)/drafts/[updateId]/page.tsx`:

1. Remove the import `import { PreviewDialog } from "./preview-dialog";`.
2. Replace the bottom action row (the `<div className="flex items-center gap-4">` containing `<PreviewDialog ... />` and the reject `<form>`) with:

```tsx
      <div className="flex items-center gap-4">
        <form action={approveDraft}>
          <input type="hidden" name="updateId" value={update.id} />
          <Button type="submit">Approve &amp; publish</Button>
        </form>
        <form action={rejectDraft}>
          <input type="hidden" name="updateId" value={update.id} />
          <Button type="submit" variant="ghost" className="text-muted-foreground">
            Reject
          </Button>
        </form>
      </div>
```

(`approveDraft` and `rejectDraft` are already imported from `../actions`.)

- [ ] **Step 2: Delete the preview dialog file**

```bash
rm "src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx"
```

- [ ] **Step 3: Confirm nothing else imports it**

Run: `grep -rn "preview-dialog\|PreviewDialog" src`
Expected: no results.

- [ ] **Step 4: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: drop the draft Preview dialog; approve/reject inline"
```

---

### Task 3: Remove Category everywhere + migration

**Files:**
- Modify: `src/db/schema.ts` (drop `updates.category`; KEEP `updateCategoryEnum`)
- Create (generated): `src/db/migrations/*`
- Modify: `src/lib/ai/generation.ts`, `src/lib/ai/review-draft.ts`, `src/lib/change-items/change-item-batch.ts`, `src/lib/publishing/webhook-delivery.ts`
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`, `src/app/(dashboard)/drafts/actions.ts`, `src/app/(dashboard)/drafts/page.tsx`, `src/app/(dashboard)/history/page.tsx`
- Modify: `tests/lib/change-items/change-item-batch.test.ts`, `tests/lib/scheduling/auto-publish.test.ts`

**Interfaces:**
- Produces: `UpdateDraft` / `DraftInput` become `{ title, body }` (no `category`); the `updates` row and webhook payload have no `category`.

- [ ] **Step 1: Remove category from the generation contract**

In `src/lib/ai/generation.ts`, drop the category line from the schema:

```ts
export const UpdateDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
});
```

In `src/lib/ai/review-draft.ts`, the `reviseDraft` return currently is
`return { title: result.object.title, body: result.object.body, category: draft.category };`
— change to:

```ts
  return { title: result.object.title, body: result.object.body };
```

- [ ] **Step 2: Remove category from the batch insert**

In `src/lib/change-items/change-item-batch.ts`:

- `export type DraftInput = { title: string; body: string; category: "new" | "improved" | "fixed" };`
  → `export type DraftInput = { title: string; body: string };`
- In the `claimBatchAndCreateUpdate` insert `.values({...})`, delete the line
  `category: input.draft.category,`.

- [ ] **Step 3: Remove category from the webhook payload**

In `src/lib/publishing/webhook-delivery.ts`, delete the line `category: update.category,` from `buildPayload`.

- [ ] **Step 4: Remove category from the UI**

- `src/app/(dashboard)/drafts/[updateId]/page.tsx`: remove the entire Category `<div className="space-y-2">…<Select name="category">…</Select></div>` block, and remove the now-unused `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` imports (grep the file to confirm they're unused elsewhere first).
- `src/app/(dashboard)/drafts/actions.ts`: in `saveDraft`, delete the line
  `category: formData.get("category") as "new" | "improved" | "fixed",` from the `.set({...})`.
- `src/app/(dashboard)/drafts/page.tsx`: delete `<Badge variant="secondary">{d.category}</Badge>`. If that leaves the wrapping `<div className="flex items-center gap-2">` with only the review-status badge, leave the div (it still holds the review badge).
- `src/app/(dashboard)/history/page.tsx`: this is a table. Read it and remove the **Category column** — both the `<TableHead>` for Category and the `<TableCell><Badge …>{u.category}</Badge></TableCell>` — so the header/cell counts stay aligned. Remove the now-unused `Badge` import only if nothing else in the file uses it.

- [ ] **Step 5: Drop the DB column**

In `src/db/schema.ts`, in the `updates` table (`export const updates = pgTable("updates", { ... })`), delete the line `category: updateCategoryEnum("category").notNull(),`. Do NOT remove `updateCategoryEnum` (it's still used by `suggestedCategory` and `system_update_examples.category`).

Then:

Run: `npm run db:generate`
Expected: a migration dropping `updates.category` is generated under `src/db/migrations/`.

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both the dev and test databases apply the migration cleanly.

- [ ] **Step 6: Fix test fixtures**

- `tests/lib/change-items/change-item-batch.test.ts`: in each `draft: { title: "T", body: "B", category: "new" }` (4 occurrences), remove `, category: "new"` → `draft: { title: "T", body: "B" }`.
- `tests/lib/scheduling/auto-publish.test.ts`: line ~62, `finalDraft: { title: "Revised title", body: "Revised body", category: "new" }` → remove `, category: "new"`. The mocked `generateObject` return at line ~37 casts `as never`, so its `category` is harmless — leave it or remove it.
- If typecheck (next step) flags any other `UpdateDraft`/`DraftInput` literal with `category`, remove it there too.

- [ ] **Step 7: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean (no remaining `.category` on `updates`/`UpdateDraft`/`DraftInput`); all tests pass against the migrated test DB.

- [ ] **Step 8: Confirm the column is gone end-to-end**

Run: `grep -rn "update\.category\|updates\.category\|input\.draft\.category\|draft\.category\|name=\"category\"" src`
Expected: no results (all update-category references removed). (`suggestedCategory`, `example.category`, `updateCategoryEnum`, `batchCategories` may still appear — those are intentionally kept.)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat!: remove the draft category field (UI, generation, webhook, DB column)"
```

---

## Self-Review Notes

- **Spec coverage:** WYSIWYG editor (Task 1), list CSS (Task 1 Step 5), full-column width (Task 1 Steps 3-4), remove Preview + relocate Approve (Task 2), remove category everywhere incl. generation/webhook/DB/list+history badges/tests (Task 3), keep Save button (unchanged in all tasks). All spec sections mapped.
- **Type consistency:** `UpdateDraft` / `DraftInput` become `{ title, body }` consistently across generation.ts, review-draft.ts, change-item-batch.ts, and their test fixtures; the `updates` row loses `category` in schema, insert, webhook payload, and every UI read (detail Select, list badge, history cell).
- **Ordering:** Task 2 removes PreviewDialog (which reads `update.category`) before Task 3 drops the column, so Task 3's atomic column removal has no stale reference in the preview. Every intermediate state builds. Task 3 is atomic (all category references + column in one commit) because a dropped column/type can't coexist with any remaining reference.
