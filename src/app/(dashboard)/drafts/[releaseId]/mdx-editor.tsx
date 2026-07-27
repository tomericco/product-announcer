"use client";

import "@mdxeditor/editor/style.css";
import { useEffect, useRef, useState } from "react";
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
  viewMode$,
  activeEditor$,
  usePublisher,
  useCellValue,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  InsertCodeBlock,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import { Sparkles } from "lucide-react";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
import { useDraftEditorBridge } from "./draft-editor-context";
import { useAgentEdit, type EditorOps } from "./agent-edit-context";

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

function EditorSurfaces({ editorRef }: { editorRef: React.RefObject<MDXEditorMethods | null> }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { mode, pos, selectionSurfaceRef, insertSurfaceRef } = useSelectionSurface(hostRef);

  // Keep the DOM selection intact when pressing a surface button. Without
  // this, mousedown's default action can move focus/selection out of
  // `.mdx-content` before the click completes, which fires `selectionchange`
  // and hides the surface mid-click -- swallowing the click.
  const preserveSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <>
      <ViewModeBridge />
      <AgentEditBridge editorRef={editorRef} />

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

  useEffect(() => {
    activeEditorRef.current = activeEditor;
  }, [activeEditor]);

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

export default function MdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  // The second arg is true when the editor is normalizing the initial markdown
  // on mount rather than reacting to a user edit.
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
}) {
  const [parseError, setParseError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods>(null);

  return (
    <div className="w-full space-y-2">
      {parseError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
          This draft&apos;s Markdown couldn&apos;t be fully rendered ({parseError}). Switch to Source mode
          (the Source button in the action row) to view and edit the raw Markdown safely.
        </p>
      )}
      <MDXEditor
        ref={editorRef}
        markdown={markdown}
        onChange={onChange}
        onError={({ error, source }) => {
          // Never fail silently: a parse error previously left the editor
          // blank, which then submitted an empty body on save. Surface it.
          console.error("MDXEditor markdown parse error:", error, source);
          setParseError(error);
        }}
        className="w-full"
        contentEditableClassName="mdx-content min-h-[65vh]"
        // Styled node rather than a bare string so it matches the title's
        // placeholder regardless of the editor's own default styling.
        placeholder={<span className="text-muted-foreground/40">Update body</span>}
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
            toolbarContents: () => <EditorSurfaces editorRef={editorRef} />,
          }),
        ]}
      />
    </div>
  );
}
