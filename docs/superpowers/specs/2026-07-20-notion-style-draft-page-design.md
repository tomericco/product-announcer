# Notion-style minimal draft editing page

## Problem

The draft page still reads as a form: field labels ("Title", "Body"), a bordered
title input, a bordered editor with a static source-toggle bar above it, a separate
"Edit draft" page heading, and `border-t` dividers above the action rows. The user
wants the page to feel like editing a Notion page — a large title, body text, and
almost no visible chrome.

## Goal

Strip the page to title + body with no static borders, labels, or toolboxes, while
preserving every existing behavior (form wiring, floating toolbars, source mode,
parse safety).

## Design

### 1. Title as an H1

Replace the `Label` + bordered `Input` with a borderless field styled like a page
title: large (~`text-4xl`), bold, tight tracking, `Untitled` placeholder, no border
or background, only a faint focus treatment. `name="title"` is preserved.

A single-line `<input>` is used (not an auto-growing `<textarea>`): titles here are
changelog headlines, so wrapping isn't needed.

### 2. Chrome-free body

- Remove the `rounded-lg border` from the MDXEditor root.
- Remove the source-toggle bar and its `border-b` from `toolbarContents`.
- The writing surface becomes text on the page background.
- The floating **selection toolbar** and **empty-block insert menu** REMAIN — they are
  contextual, not static chrome, and are the Notion model.

### 3. Remove labels, page heading, dividers

- Both field labels are removed.
- The "Edit draft" `<h1>` is removed — the title field is now the page heading, and
  two competing headings is not the intended feel.
- The "← Drafts" back-link stays as a subtle breadcrumb.
- The `border-t border-border/60` dividers above the action rows are replaced by
  whitespace.
- The review-status banner stays (it carries real information) but becomes a
  low-contrast inline note rather than a card.

### 4. Actions moved out of the writing surface

Below the content, with generous spacing and no borders:
**Source** (quiet text button) · **Save changes** (subtle) · **Approve & publish**
(the single primary) · **Reject** (de-emphasized, visually separated).

### 5. The source-toggle bridge

`SourceToggle` currently works because it renders inside `toolbarContents`, where
`usePublisher(viewMode$)` / `useCellValue(viewMode$)` have access to the editor
realm. Moving the control to the page action row requires a bridge:

- A new client module exposes `DraftEditorProvider` + `useDraftEditorBridge()`
  holding `{ viewMode, setViewMode } | null`.
- A `ViewModeBridge` component rendered inside `toolbarContents` reads the realm
  hooks and publishes them into the context via an effect (clearing on unmount).
- A `SourceToggleButton` client component in the action row consumes the context and
  renders nothing until the bridge is registered.
- `page.tsx` stays a server component; it wraps the relevant subtree in
  `DraftEditorProvider` so both the editor and the button sit inside it.

The toggle offers exactly `rich-text` ↔ `source`; `diff` remains unreachable.

## Constraints — behavior must not change

- `name="title"` on the title field; `DraftBodyEditor` keeps its hidden `name="body"`.
- "Save changes" stays the enclosing form's DEFAULT submit (`saveDraft`).
- "Approve & publish" keeps `formAction={approveDraft}` and stays INSIDE that form
  (this is what makes approving publish the current edits).
- "Reject" stays its own separate form with its own hidden `updateId`.
- The `plugins` array keeps all five parsers (`tablePlugin`, `imagePlugin`,
  `codeBlockPlugin`, `codeMirrorPlugin`, `diffSourcePlugin`) — removing any re-opens a
  fixed data-loss bug.
- The parse-error banner, the floating-surface logic (`findContentEl`,
  `useSelectionSurface`, the `preventDefault` guards), and the
  `.mdx-toolbar-host.mdx-toolbar-host` CSS rule stay intact. The banner's copy must be
  updated if it still points at a toggle "above the editor".
- Any `<button>` inside the form must be `type="button"` unless it is meant to submit.
- The server-side blank-body guard (`resolveBody`) is untouched.

## Implementation requirement

The implementer MUST invoke the **frontend-design** skill for the visual pass.

## Out of scope (YAGNI)

- No autosave — the explicit Save button is kept deliberately.
- No auto-growing textarea title.
- No changes to server actions, the drafts list, or publishing.
