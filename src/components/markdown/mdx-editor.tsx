"use client";

import "@mdxeditor/editor/style.css";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
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

// Small set of common languages for the CodeMirror code-block editor. The
// underlying descriptor matches any fenced code block without "meta" text
// regardless of language, so this list only drives the language picker's
// labels -- it doesn't limit which fenced code blocks can be parsed.
const CODE_BLOCK_LANGUAGES = {
  js: "JavaScript",
  jsx: "JavaScript (React)",
  ts: "TypeScript",
  tsx: "TypeScript (React)",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  bash: "Bash",
  sh: "Shell",
  python: "Python",
  sql: "SQL",
  yaml: "YAML",
  md: "Markdown",
  "": "Plain text",
};

type SurfaceMode = "hidden" | "selection" | "insert";

/**
 * The props MDXEditor hands its `EditImageToolbar` (dist/index.d.ts:1131-1139
 * — the interface itself is not exported, so it is restated here). A consumer
 * replaces the default delete/settings toolbar by passing `imageToolbar`.
 */
export type ImageEditToolbarProps = {
  nodeKey: string;
  imageSource: string;
  initialImagePath: string | null;
  title: string;
  alt: string;
  width?: number | "inherit";
  height?: number | "inherit";
};

// The toolbar host (our positioning anchor's offsetParent) and the
// content-editable wrapper (.mdx-content) are SIBLINGS in MDXEditor's DOM
// tree, not ancestor/descendant -- see RichTextEditor in
// node_modules/@mdxeditor/editor/dist/MDXEditor.js, which renders
// topAreaChildren (the toolbar) and the content-editable wrapper as sibling
// children of the same fragment. So `.mdx-content` must be located by
// walking UP from the host to a shared ancestor, not by querying inside the
// toolbar host itself. Walk up to (and including) document.body to avoid
// pathological walking past the document root.
function findContentEl(host: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = host;
  while (node) {
    const found = node.querySelector<HTMLElement>(".mdx-content");
    if (found) return found;
    if (node === document.body) break;
    node = node.parentElement;
  }
  return null;
}

// Clamp a coordinate to [min, max] -- used to keep the floating surfaces
// from rendering off-screen near the edges of the positioning parent.
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function useSelectionSurface(hostRef: React.RefObject<HTMLDivElement | null>) {
  const [mode, setMode] = useState<SurfaceMode>("hidden");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // Refs on the two floating surfaces themselves, so `update()` can tell
  // when a selectionchange was caused by interacting WITH a surface (e.g.
  // focus moving into BlockTypeSelect's trigger) rather than by the user
  // clicking away from the editor. In that case we must not hide the
  // surface mid-click, or the click that opens/activates it gets swallowed.
  const selectionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const insertSurfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function update() {
      // A panel is open inside a surface (the Generate-image panel). Its own
      // controls take focus and can clear the editor's DOM selection
      // outright -- pressing "Suggest prompt", which then spends a couple of
      // seconds on a model call, did exactly that and dismissed the panel
      // mid-request. Anchored to the surface as it is, the panel can only
      // stay put if the surface does; nothing here may move or hide it while
      // it is on screen. Checked BEFORE the focus test below because focus
      // is not reliably inside the panel at every point of a click.
      if (
        selectionSurfaceRef.current?.querySelector(".mdx-surface-panel") ||
        insertSurfaceRef.current?.querySelector(".mdx-surface-panel")
      ) {
        return;
      }

      const active = document.activeElement;
      if (
        active &&
        ((selectionSurfaceRef.current && selectionSurfaceRef.current.contains(active)) ||
          (insertSurfaceRef.current && insertSurfaceRef.current.contains(active)))
      ) {
        // Focus/interaction is currently inside one of the surfaces (e.g. a
        // toolbar button just received focus on mousedown) -- leave the
        // surface exactly as it is rather than hiding it out from under an
        // in-flight click.
        return;
      }

      const host = hostRef.current;
      // `parent` (the toolbar host div) is the CSS `position: relative`
      // containing block for the floating surfaces, so it stays the
      // coordinate origin for their top/left -- only the content lookup
      // below is scoped differently.
      const parent = host?.offsetParent as HTMLElement | null;
      const content = host && findContentEl(host);
      const sel = window.getSelection();
      if (!host || !parent || !content || !sel || sel.rangeCount === 0 || !sel.anchorNode || !content.contains(sel.anchorNode)) {
        setMode("hidden");
        return;
      }
      const parentRect = parent.getBoundingClientRect();
      const range = sel.getRangeAt(0);

      if (!sel.isCollapsed) {
        const r = range.getBoundingClientRect();
        const rawTop = r.top - parentRect.top;
        const rawLeft = r.left - parentRect.left + r.width / 2;
        setPos({
          top: Math.max(rawTop, 0),
          left: clamp(rawLeft, 0, parent.clientWidth),
        });
        setMode("selection");
        return;
      }

      // Collapsed caret: only offer the insert menu on an EMPTY paragraph.
      let block: HTMLElement | null;
      if (sel.anchorNode === content) {
        // Empty editor: the anchor is the content wrapper itself, so there's
        // no ancestor walk to do -- resolve the target block directly from
        // its children, falling back to the first child if the offset is
        // out of range (e.g. no children yet).
        const idx = clamp(sel.anchorOffset, 0, Math.max(content.children.length - 1, 0));
        block = (content.children[idx] as HTMLElement | undefined) ?? (content.children[0] as HTMLElement | undefined) ?? null;
      } else {
        let node: Node | null = sel.anchorNode;
        while (node && node.parentElement !== content) node = node.parentElement;
        block = node as HTMLElement | null;
      }

      if (block && block.tagName === "P" && block.children.length === 0 && !block.textContent?.trim()) {
        const r = block.getBoundingClientRect();
        const rawTop = r.top - parentRect.top;
        const rawLeft = r.left - parentRect.left;
        setPos({
          top: Math.max(rawTop, 0),
          left: clamp(rawLeft, 0, parent.clientWidth),
        });
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

  return { mode, pos, selectionSurfaceRef, insertSurfaceRef };
}

function EditorSurfaces({
  realmChildren,
  selectionExtras,
  insertExtras,
}: {
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
  insertExtras?: React.ReactNode;
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

      {/* No tooltip wrapper on these two: MDXEditor's own toolbar buttons
          already carry its `TooltipWrap` internally. Anything WE add here
          (`insertExtras`, `selectionExtras`) has to bring its own — see
          GenerateImageButton, which uses that same `TooltipWrap` so a
          custom button is indistinguishable from a built-in one. */}
      <div
        ref={insertSurfaceRef}
        className="mdx-surface mdx-surface-insert"
        data-open={mode === "insert"}
        style={{ top: pos.top, left: pos.left }}
        onMouseDown={preserveSelection}
      >
        <InsertImage />
        <InsertCodeBlock />
        {insertExtras}
      </div>
    </>
  );
}

export default function MdxEditor({
  markdown,
  onChange,
  editorRef,
  realmChildren,
  selectionExtras,
  insertExtras,
  imageUploadHandler,
  imageToolbar,
  contentEditableClassName = "min-h-[65vh]",
  placeholder = <span className="text-muted-foreground/40">Update body</span>,
  readOnly,
  parseErrorHint = "Copy your text elsewhere before reloading the page, so a fix doesn't cost you the content.",
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
  // Rendered in the floating insert surface (empty paragraph) after the
  // built-in InsertImage / InsertCodeBlock buttons.
  insertExtras?: React.ReactNode;
  // Handed to imagePlugin: makes drag-drop, paste and the image dialog's file
  // tab upload the file and insert the returned URL. Without it the plugin
  // stays URL-only, as before.
  imageUploadHandler?: (file: File) => Promise<string>;
  // Replaces the plugin's per-image delete/settings toolbar (rendered top-right
  // of every image while editing).
  imageToolbar?: React.FC<ImageEditToolbarProps>;
  // Caller-supplied ADDITIONS to the content-editable element's class list.
  // The ".mdx-content" token itself is always applied internally (see below)
  // -- findContentEl() and the app's CSS both hardcode that selector, so a
  // caller can't opt out of it, only add to it.
  contentEditableClassName?: string;
  placeholder?: React.ReactNode;
  // Trailing sentence of the parse-error banner, telling the user how to
  // recover. Defaults to generic, honest advice; pass something more specific
  // when the page has a recovery control (e.g. drafts' Source toggle).
  parseErrorHint?: string;
  // Freezes the content-editable. Used while a background job is about to
  // replace this content wholesale — an edit typed during that window is lost
  // when the new value arrives, so the honest thing is to refuse the edit.
  readOnly?: boolean;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  const internalRef = useRef<MDXEditorMethods>(null);
  const ref = editorRef ?? internalRef;

  return (
    <div className="w-full space-y-2">
      {parseError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
          This content&apos;s Markdown couldn&apos;t be fully rendered ({parseError}). {parseErrorHint}
        </p>
      )}
      <MDXEditor
        ref={ref}
        markdown={markdown}
        readOnly={readOnly}
        onChange={onChange}
        onError={({ error, source }) => {
          // Never fail silently: a parse error previously left the editor
          // blank, which then submitted an empty body on save. Surface it.
          console.error("MDXEditor markdown parse error:", error, source);
          setParseError(error);
        }}
        className="w-full"
        contentEditableClassName={cn("mdx-content", contentEditableClassName)}
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
          imagePlugin({
            imageUploadHandler,
            // No drag handles in the editor. Width/height are a property of
            // the render itself (every master is 1200px wide, and covers are
            // generated at their exact shape and never cropped), and the
            // markdown body has nowhere to record a per-instance size anyway
            // — so a resize here would either be silently lost on save or
            // start a second, conflicting source of truth for how big an
            // image is.
            disableImageResize: true,
            // imagePlugin types EditImageToolbar as `React.FC` (props {}), so a
            // typed component needs the cast; MDXEditor calls it with the
            // ImageEditToolbarProps shape regardless.
            ...(imageToolbar ? { EditImageToolbar: imageToolbar as unknown as React.FC } : {}),
          }),
          codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
          codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
          diffSourcePlugin({ viewMode: "rich-text" }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarClassName: "mdx-toolbar-host",
            toolbarContents: () => (
              <EditorSurfaces realmChildren={realmChildren} selectionExtras={selectionExtras} insertExtras={insertExtras} />
            ),
          }),
        ]}
      />
    </div>
  );
}
