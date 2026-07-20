# Draft editor refinement: floating toolbars, heading styles, minimal design

## Problem

The draft WYSIWYG editor (`@mdxeditor/editor`) currently renders one fixed toolbar
pinned to the top of the editor holding every control. Four issues:

1. The toolbar is always-on and pushed to the top rather than appearing contextually.
2. Applying a heading appears to do nothing — Tailwind's preflight
   (`node_modules/tailwindcss/preflight.css`: `h1..h6 { font-size: inherit;
   font-weight: inherit }`) flattens headings, and `.mdx-content` in `globals.css`
   defines only `ul/ol/li` rules. The `<h2>` IS applied; it just renders identically
   to a paragraph. Same root-cause class as the previously-fixed invisible bullets.
3. Table-insert, rich-text/diff mode toggles clutter the surface.
4. The page overall is heavier than it needs to be.

## Goal

Replace the fixed toolbar with two contextual floating surfaces, make headings (and
other block formatting) visibly render, remove the unwanted controls, expose source
mode as an app-level toggle, and give the page a cleaner, more minimal design.

## Design

### 1. Two floating surfaces (the bubble + floating-menu convention)

Both render inside `toolbarPlugin`'s `toolbarContents` — the only slot with access to
the editor realm that the toolbar primitives require — and are positioned with CSS
inside a `position: relative` editor wrapper.

| Surface | Trigger | Contents |
|---|---|---|
| **Selection toolbar** | selection inside the editor is **non-collapsed** | `BoldItalicUnderlineToggles`, `BlockTypeSelect` (headings), `ListsToggle`, `CreateLink` |
| **Insert menu** | selection is **collapsed** AND the caret's current block is **empty** | `InsertImage`, `InsertCodeBlock` |

Only one surface is visible at a time; both hide when the editor loses focus.

Detection/positioning: a client hook listens to `document`'s `selectionchange` (plus
editor blur), reads `window.getSelection()`, verifies the anchor is inside the
editor's `contentEditable`, and computes a rect via
`range.getBoundingClientRect()`, converted to coordinates relative to the editor
wrapper. For a collapsed caret on an empty block the range rect can be zero-width —
fall back to the containing block element's `getBoundingClientRect()`.

`UndoRedo` is intentionally in neither surface (⌘Z and Markdown shortcuts still work).

### 2. Heading (and block) styles — the "headings don't work" fix

Add to `src/app/globals.css`, scoped to `.mdx-content` (alongside the existing list
rules), restoring what preflight flattens: `h1`–`h6` (font-size + font-weight +
margins), `blockquote`, `code`/`pre`, and `hr`. These must sit outside `@layer` so
they beat preflight, matching how the existing list rules are declared.

### 3. Removals (toolbar only — parsing preserved)

- Remove the `InsertTable` toolbar button.
- Remove `DiffSourceToggleWrapper` (this is what surfaced the rich-text / diff modes).
- **Keep `tablePlugin`, `imagePlugin`, `codeBlockPlugin`, `codeMirrorPlugin`.** These
  are parsers: removing them would re-introduce the fixed data-loss bug where a draft
  containing a table/image/code block fails to parse, renders blank, and is
  overwritten on save. Only the buttons go.

### 4. Source mode as an app-level toggle

- Keep `diffSourcePlugin` (its syntax-highlighted source view).
- Replace the built-in wrapper with our own toggle rendered in `toolbarContents`,
  using `usePublisher(viewMode$)` and `useCellValue(viewMode$)` — both reachable from
  `@mdxeditor/editor`, which re-exports gurx (`export * from "@mdxeditor/gurx"`).
- It offers exactly two modes: `rich-text` ↔ `source`. `diff` is never offered.
- Styled as a minimal bar above the editor content; since the formatting controls now
  float, that row contains only this toggle and reads as an app-level control.
- The existing parse-error banner text must be updated to point at this toggle
  (it currently says "the source toggle in the toolbar").

### 5. Page design pass

The implementer MUST invoke the **frontend-design** skill and apply it to
`src/app/(dashboard)/drafts/[updateId]/page.tsx` and the editor chrome: cleaner
spacing and hierarchy for the review-status banner, title field, editor container,
and the action row (Save / Approve & publish / Reject). Restrained borders, minimal
chrome, no decorative additions. Functionality must not change.

## Constraints

- Do NOT remove the parsing plugins (see §3) — that regresses a fixed data-loss bug.
- Keep the explicit "Save changes" button and the `formAction`-based
  "Approve & publish" (which persists edits before publishing) exactly as they work today.
- The blank-body guard in `saveDraft`/`approveDraft` stays.
- Editor remains full **column** width (inside the layout's `max-w-4xl`).
- Body stays Markdown; storage and the webhook payload are unchanged.
- Patched Next.js — verify any client-hook/DOM API pattern against
  `node_modules/next/dist/docs/` where relevant.

## Out of scope (YAGNI)

- No slash-command menu (the empty-block insert menu covers the need).
- No table creation UI.
- No autosave.
- No changes to the drafts list, history, or publishing.
