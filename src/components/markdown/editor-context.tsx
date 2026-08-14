"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

export type EditorViewMode = "rich-text" | "source";

export type EditorBridge = {
  viewMode: EditorViewMode;
  setViewMode: (mode: EditorViewMode) => void;
} | null;

const EditorContext = createContext<{
  bridge: EditorBridge;
  setBridge: (bridge: EditorBridge) => void;
}>({ bridge: null, setBridge: () => {} });

/**
 * Lets a control outside the MDXEditor (the page action row) drive the editor's
 * view mode. The realm hooks only work inside `toolbarContents`, so a bridge
 * component in there registers the setter here.
 *
 * Lived at `drafts/[releaseId]/draft-editor-context.tsx` until the brief editor
 * needed the same thing. Nothing in it was ever draft-specific — it only knows
 * about MDXEditor's view mode — so it moved here rather than being copied, and
 * the drafts route now imports it from this module. `ViewModeBridge`, the
 * realm-side half that registers into this context, is deliberately in its own
 * module (`./view-mode-bridge`): it imports `@mdxeditor/editor` for real, and
 * this module is imported by Server Components that must not pull the editor
 * into their render.
 */
export function EditorProvider({ children }: { children: ReactNode }) {
  const [bridge, setBridge] = useState<EditorBridge>(null);
  return (
    <EditorContext.Provider value={{ bridge, setBridge }}>
      {children}
    </EditorContext.Provider>
  );
}

export function useEditorBridge() {
  return useContext(EditorContext);
}

/** Renders nothing until the editor has mounted and registered its bridge. */
export function SourceToggleButton() {
  const { bridge } = useEditorBridge();
  if (!bridge) return null;
  const isSource = bridge.viewMode === "source";
  return (
    <button
      type="button"
      onClick={() => bridge.setViewMode(isSource ? "rich-text" : "source")}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
      aria-pressed={isSource}
    >
      {isSource ? "Show rich text" : "Show source"}
    </button>
  );
}
