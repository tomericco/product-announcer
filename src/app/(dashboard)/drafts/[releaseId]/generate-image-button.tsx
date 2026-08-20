"use client";

import { useState } from "react";
import { ImagePlus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { nearestHeadingAbove } from "@/lib/images/nearest-heading";
import { TooltipWrap } from "@mdxeditor/editor";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { saveDraftBody } from "./actions";
import { GenerateImagePanel } from "./generate-image-panel";

/**
 * "Generate image" in the insert surface, beside InsertImage (spec §5). The
 * surface preventDefaults mousedown, so the caret is still live in onClick:
 * capture it (and the heading above it) THEN open the panel, which takes
 * focus. The panel is rendered as a sibling here so it lives inside the
 * surface element — the hook that positions the surface keeps it open while
 * focus is inside it (mdx-editor.tsx useSelectionSurface).
 */
export function GenerateImageButton({
  contentPieceId,
  mode = "insert",
}: {
  contentPieceId: string;
  /**
   * `"insert"` — the insert surface (caret on an empty paragraph): the image
   * goes at the caret, and the prompt starts blank.
   * `"selection"` — the selection surface: the image goes AFTER the
   * highlighted text (never replacing it) and the panel opens already
   * suggesting a concept drawn from that text.
   */
  mode?: "insert" | "selection";
}) {
  const { ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [open, setOpen] = useState<{ heading: string | null; selectionMarkdown?: string } | null>(null);

  async function insert(markdown: string) {
    const editorOps = ops.current;
    if (!editorOps) throw new Error("The editor isn't ready yet — try again in a moment.");
    // From a selection the image gets its own paragraph after that block; from
    // the insert surface the caret already IS an empty block of its own.
    const body = await editorOps.insertAtCursor(markdown, { asNewBlockAfter: mode === "selection" });
    await saveDraftBody({ contentPieceId, body });
    notifySaved();
  }

  return (
    <>
      {/* The icon is whichever glyph its OWN neighbours don't already use.
          In the insert surface that's Sparkles: the built-in InsertImage
          frame icon sits one slot over, and two near-identical image icons
          would be indistinguishable, while Sparkles is this app's AI
          affordance (brand-style import, cover "Generate from post"). In the
          selection surface it's the reverse — Ask AI is the Sparkles there,
          so an image glyph is what reads as distinct. Either way the tooltip
          and aria-label carry the words.
          MDXEditor's own `TooltipWrap`, not one of this app's tooltips: it is
          what every built-in button in these surfaces already uses, so a
          custom button styled any other way would read as a foreign object
          sitting in the same row. It has to render inside the editor realm
          (it reads `editorRootElementRef$` for its portal target), which is
          exactly where the surfaces put `insertExtras`/`selectionExtras`. */}
      <TooltipWrap title={mode === "selection" ? "Generate an image from the selection" : "Generate image"}>
        <button
          type="button"
          aria-label={mode === "selection" ? "Generate an image from the selection" : "Generate image"}
          onClick={() => {
            const editorOps = ops.current;
            if (!editorOps) {
              toast.error("The editor isn't ready yet — try again in a moment.");
              return;
            }
            if (mode === "selection") {
              // Read the highlighted text BEFORE collapsing the insert point
              // — it is what the panel's suggestion is drawn from.
              const selectionMarkdown = editorOps.captureSelection();
              if (!selectionMarkdown.trim()) {
                toast.error("Highlight some text to base the image on first.");
                return;
              }
              editorOps.captureInsertPoint();
              setOpen({ heading: nearestHeadingAbove(), selectionMarkdown });
              return;
            }
            editorOps.captureInsertPoint();
            setOpen({ heading: nearestHeadingAbove() });
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          {mode === "selection" ? <ImagePlus className="size-4" /> : <Sparkles className="size-4" />}
        </button>
      </TooltipWrap>
      {open && (
        <GenerateImagePanel
          contentPieceId={contentPieceId}
          heading={open.heading}
          selectionMarkdown={open.selectionMarkdown}
          onInsert={insert}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
