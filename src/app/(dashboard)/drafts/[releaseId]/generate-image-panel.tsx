"use client";

import { useEffect, useRef, useState } from "react";
import { Images, Loader2, Sparkles, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LibraryPicker } from "../../images/library-picker";
import { useAgentEdit } from "./agent-edit-context";
import { generateBodyImage, insertImageFromLibrary, suggestImagePrompt } from "./image-actions";

/**
 * The in-canvas "Generate image" block (spec §5 Inserting): a prompt field,
 * a brand-style note, Suggest prompt, Generate. Rendered INSIDE the insert
 * surface by GenerateImageButton — see that file for why that placement is
 * what keeps it open while the textarea has focus.
 */
export function GenerateImagePanel({
  contentPieceId,
  heading,
  selectionMarkdown,
  onInsert,
  onClose,
}: {
  contentPieceId: string;
  /** Nearest heading above the caret at open time, for Suggest prompt. */
  heading: string | null;
  /**
   * Set when opened from the SELECTION surface: the highlighted markdown the
   * image should depict. It becomes the source `suggestImagePrompt` reads
   * instead of the whole body. Nothing runs on open — suggesting costs a
   * model call and several seconds, and a prompt that rewrites itself under
   * the cursor is worse than an empty box.
   */
  selectionMarkdown?: string;
  /** Splices the returned markdown at the captured caret and persists. */
  onInsert: (markdown: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ops } = useAgentEdit();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"idle" | "suggesting">("idle");
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  async function suggest() {
    setBusy("suggesting");
    try {
      const out = await suggestImagePrompt({
        contentPieceId,
        // The selection when there is one, else the whole body — either way
        // this is what the concept gets drawn from.
        surroundingMarkdown: selectionMarkdown ?? ops.current?.getMarkdown() ?? "",
        // No heading alongside a selection: the server slices its source
        // down to the named heading's section, and the user has already said
        // precisely which text they mean. (It would fall back to the whole
        // string anyway whenever the heading sits above the selection rather
        // than inside it — but relying on that would make "was the heading
        // caught in the selection?" silently change the result.)
        heading: selectionMarkdown ? null : heading,
      });
      setPrompt(out.concept);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't suggest a prompt");
    } finally {
      setBusy("idle");
    }
  }

  async function generate() {
    const trimmed = prompt.trim();
    // With a selection the passage itself is the brief, so an empty box is a
    // valid ask; without one there is nothing to render from.
    if (!trimmed && !selectionMarkdown) return;
    // Close first and let a page-level toast carry the ~20s wait: the panel
    // is anchored to a floating surface that any click or caret move
    // dismisses anyway, so keeping it on screen would both block the draft
    // and be fragile. Everything below survives the unmount — the closure
    // holds its own state, and the insert point lives in the editor bridge's
    // ref, not in this component.
    onClose();
    const toastId = toast.loading("Generating image…");
    try {
      const result = await generateBodyImage({ contentPieceId, prompt: trimmed, selection: selectionMarkdown });
      if (!result.ok) {
        toast.error(result.error, { id: toastId });
        return;
      }
      await onInsert(result.markdown);
      toast.success("Image added", { id: toastId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong", { id: toastId });
    }
  }

  return (
    <div
      className="mdx-surface-panel w-96 space-y-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md"
      // The surface's onMouseDown preventDefault would stop the textarea from
      // taking focus; stop it here so clicks inside the panel behave normally.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Esc closes. Generating closes the panel itself and reports through
        // a page-level toast, so there is no in-panel progress state left for
        // Esc to interrupt.
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
      }}
    >
      <div className="flex items-center gap-2 font-medium">
        <Sparkles className="size-4" /> Generate image
      </div>
      <Textarea
        ref={textareaRef}
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={
          busy === "suggesting"
            ? "Reading the selection…"
            : selectionMarkdown
              ? "Optional — anything to steer it away from the default reading of the passage"
              : "What should the image show? e.g. A magnifying glass over a grid of documents"
        }
        disabled={busy !== "idle"}
      />
      <p className="text-xs text-muted-foreground">
        {selectionMarkdown
          ? "Draws on the highlighted text and the post title. Matches your brand style."
          : "Matches your brand style — you describe what, not how it looks."}
      </p>
      {/* Two rows, not one: all four buttons side by side overflow the
          panel's own width and push Generate outside it. The two ways of
          FILLING the prompt sit together on top; the two that close the
          panel sit together below. */}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => void suggest()} disabled={busy !== "idle"}>
          {busy === "suggesting" ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
          Suggest prompt
        </Button>
        <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setPickerOpen(true)} disabled={busy !== "idle"}>
          <Images className="size-3.5" /> From library
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy !== "idle"}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void generate()}
          disabled={busy !== "idle" || (!prompt.trim() && !selectionMarkdown)}
        >
          Generate
        </Button>
      </div>
      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (image) => {
          // Creates a real content_images row sharing the picked blob (Finding
          // I2) rather than inserting the raw URL — throwing on failure (not a
          // local toast) keeps the picker dialog open, same contract as
          // cover-panel.tsx's own "From library" handler.
          const result = await insertImageFromLibrary({ contentPieceId, imageId: image.imageId });
          if (!result.ok) throw new Error(result.error);
          await onInsert(result.markdown);
          toast.success("Image added");
          onClose();
        }}
      />
    </div>
  );
}
