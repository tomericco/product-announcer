# Notion-style Draft Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the draft editing page to a Notion-like title + body with no static borders, labels, or toolboxes, preserving every existing behavior.

**Architecture:** Task 1 relocates the source toggle out of the editor via a small client context bridge (the realm hooks only work inside `toolbarContents`) and deletes the static toolbar bar. Task 2 does the visual pass.

**Tech Stack:** Next.js App Router (server page + client subtree), `@mdxeditor/editor` v4.1.0, Tailwind v4.

## Global Constraints

Behavior that must NOT change (each is load-bearing; breaking any is a functional regression):
- Title field keeps `name="title"`; `DraftBodyEditor` keeps its hidden `name="body"`.
- "Save changes" stays the enclosing form's DEFAULT submit (`saveDraft`) — no `formAction` on it.
- "Approve & publish" keeps `formAction={approveDraft}` and stays INSIDE that same form.
- "Reject" stays its own SEPARATE form with its own hidden `updateId`.
- The `plugins` array keeps all five parsers (`tablePlugin`, `imagePlugin`, `codeBlockPlugin`, `codeMirrorPlugin`, `diffSourcePlugin`) — removing any re-opens a fixed data-loss bug.
- The parse-error banner, the floating-surface logic (`findContentEl`, `useSelectionSurface`, the `preventDefault` guards, the surface refs), and the `.mdx-toolbar-host.mdx-toolbar-host` CSS rule stay intact.
- Every `<button>` inside the form is `type="button"` unless it is meant to submit.
- No changes to any server action.

---

### Task 1: Move the source toggle out of the editor (context bridge)

**Files:**
- Create: `src/app/(dashboard)/drafts/[updateId]/draft-editor-context.tsx`
- Modify: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx`
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`

**Interfaces:**
- Produces: `DraftEditorProvider`, `useDraftEditorBridge()`, `SourceToggleButton` — the toggle now lives in the page action row; the editor no longer renders a toolbar bar.

- [ ] **Step 1: Create the context module**

Create `src/app/(dashboard)/drafts/[updateId]/draft-editor-context.tsx`:

```tsx
"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type EditorViewMode = "rich-text" | "source";

export type EditorBridge = {
  viewMode: EditorViewMode;
  setViewMode: (mode: EditorViewMode) => void;
} | null;

const DraftEditorContext = createContext<{
  bridge: EditorBridge;
  setBridge: (bridge: EditorBridge) => void;
}>({ bridge: null, setBridge: () => {} });

/**
 * Lets a control outside the MDXEditor (the page action row) drive the editor's
 * view mode. The realm hooks only work inside `toolbarContents`, so a bridge
 * component in there registers the setter here.
 */
export function DraftEditorProvider({ children }: { children: ReactNode }) {
  const [bridge, setBridge] = useState<EditorBridge>(null);
  return (
    <DraftEditorContext.Provider value={{ bridge, setBridge }}>
      {children}
    </DraftEditorContext.Provider>
  );
}

export function useDraftEditorBridge() {
  return useContext(DraftEditorContext);
}

/** Renders nothing until the editor has mounted and registered its bridge. */
export function SourceToggleButton() {
  const { bridge } = useDraftEditorBridge();
  if (!bridge) return null;
  const isSource = bridge.viewMode === "source";
  return (
    <button
      type="button"
      onClick={() => bridge.setViewMode(isSource ? "rich-text" : "source")}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      aria-pressed={isSource}
    >
      {isSource ? "Rich text" : "Source"}
    </button>
  );
}
```

- [ ] **Step 2: Replace the in-editor toggle with a bridge**

In `mdx-editor.tsx`:

1. Delete the `SourceToggle` component and the toolbar bar `<div>` that wrapped it (the `flex w-full justify-end border-b border-border/60 px-2 py-1.5` div inside `EditorSurfaces`).
2. Add a bridge component that registers the realm hooks into the context:

```tsx
function ViewModeBridge() {
  const viewMode = useCellValue(viewMode$);
  const setViewMode = usePublisher(viewMode$);
  const { setBridge } = useDraftEditorBridge();

  useEffect(() => {
    setBridge({
      viewMode: viewMode === "source" ? "source" : "rich-text",
      setViewMode,
    });
    return () => setBridge(null);
  }, [viewMode, setViewMode, setBridge]);

  return null;
}
```

3. Render `<ViewModeBridge />` as the first child of `EditorSurfaces`'s fragment (replacing the deleted bar). Keep the anchor div and both surfaces exactly as they are.
4. Add the needed imports: `useEffect` from react, and `useDraftEditorBridge` from `./draft-editor-context`. Keep `viewMode$`, `useCellValue`, `usePublisher` imported from `@mdxeditor/editor`.
5. Update the parse-error banner copy if it references a toggle "above the editor" — it should now point at the Source button in the page's action row.

- [ ] **Step 3: Wire the provider and the button into the page**

In `page.tsx`:

1. Import `DraftEditorProvider` and `SourceToggleButton` from `./draft-editor-context`.
2. Wrap the region containing BOTH the editor and the action row in `<DraftEditorProvider>` — i.e. wrap the `<form action={saveDraft}>` element (the provider is a client component; passing server-rendered children to it is fine).
3. Add `<SourceToggleButton />` into the action row, before the Save button.

Leave every other aspect of the form untouched at this stage (labels/borders are Task 2's job).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 189 tests pass.

Then re-read `mdx-editor.tsx` and confirm in your report: all five plugins still in `plugins`; `findContentEl` / `useSelectionSurface` / both surface refs and their `onMouseDown` guards unchanged; the anchor div still present.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts/[updateId]/draft-editor-context.tsx" "src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx" "src/app/(dashboard)/drafts/[updateId]/page.tsx"
git commit -m "refactor: move the source toggle out of the editor into the page action row"
```

---

### Task 2: Notion-style visual pass

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`
- Modify: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx` (root className only)
- Possibly modify: `src/app/globals.css` (`.mdx-content` typography)

**Interfaces:**
- Consumes: Task 1's action-row `SourceToggleButton`. Appearance only.

- [ ] **Step 1: Invoke the frontend-design skill**

REQUIRED: invoke the **frontend-design** skill (Skill tool, `skill: "frontend-design"`) and follow its guidance. The user explicitly asked for a design skill to be used. Do not skip it.

- [ ] **Step 2: Title as an H1**

In `page.tsx`, replace the labelled title block:

```tsx
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" defaultValue={update.title} />
        </div>
```

with a borderless page-title field (keeping `name="title"`):

```tsx
        <input
          id="title"
          name="title"
          defaultValue={update.title}
          placeholder="Untitled"
          aria-label="Title"
          className="w-full border-0 bg-transparent p-0 text-4xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40 focus:outline-none"
        />
```

Note it uses a plain `<input>`, not the `Input` component (whose border/ring is the thing being removed). Remove the now-unused `Input` and `Label` imports if nothing else in the file uses them (grep first).

- [ ] **Step 3: Remove the remaining static chrome**

In `page.tsx`:
- Delete the `<h1 className="text-xl font-semibold tracking-tight">Edit draft</h1>` (the title field is the heading now). Keep the "← Drafts" back-link.
- Delete the `<Label>Body</Label>` and its wrapper `div`, leaving `<DraftBodyEditor …/>` directly in the form.
- Remove `border-t border-border/60 pt-6` from the action row and from the reject form; use spacing instead.
- Soften the review-status banner from a `bg-muted/50` card to a low-contrast inline note.

In `mdx-editor.tsx`: remove `rounded-lg border border-border/60` from the `MDXEditor` `className` (keep `w-full`).

- [ ] **Step 4: Lay out the actions**

Group, below the content with generous spacing and no borders: `SourceToggleButton` · "Save changes" (subtle, e.g. `variant="ghost"` or `outline`) · "Approve & publish" (the single primary). Keep "Reject" de-emphasized and visually separated (its own row, muted).

Apply the frontend-design skill's guidance for spacing rhythm, hierarchy and restraint. Use only existing tokens — no new colors, no hardcoded hex.

- [ ] **Step 5: Optional `.mdx-content` typography polish**

If it serves the Notion feel, adjust `.mdx-content` paragraph spacing / line-height / max-width in `globals.css` (unlayered, alongside the existing rules). Do NOT touch the heading rules added earlier or the `.mdx-toolbar-host` / `.mdx-surface*` rules.

- [ ] **Step 6: Verify + behavior checklist**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 189 tests pass.

Re-read your edited files and confirm EACH of these in your report, with file:line:
1. title field has `name="title"`
2. `DraftBodyEditor` still rendered (its hidden `name="body"` intact)
3. "Save changes" is the form's default submit, with NO `formAction`
4. "Approve & publish" has `formAction={approveDraft}` and is INSIDE the save form
5. "Reject" is a separate form with its own hidden `updateId`
6. all five plugins still in `plugins`
7. floating-surface logic and the `.mdx-toolbar-host.mdx-toolbar-host` rule untouched

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "style: Notion-style minimal draft editing page"
```

---

## Self-Review Notes

- **Spec coverage:** title as H1 (Task 2 Step 2), chrome-free body (Task 1 Step 2 removes the bar; Task 2 Step 3 removes the border), labels/heading/dividers removed (Task 2 Step 3), actions relocated with Source among them (Task 1 Step 3 + Task 2 Step 4), source-toggle bridge (Task 1), frontend-design skill required (Task 2 Step 1). All spec sections mapped.
- **Type consistency:** `EditorViewMode` / `EditorBridge` / `useDraftEditorBridge` are defined once in `draft-editor-context.tsx` and consumed by `ViewModeBridge` (in `mdx-editor.tsx`) and `SourceToggleButton`. The bridge's `viewMode` is narrowed to the two-value union at the point of registration, so `diff` can never reach the button.
- **Ordering:** Task 1 is structural and leaves a working (if still bordered) page; Task 2 is purely visual on top of it. Every intermediate state builds.
- **Risk:** the toggle briefly renders nothing before the editor mounts and registers the bridge (`SourceToggleButton` returns null) — acceptable, and avoids a dead control. Called out so a reviewer doesn't read it as a bug.
