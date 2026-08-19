"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * MDXEditor instantiates the per-image toolbar itself (imagePlugin's
 * EditImageToolbar), so it can't take props from our wrapper. React context
 * flows through the plugin's render tree (decorators are portals, which keep
 * context), so this is how the toolbar learns which piece it edits.
 */
const DraftImageContext = createContext<{ contentPieceId: string } | null>(null);

export function DraftImageProvider({ contentPieceId, children }: { contentPieceId: string; children: ReactNode }) {
  return <DraftImageContext.Provider value={{ contentPieceId }}>{children}</DraftImageContext.Provider>;
}

export function useDraftImage() {
  const ctx = useContext(DraftImageContext);
  if (!ctx) throw new Error("useDraftImage must be used within a DraftImageProvider");
  return ctx;
}
