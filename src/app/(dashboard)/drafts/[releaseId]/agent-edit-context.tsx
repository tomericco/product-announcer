"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

export type AgentEditMode = "selection" | "whole";

/**
 * Which modal is open. `applyEdit` still takes only `AgentEditMode` — extract
 * never routes through it — so the two types stay separate on purpose.
 */
export type DialogMode = AgentEditMode | "extract";

/**
 * Imperative editor operations the modal needs, registered by a bridge that
 * lives inside the MDXEditor realm (only there can it reach the Lexical editor
 * and the editor's imperative ref).
 */
export type EditorOps = {
  /** Snapshots the current selection for later restore and returns the
   * highlighted excerpt as Markdown ("" if nothing is selected). */
  captureSelection: () => string;
  /**
   * Applies the edit — a surgical splice for `"selection"`, a full-body
   * replace for `"whole"` — and resolves with the editor's authoritative full
   * Markdown AFTER Lexical commits. `getMarkdown()` is stale synchronously
   * because Lexical defers its commit (which refreshes the markdown cell) to a
   * microtask, so callers must await this rather than read back immediately.
   */
  applyEdit: (mode: AgentEditMode, markdown: string) => Promise<string>;
  /**
   * Deletes the captured selection from the document and resolves with the
   * editor's authoritative full Markdown AFTER Lexical commits. Same deferred-
   * commit caveat as `applyEdit`: a synchronous `getMarkdown()` would return
   * the pre-deletion body.
   */
  removeSelection: () => Promise<string>;
  /** The current full editor body as Markdown. */
  getMarkdown: () => string;
  /**
   * Snapshots the caret for a later `insertAtCursor`. Called from the insert
   * surface's Generate-image button (whose surface `preventDefault`s mousedown,
   * so the caret is still live) before the panel takes focus.
   */
  captureInsertPoint: () => void;
  /**
   * Restores the captured caret and inserts markdown there; resolves with the
   * editor's authoritative body AFTER Lexical commits (same deferred-commit
   * caveat as `applyEdit`). Resolves with the unchanged body when nothing was
   * captured. If the captured point was a non-collapsed selection rather than
   * a caret, the insert replaces that selection's content — the same
   * behavior `applyEdit` has for `"selection"` mode, not a point insert.
   */
  insertAtCursor: (markdown: string) => Promise<string>;
  /**
   * Points every image node whose src is `oldUrl` at `newUrl` — the render
   * history's restore/regenerate swap (spec §5) — and resolves with the body
   * after commit. Node-level, not setMarkdown: setMarkdown mutes onChange
   * (see the whole-update comment in AgentEditBridge), which would leave
   * DraftBodyEditor's hidden input stale.
   */
  replaceImageSrc: (oldUrl: string, newUrl: string) => Promise<string>;
};

type AgentEditState = { mode: DialogMode; excerpt: string };

type AgentEditContextValue = {
  ops: MutableRefObject<EditorOps | null>;
  registerOps: (ops: EditorOps | null) => void;
  state: AgentEditState | null;
  openSelectionEdit: () => void;
  openWholeEdit: () => void;
  openExtract: () => boolean;
  close: () => void;
};

const AgentEditContext = createContext<AgentEditContextValue | null>(null);

/**
 * Coordinates the two "Ask AI" entry points and the shared modal. `ops` is a
 * ref (not state) because the editor registers it asynchronously after mount
 * and a ref update must not force the action-row button to re-render.
 */
export function AgentEditProvider({ children }: { children: ReactNode }) {
  const ops = useRef<EditorOps | null>(null);
  const [state, setState] = useState<AgentEditState | null>(null);

  const registerOps = useCallback((next: EditorOps | null) => {
    ops.current = next;
  }, []);

  const openSelectionEdit = useCallback(() => {
    // Snapshot the selection now, while it is still alive, before the modal
    // steals focus.
    const excerpt = ops.current?.captureSelection() ?? "";
    setState({ mode: "selection", excerpt });
  }, []);

  const openWholeEdit = useCallback(() => setState({ mode: "whole", excerpt: "" }), []);

  /**
   * Opens the extract modal, snapshotting the selection first (the modal steals
   * focus). Returns false — and opens nothing — when the selection is empty or
   * whitespace, so the caller can say why.
   */
  const openExtract = useCallback(() => {
    const excerpt = ops.current?.captureSelection() ?? "";
    if (excerpt.trim().length === 0) return false;
    setState({ mode: "extract", excerpt });
    return true;
  }, []);

  const close = useCallback(() => setState(null), []);

  return (
    <AgentEditContext.Provider
      value={{ ops, registerOps, state, openSelectionEdit, openWholeEdit, openExtract, close }}
    >
      {children}
    </AgentEditContext.Provider>
  );
}

export function useAgentEdit() {
  const ctx = useContext(AgentEditContext);
  if (!ctx) throw new Error("useAgentEdit must be used within an AgentEditProvider");
  return ctx;
}
