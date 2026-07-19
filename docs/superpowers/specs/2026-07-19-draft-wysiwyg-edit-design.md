# WYSIWYG draft editing + category removal

## Problem

The draft detail page uses a split Markdown-source editor (`@uiw/react-md-editor`),
a Category dropdown, and a separate **Preview** dialog. Bullets are invisible in the
rendered Markdown (Tailwind preflight resets list styles), editing is source-based
rather than WYSIWYG, and the editor is small.

## Goal

Make draft editing an in-line WYSIWYG experience with a large, full-width editor;
fix list rendering; drop the redundant Preview button; and remove the Category
field everywhere (UI, publishing, generation, and the DB column).

## Design

### 1. WYSIWYG editor (`@mdxeditor/editor`)

Replace the `@uiw/react-md-editor` editor in `DraftBodyEditor` with
`@mdxeditor/editor` — a Markdown-native WYSIWYG (edit rendered content directly;
toolbar for headings, bold/italic, lists, links). It emits Markdown, so the body
is still stored/published as Markdown. `@uiw/react-md-editor` is removed once
nothing imports it.

- Client-only: the `@mdxeditor` component is imported via `dynamic(..., { ssr: false })`
  (same SSR-avoidance as today). Its stylesheet (`@mdxeditor/editor/style.css`) is
  imported in the client editor module.
- The Markdown value feeds the existing hidden `<input name="body">` so the
  server action (`saveDraft`) is unchanged for the body.
- Full **column** width (`w-full`) and tall (≈65vh min-height). It does NOT break
  out of the layout's `max-w-4xl` column.
- Plugins: headings, lists, quote, thematic break, link + link dialog, markdown
  shortcuts, and a toolbar (undo/redo, bold/italic, lists toggle, block-type
  select, create link).

### 2. Bullet / list fix

Tailwind's preflight resets `ul/ol` list styles, hiding bullets. Add a scoped CSS
rule in `src/app/globals.css` restoring `list-style: disc` (ul) / `decimal` (ol)
and left padding within the editor content (the editor's
`contentEditableClassName`). Bump specificity / `!important` only if the reset
still wins. (The old preview window is removed — see §3 — so this is the one
in-app render surface.)

### 3. Remove the Preview button

Delete `PreviewDialog` (file + usage). It currently also hosts **Approve &
publish**, so that action moves to a direct button on the draft page (next to
Reject), submitting `approveDraft` with the `updateId`.

### 4. Remove Category everywhere

The draft's `category` (`new`/`improved`/`fixed`) is removed end to end. (The
`updateCategoryEnum` itself STAYS — it's still used by `change_items.suggestedCategory`
and `systemUpdateExamples.category`, which are unrelated and untouched.)

- **DB migration:** drop the `updates.category` column.
- **Generation:** remove `category` from `UpdateDraftSchema` and the `UpdateDraft`
  type (`generation.ts`) — the LLM no longer classifies.
- **Review:** `reviseDraft` no longer returns `category` (`review-draft.ts`).
- **Batch:** `DraftInput` drops `category`; the `claimBatchAndCreateUpdate` insert
  drops it (`change-item-batch.ts`).
- **Publishing:** the webhook `buildPayload` drops `category` (`webhook-delivery.ts`)
  — an intentional external-contract change.
- **UI:** remove the Category `<Select>` (draft detail page) and the category
  `<Badge>` on the drafts **list** page and the **history** page.
- **Save action:** `saveDraft` no longer reads/writes `category`.
- **Tests:** remove `category` from any `UpdateDraft` / `DraftInput` /
  `ReviewOutcome.finalDraft` literal in the test suite (e.g. `change-item-batch.test.ts`,
  `auto-publish.test.ts`); mocked `generateObject` returns may keep or drop it
  (harmless).

### 5. Save button

Keep the explicit **Save changes** button (no autosave).

## Constraints

- Patched Next.js: verify `next/dynamic` `ssr:false` + a CSS `import` inside a
  client module against `node_modules/next/dist/docs/` before wiring the editor.
- The migration must be applied to **both** databases: `npm run db:migrate` (dev)
  and `npm run db:migrate:test` (the vitest test DB).
- `updateCategoryEnum` must NOT be dropped (still used by other columns).
- Body stays Markdown in storage and the webhook payload; only the editing UI
  changes.

## Out of scope (YAGNI)

- No autosave.
- No change to `change_items.suggestedCategory` or `systemUpdateExamples.category`.
- No redesign of the drafts list / history pages beyond removing the category badge.
