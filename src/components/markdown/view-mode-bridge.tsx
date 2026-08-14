"use client";

import { useEffect } from "react";
import { viewMode$, usePublisher, useCellValue } from "@mdxeditor/editor";
import { useEditorBridge } from "./editor-context";

/**
 * The realm-side half of `editor-context`: publishes the live MDXEditor view
 * mode (and its setter) into the context so `SourceToggleButton` — which
 * renders OUTSIDE the editor — can drive it. Must be rendered as one of
 * `MdxEditor`'s `realmChildren`; the realm hooks throw anywhere else.
 *
 * Its own module rather than part of `editor-context.tsx` because it imports
 * `@mdxeditor/editor` as a runtime value. The context module is imported by
 * Server Components (both editor pages) that deliberately keep the editor
 * behind a `ssr: false` dynamic import.
 */
export function ViewModeBridge() {
  const viewMode = useCellValue(viewMode$);
  const setViewMode = usePublisher(viewMode$);
  const { setBridge } = useEditorBridge();

  useEffect(() => {
    setBridge({
      viewMode: viewMode === "source" ? "source" : "rich-text",
      setViewMode,
    });
    return () => setBridge(null);
  }, [viewMode, setViewMode, setBridge]);

  return null;
}
