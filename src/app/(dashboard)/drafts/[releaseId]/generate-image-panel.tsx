"use client";

import { useEffect, useRef, useState } from "react";
import { Images, Loader2, Sparkles, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { LibraryPicker } from "../../images/library-picker";
import { useAgentEdit } from "./agent-edit-context";
import { generateBodyImage, suggestImagePrompt } from "./image-actions";

/**
 * The in-canvas "Generate image" block (spec §5 Inserting): a prompt field,
 * a brand-style note, Suggest prompt, Generate. Rendered INSIDE the insert
 * surface by GenerateImageButton — see that file for why that placement is
 * what keeps it open while the textarea has focus.
 */
export function GenerateImagePanel({
  contentPieceId,
  heading,
  onInsert,
  onClose,
}: {
  contentPieceId: string;
  /** Nearest heading above the caret at open time, for Suggest prompt. */
  heading: string | null;
  /** Splices the returned markdown at the captured caret and persists. */
  onInsert: (markdown: string) => Promise<void>;
  onClose: () => void;
}) {
  const { ops } = useAgentEdit();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"idle" | "suggesting" | "generating">("idle");
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
        surroundingMarkdown: ops.current?.getMarkdown() ?? "",
        heading,
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
    if (!trimmed) return;
    setBusy("generating");
    try {
      const result = await generateBodyImage({ contentPieceId, prompt: trimmed });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await onInsert(result.markdown);
      toast.success("Image added");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div
      className="mdx-surface-panel w-96 space-y-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-md"
      // The surface's onMouseDown preventDefault would stop the textarea from
      // taking focus; stop it here so clicks inside the panel behave normally.
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Esc always closes — while generating, closing does NOT cancel the
        // render (the closure below finishes the insert + save on its own),
        // the same "closing won't stop it" contract as GenerationModal.
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
      }}
    >
      {busy === "generating" ? (
        <div className="space-y-2 py-2">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating image…
          </div>
          <p className="text-xs text-muted-foreground">
            Takes ~20 seconds. Closing won&apos;t stop it — the image appears at your cursor when it&apos;s ready.
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 font-medium">
            <Sparkles className="size-4" /> Generate image
          </div>
          <Textarea
            ref={textareaRef}
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the image show? e.g. A magnifying glass over a grid of documents"
            disabled={busy !== "idle"}
          />
          <p className="text-xs text-muted-foreground">Matches your brand style — you describe what, not how it looks.</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void suggest()} disabled={busy !== "idle"}>
              {busy === "suggesting" ? <Loader2 className="size-3.5 animate-spin" /> : <WandSparkles className="size-3.5" />}
              Suggest prompt
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)} disabled={busy !== "idle"}>
              <Images className="size-3.5" /> From library
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy !== "idle"}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => void generate()} disabled={busy !== "idle" || !prompt.trim()}>
                Generate
              </Button>
            </div>
          </div>
        </>
      )}
      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={async (image) => {
          await onInsert(`![${image.concept.replace(/[[\]]/g, "")}](${image.url})`);
          toast.success("Image added");
          onClose();
        }}
      />
    </div>
  );
}
