"use client";

import { useCallback, useEffect, useRef } from "react";
import { activeEditor$, useCellValue, ImageNode, type MDXEditorMethods } from "@mdxeditor/editor";
import { Sparkles, Split } from "lucide-react";
import { toast } from "sonner";
import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  $getRoot,
  $createParagraphNode,
  $nodesOfType,
  $getNodeByKey,
  type LexicalEditor,
  type RangeSelection,
} from "lexical";
import { useAgentEdit, type EditorOps } from "./agent-edit-context";
import SharedMdxEditor from "@/components/markdown/mdx-editor";
import { ViewModeBridge } from "@/components/markdown/view-mode-bridge";
import { GenerateImageButton } from "./generate-image-button";
import { DraftImageProvider } from "./draft-image-context";
import { ImageEditToolbar } from "./image-edit-toolbar";
import { uploadImageFile } from "./image-actions";

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
  // Separate from savedSelection: Ask AI's removeSelection consumes and clears
  // that one, and an image insert must not be able to steal or lose it.
  const savedInsertPoint = useRef<RangeSelection | null>(null);

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
      applyEdit: (mode, markdown) =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          const saved = savedSelection.current;
          // Nothing safe to apply (no active editor, or selection mode with no
          // captured range): resolve with the current, unchanged body.
          if (!editor || (mode === "selection" && !saved)) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }

          // getMarkdown() reads MDXEditor's markdown cell, which is only
          // refreshed inside the editor's own commit-time update listener
          // (registered at editor init, so BEFORE this one). Lexical defers
          // that commit to a microtask, so reading synchronously right after
          // an edit returns the PRE-edit body. Register a one-shot listener to
          // read AFTER the commit instead. Both the selection/clear update and
          // insertMarkdown below are plain updates in the same tick, so Lexical
          // coalesces them into a single deferred commit — this fires exactly
          // once, after the core listener has refreshed the markdown cell.
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });

          if (mode === "selection" && saved) {
            // Restore the captured range, then insertMarkdown replaces it:
            // MDXEditor's insertMarkdown$ reads $getSelection() and
            // $insertNodes() over the non-collapsed range, deleting the
            // selected content first.
            editor.update(() => {
              $setSelection(saved.clone());
            });
          } else {
            // Whole-update: empty the document and drop the caret into a fresh
            // paragraph so insertMarkdown rebuilds the entire body. Routing
            // through insertMarkdown (not the change-muting setMarkdown) is
            // what fires DraftBodyEditor's onChange, keeping its state and
            // hidden input in sync so a later manual save can't clobber this.
            editor.update(() => {
              const root = $getRoot();
              root.clear();
              const paragraph = $createParagraphNode();
              root.append(paragraph);
              paragraph.selectEnd();
            });
          }
          editorRef.current?.insertMarkdown(markdown);
        }),
      removeSelection: () =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          const saved = savedSelection.current;
          // Nothing captured to remove: resolve with the unchanged body so the
          // caller's guard (blank remaining body) can't be fooled into thinking
          // a deletion happened.
          if (!editor || !saved) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }

          // Consume the capture now, before the update below (which can throw
          // synchronously and reject this promise). A failed extract's restore
          // rebuilds the whole tree via root.clear() + insertMarkdown, which
          // invalidates every node key this selection points at — so a retry
          // in the same dialog session must NOT reuse it. Clearing here,
          // unconditionally and ahead of the update, means a second call sees
          // `saved` as null and takes the early-return branch above instead of
          // restoring a selection over keys that no longer resolve.
          savedSelection.current = null;

          // Same one-shot listener as applyEdit: Lexical defers the commit that
          // refreshes MDXEditor's markdown cell to a microtask, so reading
          // synchronously after the update returns the PRE-deletion body.
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });

          editor.update(() => {
            $setSelection(saved.clone());
            // Read the selection back rather than calling removeText() on the
            // clone: removeText operates on the editor's ACTIVE selection.
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.removeText();
          });
        }),
      getMarkdown: () => editorRef.current?.getMarkdown() ?? "",
      captureInsertPoint: () => {
        const editor = activeEditorRef.current;
        if (!editor) return;
        editor.getEditorState().read(() => {
          const sel = $getSelection();
          savedInsertPoint.current = $isRangeSelection(sel) ? sel.clone() : null;
        });
      },
      insertAtCursor: (markdown) =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          const saved = savedInsertPoint.current;
          if (!editor || !saved) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }
          // Consume the capture: after insertMarkdown the keys it points at
          // may not survive, so a second insert must re-capture.
          savedInsertPoint.current = null;
          // Same one-shot listener as applyEdit: read the markdown cell only
          // after Lexical's deferred commit has refreshed it.
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });
          // Restore the caret, then insertMarkdown$ imports the image at
          // $getSelection() (dist/plugins/core/index.js:158-181) — it does not
          // need DOM focus, which the panel's textarea has taken.
          editor.update(() => {
            $setSelection(saved.clone());
          });
          editorRef.current?.insertMarkdown(markdown);
        }),
      replaceImageSrc: (oldUrl, newUrl, nodeKey) =>
        new Promise<string>((resolve) => {
          const editor = activeEditorRef.current;
          if (!editor) {
            resolve(editorRef.current?.getMarkdown() ?? "");
            return;
          }
          let changed = false;
          const unregister = editor.registerUpdateListener(() => {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          });
          editor.update(() => {
            if (nodeKey !== undefined) {
              // Scoped update (Task 7's per-image toolbar always has its own
              // node's key): touch only THIS node, even if other nodes in the
              // document share `oldUrl` (e.g. the image was copy/pasted
              // elsewhere in the body) — an unscoped URL match would silently
              // mutate every occurrence instead of just the one the user acted
              // on.
              const node = $getNodeByKey(nodeKey);
              if (node instanceof ImageNode) {
                node.setSrc(newUrl);
                changed = true;
              }
            } else {
              // No node identified: fall back to the original URL-match-all
              // behavior, unchanged, for backward compatibility.
              for (const node of $nodesOfType(ImageNode)) {
                if (node.getSrc() === oldUrl) {
                  node.setSrc(newUrl);
                  changed = true;
                }
              }
            }
          });
          // No node matched → Lexical skips the commit and the listener would
          // never fire; resolve now with the (unchanged) body instead of
          // hanging the caller. `editor.update` runs its callback synchronously
          // when called outside another update, so `changed` is settled here.
          if (!changed) {
            unregister();
            resolve(editorRef.current?.getMarkdown() ?? "");
          }
        }),
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
      title="Ask for changes to the selection"
      aria-label="Ask for changes to the selection"
      onClick={() => openSelectionEdit()}
      className="ml-1 flex items-center gap-1 rounded border-l border-border/60 py-0.5 pl-2 pr-1.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Sparkles className="size-4" />
    </button>
  );
}

/** "Extract as a separate update" button in the selection popover — splits the
 * highlighted text into a draft of its own. The surface's
 * onMouseDown={preserveSelection} keeps the selection alive through the click,
 * so captureSelection (inside openExtract) still sees it. */
function ExtractSelectionButton() {
  const { openExtract } = useAgentEdit();
  return (
    <button
      type="button"
      title="Extract as a separate update"
      aria-label="Extract as a separate update"
      onClick={() => {
        if (!openExtract()) toast.error("Highlight some text to extract first.");
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Split className="size-4" />
    </button>
  );
}

export default function MdxEditor({
  markdown,
  onChange,
  contentPieceId,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  contentPieceId: string;
}) {
  // The bridges need this ref, and they're built here rather than inside the
  // shared editor, so ownership of the ref sits here too.
  const editorRef = useRef<MDXEditorMethods>(null);

  // Drag-drop / paste / file-tab uploads (spec §5): post the file to the
  // upload action and hand the plugin the blob URL to insert. Throwing makes
  // the plugin abandon the insert (it catches and logs); the toast is ours.
  const imageUploadHandler = useCallback(
    async (file: File) => {
      const fd = new FormData();
      fd.set("contentPieceId", contentPieceId);
      fd.set("role", "body");
      fd.set("file", file);
      const result = await uploadImageFile(fd);
      if (!result.ok) {
        toast.error(result.error);
        throw new Error(result.error);
      }
      return result.url;
    },
    [contentPieceId]
  );

  return (
    <DraftImageProvider contentPieceId={contentPieceId}>
      <SharedMdxEditor
        markdown={markdown}
        onChange={onChange}
        editorRef={editorRef}
        parseErrorHint="Switch to Source mode (the Source button in the action row) to view and edit the raw Markdown safely."
        realmChildren={
          <>
            <ViewModeBridge />
            <AgentEditBridge editorRef={editorRef} />
          </>
        }
        selectionExtras={
          <>
            <AskAiSelectionButton />
            <ExtractSelectionButton />
          </>
        }
        insertExtras={<GenerateImageButton contentPieceId={contentPieceId} />}
        imageToolbar={ImageEditToolbar}
        imageUploadHandler={imageUploadHandler}
      />
    </DraftImageProvider>
  );
}
