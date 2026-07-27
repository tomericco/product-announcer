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
 * Imperative editor operations the modal needs, registered by a bridge that
 * lives inside the MDXEditor realm (only there can it reach the Lexical editor
 * and the editor's imperative ref).
 */
export type EditorOps = {
  /** Snapshots the current selection for later restore and returns the
   * highlighted excerpt as Markdown ("" if nothing is selected). */
  captureSelection: () => string;
  /** Replaces the snapshotted selection with `markdown` (surgical edit). */
  replaceSelection: (markdown: string) => void;
  /** Replaces the entire editor body with `markdown` (whole-update edit). */
  setBody: (markdown: string) => void;
  /** The current full editor body as Markdown. */
  getMarkdown: () => string;
};

type AgentEditState = { mode: AgentEditMode; excerpt: string };

type AgentEditContextValue = {
  ops: MutableRefObject<EditorOps | null>;
  registerOps: (ops: EditorOps | null) => void;
  state: AgentEditState | null;
  openSelectionEdit: () => void;
  openWholeEdit: () => void;
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
  const close = useCallback(() => setState(null), []);

  return (
    <AgentEditContext.Provider
      value={{ ops, registerOps, state, openSelectionEdit, openWholeEdit, close }}
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
