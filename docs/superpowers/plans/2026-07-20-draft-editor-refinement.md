# Draft Editor Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make headings (and other block formatting) visibly render, replace the fixed editor toolbar with two contextual floating surfaces, expose source mode as an app-level toggle, and give the draft page a cleaner minimal design.

**Architecture:** CSS restores what Tailwind preflight flattens. The editor's `toolbarContents` (the only realm-connected slot) renders three things: an app-level source toggle bar, a selection ("bubble") toolbar, and an empty-block insert menu — the latter two absolutely positioned from the live selection.

**Tech Stack:** Next.js (client components), `@mdxeditor/editor` v4.1.0 (+ its re-exported `@mdxeditor/gurx` hooks), Tailwind v4, Vitest.

## Global Constraints

- **Do NOT remove `tablePlugin`, `imagePlugin`, `codeBlockPlugin`, or `codeMirrorPlugin`.** They are parsers. Removing them re-introduces a fixed data-loss bug (a draft containing a table/image/code block fails to parse, renders blank, and gets overwritten on save). Only toolbar BUTTONS are removed.
- Keep the "Save changes" button and the `formAction`-based "Approve & publish" (which persists edits before publishing) working exactly as today. Keep the blank-body guard in `saveDraft`/`approveDraft`.
- The editor stays full **column** width (inside the layout's `max-w-4xl`). Body stays Markdown; storage and webhook payload unchanged.
- New CSS must sit OUTSIDE `@layer` (like the existing `.mdx-content ul/ol/li` rules) so it beats Tailwind preflight.
- Patched Next.js — verify any unfamiliar API against `node_modules/next/dist/docs/`.

---

### Task 1: Restore heading / block styles (the "headings don't work" fix)

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: `.mdx-content` heading/blockquote/code/hr styling. No JS/TS changes.

- [ ] **Step 1: Add the styles**

The existing `.mdx-content ul/ol/li` rules live near the end of `src/app/globals.css`, outside any `@layer`. Append alongside them (same placement, so they also beat preflight):

```css
.mdx-content h1 {
  font-size: 1.875rem;
  font-weight: 700;
  line-height: 1.2;
  margin: 1.5rem 0 0.75rem;
}
.mdx-content h2 {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.25;
  margin: 1.25rem 0 0.625rem;
}
.mdx-content h3 {
  font-size: 1.25rem;
  font-weight: 600;
  line-height: 1.3;
  margin: 1rem 0 0.5rem;
}
.mdx-content h4 {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 1rem 0 0.5rem;
}
.mdx-content h5,
.mdx-content h6 {
  font-size: 1rem;
  font-weight: 600;
  margin: 0.875rem 0 0.5rem;
}
.mdx-content h1:first-child,
.mdx-content h2:first-child,
.mdx-content h3:first-child {
  margin-top: 0;
}
.mdx-content blockquote {
  border-left: 3px solid var(--border);
  padding-left: 1rem;
  margin: 1rem 0;
  color: var(--muted-foreground);
}
.mdx-content code {
  font-family: var(--font-mono, monospace);
  font-size: 0.875em;
  background: var(--muted);
  padding: 0.125rem 0.3rem;
  border-radius: 0.25rem;
}
.mdx-content pre code {
  background: transparent;
  padding: 0;
}
.mdx-content hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 1.5rem 0;
}
```

(If `--muted` / `--muted-foreground` / `--border` aren't defined as CSS variables in this file, use the equivalents that are — check the `@theme`/`:root` block at the top before writing.)

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm test`
Expected: clean; 189 tests pass (CSS-only change, nothing should move).

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "fix: restore heading/blockquote/code styles flattened by Tailwind preflight"
```

---

### Task 2: Toolbar cleanup + app-level source toggle

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx`

**Interfaces:**
- Produces: the editor renders a single minimal top bar containing only a rich-text ↔ source toggle. `InsertTable` and `DiffSourceToggleWrapper` are gone. The formatting controls remain in the top toolbar for now (Task 3 makes them float).

- [ ] **Step 1: Replace the toggle wrapper with a custom source toggle**

In `mdx-editor.tsx`:

1. Change the imports: drop `DiffSourceToggleWrapper` and `InsertTable`; add `viewMode$`, `usePublisher`, `useCellValue`. (`usePublisher`/`useCellValue` come from `@mdxeditor/gurx`, which `@mdxeditor/editor` re-exports via `export * from "@mdxeditor/gurx"` — import them from `"@mdxeditor/editor"`. If that import fails to resolve at typecheck, import them from `"@mdxeditor/gurx"` directly and note it in your report.)
2. Add a toggle component in this file. It must be rendered inside `toolbarContents` (the editor realm) for the hooks to work:

```tsx
function SourceToggle() {
  const viewMode = useCellValue(viewMode$);
  const setViewMode = usePublisher(viewMode$);
  const isSource = viewMode === "source";
  return (
    <button
      type="button"
      onClick={() => setViewMode(isSource ? "rich-text" : "source")}
      className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-pressed={isSource}
    >
      {isSource ? "Rich text" : "Source"}
    </button>
  );
}
```

3. Replace the `toolbarContents` body — remove the `DiffSourceToggleWrapper` and `InsertTable`, and put the source toggle in its own row above the formatting controls:

```tsx
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <div className="flex w-full justify-end border-b border-border px-1 py-1">
                  <SourceToggle />
                </div>
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
                <InsertImage />
                <InsertCodeBlock />
              </>
            ),
          }),
```

4. Leave every plugin in the `plugins` array untouched (including `tablePlugin` and `diffSourcePlugin`).

- [ ] **Step 2: Update the parse-error banner text**

The banner currently tells the user to use "the source toggle in the toolbar". Update that sentence to reference the new control, e.g.: `Switch to Source mode (the toggle above the editor) to view and edit the raw Markdown safely.`

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 189 tests pass.

Also confirm by reading the file: `tablePlugin`, `imagePlugin`, `codeBlockPlugin`, `codeMirrorPlugin`, `diffSourcePlugin` are all still in `plugins`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx"
git commit -m "feat: app-level source toggle; drop table-insert and diff mode from the editor"
```

---

### Task 3: Floating selection toolbar + empty-block insert menu

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx`
- Modify: `src/app/globals.css` (positioning/appearance for the two surfaces)

**Interfaces:**
- Consumes: the toolbar contents from Task 2.
- Produces: formatting controls appear only on a non-collapsed selection; insert controls appear only when the caret is on an empty block; the top bar keeps only the source toggle.

- [ ] **Step 1: Add the selection-tracking hook**

Add to `mdx-editor.tsx` (it is already `"use client"`). It reports which surface to show and where, in coordinates relative to the floating element's own containing block — using `offsetParent` makes this robust no matter which ancestor ends up positioned:

```tsx
type SurfaceMode = "hidden" | "selection" | "insert";

function useSelectionSurface(hostRef: React.RefObject<HTMLDivElement | null>) {
  const [mode, setMode] = useState<SurfaceMode>("hidden");
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    function update() {
      const host = hostRef.current;
      const parent = host?.offsetParent as HTMLElement | null;
      const content = parent?.querySelector<HTMLElement>(".mdx-content");
      const sel = window.getSelection();
      if (!host || !parent || !content || !sel || sel.rangeCount === 0 || !sel.anchorNode || !content.contains(sel.anchorNode)) {
        setMode("hidden");
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const range = sel.getRangeAt(0);

      if (!sel.isCollapsed) {
        const r = range.getBoundingClientRect();
        setPos({ top: r.top - parentRect.top, left: r.left - parentRect.left + r.width / 2 });
        setMode("selection");
        return;
      }

      // Collapsed caret: only offer the insert menu on an EMPTY block.
      let node: Node | null = sel.anchorNode;
      while (node && node.parentElement !== content) node = node.parentElement;
      const block = node as HTMLElement | null;
      if (block && !block.textContent?.trim()) {
        const r = block.getBoundingClientRect();
        setPos({ top: r.top - parentRect.top, left: r.left - parentRect.left });
        setMode("insert");
      } else {
        setMode("hidden");
      }
    }

    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [hostRef]);

  return { mode, pos };
}
```

- [ ] **Step 2: Render the two surfaces from toolbarContents**

Replace Task 2's `toolbarContents` body with a component that uses the hook. Define it in the same file:

```tsx
function EditorSurfaces() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { mode, pos } = useSelectionSurface(hostRef);

  return (
    <>
      <div className="flex w-full justify-end border-b border-border px-1 py-1">
        <SourceToggle />
      </div>

      {/* Anchor: not visible itself; gives the hook an offsetParent to measure against. */}
      <div ref={hostRef} className="mdx-surface-anchor" />

      <div
        className="mdx-surface mdx-surface-selection"
        data-open={mode === "selection"}
        style={{ top: pos.top, left: pos.left }}
      >
        <BoldItalicUnderlineToggles />
        <BlockTypeSelect />
        <ListsToggle />
        <CreateLink />
      </div>

      <div
        className="mdx-surface mdx-surface-insert"
        data-open={mode === "insert"}
        style={{ top: pos.top, left: pos.left }}
      >
        <InsertImage />
        <InsertCodeBlock />
      </div>
    </>
  );
}
```

and use it: `toolbarPlugin({ toolbarContents: () => <EditorSurfaces /> })`.

Add `useRef` to the React import.

- [ ] **Step 3: Add the surface CSS**

Append to `src/app/globals.css` (outside `@layer`, next to the other `.mdx-*` rules):

```css
.mdx-surface-anchor {
  position: absolute;
  inset: 0;
  pointer-events: none;
  height: 0;
}
.mdx-surface {
  position: absolute;
  z-index: 30;
  display: none;
  align-items: center;
  gap: 0.125rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--background);
  padding: 0.25rem;
  box-shadow: 0 6px 20px rgb(0 0 0 / 8%);
}
.mdx-surface[data-open="true"] {
  display: flex;
}
/* Selection toolbar sits centered just above the highlighted text. */
.mdx-surface-selection {
  transform: translate(-50%, calc(-100% - 8px));
}
/* Insert menu sits on the empty line, nudged left of the caret. */
.mdx-surface-insert {
  transform: translate(-2px, -2px);
}
```

- [ ] **Step 4: Neutralize the toolbar container so it doesn't reserve layout**

The toolbar host must not push content down or clip the floating surfaces. Pass a class and style it:

In `mdx-editor.tsx`, change the plugin to `toolbarPlugin({ toolbarClassName: "mdx-toolbar-host", toolbarContents: () => <EditorSurfaces /> })`, and add to `globals.css`:

```css
.mdx-toolbar-host {
  position: relative;
  display: block;
  overflow: visible;
  padding: 0;
  border: 0;
}
```

- [ ] **Step 5: Verify positioning behaves (the risk in this task)**

Run: `npm run typecheck && npm test` — expected clean / 189 passing.

Then reason through and record in your report: which element ends up as the `offsetParent` of `.mdx-surface-anchor`, and whether the two surfaces are positioned against that same element (they must be — they're siblings inside the same toolbar host). If `@mdxeditor`'s own CSS sets `overflow: hidden` or a transform on an ancestor that would clip or re-root the surfaces, say so.

**Fallback if positioning proves unworkable:** do NOT ship a broken floating toolbar. Instead render the formatting controls as a compact bar pinned to the top of the editor that is *only shown when `mode === "selection"`* (still contextual, no longer always-on), keep the insert menu on the same conditional, and report that you took the fallback and why.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx" src/app/globals.css
git commit -m "feat: contextual floating selection toolbar and empty-block insert menu"
```

---

### Task 4: Frontend-design pass on the draft page

**Files:**
- Modify: `src/app/(dashboard)/drafts/[updateId]/page.tsx`
- Possibly modify: `src/app/(dashboard)/drafts/[updateId]/mdx-editor.tsx` (editor chrome only), `src/app/globals.css`

**Interfaces:**
- Consumes: everything from Tasks 1-3. Changes appearance only.

- [ ] **Step 1: Invoke the frontend-design skill**

REQUIRED: invoke the **frontend-design** skill and follow its guidance for this pass. Do not skip it — the user explicitly asked for it.

- [ ] **Step 2: Apply a cleaner, minimal design to the draft page**

Target `src/app/(dashboard)/drafts/[updateId]/page.tsx`. Improve hierarchy and restraint across: the review-status banner, the Title field, the editor container, and the action row (Save changes / Approve & publish / Reject). Guidance:

- Give the page a clear top-level heading/identity; right now it opens straight into a banner/field with no framing.
- Reduce chrome: fewer/softer borders, consistent spacing rhythm, muted secondary actions, one clear primary action.
- Group the destructive/secondary actions away from the primary one.
- Keep it minimal — no decorative flourishes, no new colors beyond the existing tokens.

**Hard constraints — do NOT change behavior:**
- The Title input keeps `name="title"`; the body editor keeps its hidden `name="body"` input.
- "Save changes" stays the form's default submit (`saveDraft`); "Approve & publish" keeps `formAction={approveDraft}` and stays INSIDE the same form; "Reject" stays its own separate form.
- No change to any server action.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 189 tests pass.

Re-read your edited `page.tsx` and confirm in your report: the title input's `name`, the approve button's `formAction`, the save button's default submit, and the separate reject form are all intact.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "style: cleaner, more minimal draft editing page"
```

---

## Self-Review Notes

- **Spec coverage:** floating selection toolbar + empty-block insert menu (Task 3), heading/block styles (Task 1), removals of table-insert + rich-text/diff (Task 2), source mode as an app-level toggle (Task 2), frontend-design pass (Task 4). All spec sections mapped.
- **Type consistency:** `SurfaceMode` / `useSelectionSurface` / `SourceToggle` / `EditorSurfaces` are defined once in `mdx-editor.tsx` and used consistently; the `.mdx-surface*` class names in the component match those added to `globals.css` (a mismatch here would silently break positioning — same failure mode as the earlier `.mdx-content` bug, so it's called out in Task 3 Step 5).
- **Ordering:** Task 1 is independent (CSS only). Task 2 simplifies the toolbar while keeping it working. Task 3 converts it to floating surfaces on top of Task 2's contents. Task 4 restyles last, once behavior is settled. Every intermediate state builds and leaves a usable editor.
- **Risk:** Task 3's positioning is the one genuinely uncertain piece; it has an explicit verification step and a documented fallback so a broken floating toolbar is never shipped.
