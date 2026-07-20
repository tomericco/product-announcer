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
  usePublisher,
  useCellValue,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertImage,
  InsertCodeBlock,
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

export default function MdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (md: string) => void;
}) {
  const [parseError, setParseError] = useState<string | null>(null);

  return (
    <div className="w-full space-y-2">
      {parseError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive">
          This draft&apos;s Markdown couldn&apos;t be fully rendered ({parseError}). Switch to Source mode
          (the toggle above the editor) to view and edit the raw Markdown safely.
        </p>
      )}
      <MDXEditor
        markdown={markdown}
        onChange={onChange}
        onError={({ error, source }) => {
          // Never fail silently: a parse error previously left the editor
          // blank, which then submitted an empty body on save. Surface it.
          console.error("MDXEditor markdown parse error:", error, source);
          setParseError(error);
        }}
        className="w-full rounded-lg border border-border"
        contentEditableClassName="mdx-content min-h-[65vh]"
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
            toolbarContents: () => <EditorSurfaces />,
          }),
        ]}
      />
    </div>
  );
}
