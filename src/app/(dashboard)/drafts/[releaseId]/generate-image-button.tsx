"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { nearestHeadingAbove } from "@/lib/images/nearest-heading";
import { HoverTooltip } from "@/components/ui/tooltip";
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
export function GenerateImageButton({ contentPieceId }: { contentPieceId: string }) {
  const { ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [open, setOpen] = useState<{ heading: string | null } | null>(null);

  async function insert(markdown: string) {
    const editorOps = ops.current;
    if (!editorOps) throw new Error("The editor isn't ready yet — try again in a moment.");
    const body = await editorOps.insertAtCursor(markdown);
    await saveDraftBody({ contentPieceId, body });
    notifySaved();
  }

  return (
    <>
      {/* Sparkles, not a second image glyph: the surface already has the
          built-in InsertImage frame icon one slot over, and two near-identical
          image icons would be indistinguishable. Sparkles is this app's AI
          affordance (Ask AI's selection button, brand-style import, cover
          "Generate from post"), so "sparkle beside the image icon" reads as
          "generate an image" — the tooltip and aria-label carry the words.
          HoverTooltip (components/ui/tooltip.tsx), not a plain
          Tooltip/TooltipTrigger — see its doc comment: the uncontrolled
          version opens on hover but never closes. */}
      <HoverTooltip content="Generate image">
        <button
          type="button"
          aria-label="Generate image"
          onClick={() => {
            const editorOps = ops.current;
            if (!editorOps) {
              toast.error("The editor isn't ready yet — try again in a moment.");
              return;
            }
            editorOps.captureInsertPoint();
            setOpen({ heading: nearestHeadingAbove() });
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Sparkles className="size-4" />
        </button>
      </HoverTooltip>
      {open && (
        <GenerateImagePanel
          contentPieceId={contentPieceId}
          heading={open.heading}
          onInsert={insert}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
