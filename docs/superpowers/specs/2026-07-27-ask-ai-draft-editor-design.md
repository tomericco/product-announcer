# Ask AI edits in the draft editor

**Date:** 2026-07-27
**Status:** Approved design, pending implementation plan

## Goal

Let a user ask the composer agent for changes to a product-update draft from inside
the draft editor, in two forms:

1. **Highlighted-text edit** — select text, open a modal, type an instruction; the
   agent revises **only** the selected span and the change is spliced back in place.
2. **Whole-update edit** — a button in the editor action row opens the same modal;
   the instruction is applied across the whole body.

Both show a compose-style loader while the agent works, then apply the result and
**auto-save** it.

## Scope

- Operates on the **body only**. The title field is untouched.
- Reuses the existing single-call generation shape (`generateObject`), not token
  streaming — consistent with how the initial draft is composed.
- No new persistence model: the result is applied to the editor and saved through
  the existing draft-save path.

## Entry points (both open one shared modal)

### 1. Selection popover button

Add an **Ask AI** button (sparkles icon) to the existing selection toolbox in
`src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — the `.mdx-surface-selection`
floating surface rendered by `EditorSurfaces`, which already shows on text highlight
next to Bold/Italic/BlockType/Lists/Link. The button lives inside the Lexical
`toolbarContents` realm, so it can read the current selection.

On click it: captures the current selection's plain text, opens the shared modal in
`selection` mode. `onMouseDown → preventDefault` (the existing `preserveSelection`
pattern) keeps the DOM/Lexical selection alive through the click.

### 2. Action-row button

Add an **Ask AI** button in `src/app/(dashboard)/drafts/[releaseId]/page.tsx`'s action
row, immediately after `<SaveChangesButton />` in the left cluster (not in the
`ml-auto` Publish group):

```tsx
<RejectButton />
<SaveChangesButton />
<AskAiButton />                {/* whole-update edit */}
<div className="ml-auto"><PublishDialog targets={publishTargets} /></div>
```

It opens the shared modal in `whole` mode. Being outside the editor realm, it drives
the editor through the context bridge (below).

## The modal — `agent-edit-dialog.tsx`

Rendered once at page level, driven by context state so both entry points share it.

- Shows what is being edited: "Editing the selected text" (selection mode, with the
  excerpt shown/quoted) or "Editing the whole update" (whole mode).
- A prompt `textarea` for the instruction + a submit button. Submit disabled when empty.
- **Loader:** on submit the modal body swaps to a compose-style loading state — the
  same `Loader2` spinner + muted label treatment used by `DraftReleaseDialog`'s active
  step (e.g. "Rewriting your update…"). This is a single-step spinner, **not** the
  5-step checklist (which is tied to the multi-item batch flow). The modal is
  non-dismissible while pending.
- On success: apply to the editor, auto-save, toast, close.
- On failure: toast the error, return to the prompt state so the user can retry.
  Nothing is persisted.

## Server side

### Prompt builders — `src/lib/ai/compose-prompt.ts`

Both reuse `buildSystemPrompt(brandProfile, personas, examples)` so edits stay on
brand (tone, personas, do/don't, example phrases).

- `composeScopedEditPrompt({ fullBody, excerpt, instruction, brandProfile, personas, examples })`
  — full body as read-only context + the highlighted excerpt + the instruction.
  Instructs: revise **only** this excerpt, return just the revised excerpt in the same
  markdown format, no surrounding text or commentary.
- `composeWholeEditPrompt({ currentBody, instruction, brandProfile, personas, examples })`
  — full body + the instruction. Instructs: apply the instruction across the update
  and return the full revised body (markdown). This is close to the existing
  `composeMergePrompt` "revise, don't rewrite" shape.

Both truncate an over-long body with the existing `DEFAULT_MAX_PROMPT_CHARS` guard.

### Generator — `src/lib/ai/edit.ts` (new)

`editReleaseBody(args)` mirrors `generateReleaseDraft` in `generation.ts`:

- One `generateObject` call with schema `z.object({ text: z.string() })`.
- Model from `GENERATION_MODEL` (default `anthropic/claude-sonnet-4-5`).
- `recordLlmUsage({ tenantId, operation: "generation", model, usage })`.
- Trims stray wrapping (surrounding quotes / ``` fences) from `text` before returning.

### Server action — `requestAgentEdit` in `drafts/[releaseId]/actions.ts`

- Input: `{ releaseId, mode: "selection" | "whole", instruction, fullBody, excerpt? }`.
  `fullBody` comes from the **live editor** (so unsaved edits are respected), not the
  DB row.
- Tenant-ownership check on `releaseId` (same guard `catchUp`/`startOver` use).
- Loads brand profile, resolved personas, and examples for the release's tenant.
- Calls `editReleaseBody`, returns `{ text }`. **No DB write here** — persistence
  happens after the client applies the change (see below), because for the surgical
  case the final body only exists after the client-side splice.

## Client apply + auto-save

### Bridge — extend `draft-editor-context.tsx`

Extend the existing `EditorBridge` (currently just `viewMode`/`setViewMode`) with the
imperative ops the modal needs, registered by a realm component inside the editor:

- `getSelectionText(): string | null`
- `getMarkdown(): string`
- `replaceSelection(md: string): void` — surgical, selection mode
- `setBody(md: string): void` — whole mode

The provider also holds the shared modal state (`open`, `mode`, `excerpt`) plus
`openAgentEdit(mode, excerpt?)` / `closeAgentEdit`, so both entry points and the modal
coordinate through one context.

### Applying the result

- **Selection mode (surgical):** replace the live selection using MDXEditor's Lexical
  markdown insert. **Verify against `node_modules/@mdxeditor/editor` first** whether the
  Lexical selection survives the modal stealing focus:
  - If it does (Lexical typically retains its `RangeSelection` across blur), a ref-level
    `insertMarkdown(replacement)` over the retained selection suffices.
  - If not, capture the `RangeSelection` (clone) in the realm bridge at button-click
    time and restore it (`editor.update(() => $setSelection(saved))`) before inserting.
  - Fallback: if markdown-over-selection isn't exposed, insert the replacement as plain
    text via the selection.
- **Whole mode:** `editorRef.setMarkdown(newBody)`.

Either apply triggers the editor's `onChange`, updating `DraftBodyEditor`'s `body`
state and the hidden form input.

### Auto-save

After applying, read the authoritative markdown via `getMarkdown()` (avoids any
stale-hidden-input race), persist it through the existing draft-save path — reuse
`saveDraft`, or add a thin `saveDraftBody({ releaseId, body })` action if `saveDraft`
requires the full form (title/publishedAt) — then mark the body section clean in
`useUnsavedChanges` and toast success.

## Files

**New**
- `src/lib/ai/edit.ts` — `editReleaseBody`
- `src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog.tsx` — shared modal
- `src/app/(dashboard)/drafts/[releaseId]/ask-ai-button.tsx` — action-row (whole) button

**Edited**
- `src/lib/ai/compose-prompt.ts` — `composeScopedEditPrompt`, `composeWholeEditPrompt`
- `src/app/(dashboard)/drafts/[releaseId]/actions.ts` — `requestAgentEdit` (+ optional `saveDraftBody`)
- `src/app/(dashboard)/drafts/[releaseId]/draft-editor-context.tsx` — bridge ops + modal state
- `src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` — Ask AI button in selection surface + register bridge ops
- `src/app/(dashboard)/drafts/[releaseId]/page.tsx` — mount modal + place action-row button

## Risks / open verification

- **Surgical selection replace** is the one genuinely tricky part: whether the Lexical
  selection persists across the modal, and the exact MDXEditor insert API. Verify in
  `node_modules` before implementing; plain-text insert is the safety-net fallback.
- **Auto-save reconciliation:** applying an edit marks the body dirty; after a
  successful save the body section must be re-marked clean so the unsaved-changes guard
  doesn't fire on navigation.
- Agent output hygiene: strip wrapping quotes/fences so a surgical replacement doesn't
  inject stray markdown.

## Non-goals

- Editing the title via the agent.
- Token-streaming the edit (kept consistent with the blocking initial compose).
- A diff/preview-before-apply step (result is applied and auto-saved directly).
