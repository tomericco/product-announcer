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
