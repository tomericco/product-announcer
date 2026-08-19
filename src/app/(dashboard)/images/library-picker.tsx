"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listImagesForPicker, type PickerImage } from "./actions";

/**
 * "From library" (spec §5b): pick any existing image — library, or any
 * piece's — to reuse. Reuse inserts the existing blob URL; no new render.
 *
 * `forCover` (spec §5b open question, resolved as option (a)): when the
 * picker is opened from the cover slot, it only offers renders that are
 * already cover-shaped (1200×630) — reuse pastes the existing blob with no
 * new render, so a body-shaped (4:3) pick would ship distorted/cropped into
 * LinkedIn and OG, which product owner decision 1 forbids us to fix by
 * cropping ourselves. The insert-panel entry point (body images) leaves this
 * unset and sees every library image, cover-shaped or not.
 */
export function LibraryPicker({
  open,
  onOpenChange,
  onPick,
  forCover = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (image: PickerImage) => void | Promise<void>;
  forCover?: boolean;
}) {
  const [images, setImages] = useState<PickerImage[] | null>(null);
  const [busy, setBusy] = useState(false);

  // "Adjusting state when a prop changes" (react.dev), done during render
  // rather than in the effect below: clearing stale results back to the
  // loading state the instant the dialog re-opens needs to happen
  // synchronously with `open` flipping. Tracked with `useState` (not
  // `useRef` — this project's stricter react-hooks/refs rule forbids reading
  // or writing a ref during render) holding the previous `open` value, which
  // is the sanctioned variant of this pattern. Calling `setImages` here, not
  // as the first line of the effect below, is what keeps
  // react-hooks/set-state-in-effect from flagging it as a cascading render.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setImages(null);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listImagesForPicker(forCover ? { role: "cover" } : {})
      .then((rows) => !cancelled && setImages(rows))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Couldn't load the library"));
    return () => {
      cancelled = true;
    };
  }, [open, forCover]);

  async function pick(image: PickerImage) {
    setBusy(true);
    try {
      await onPick(image);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>From library</DialogTitle>
          <DialogDescription>
            {forCover
              ? "Reuse a cover-shaped image you already have — it's inserted as-is, nothing new is generated."
              : "Reuse an image you already have — it's inserted as-is, nothing new is generated."}
          </DialogDescription>
        </DialogHeader>
        {images === null || busy ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {busy ? "Adding…" : "Loading…"}
          </div>
        ) : images.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {forCover ? "No cover-shaped images yet." : "No images yet."}
          </p>
        ) : (
          <ul className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-y-auto sm:grid-cols-4">
            {images.map((image) => (
              <li key={image.imageId}>
                <button type="button" className="block w-full space-y-1 rounded-md border p-1.5 text-left hover:bg-muted/50" onClick={() => void pick(image)}>
                  <div className="relative aspect-[4/3] overflow-hidden rounded bg-muted">
                    <Image src={image.url} alt="" fill sizes="20vw" className="object-cover" />
                  </div>
                  <p className="line-clamp-2 text-xs">{image.concept || "Untitled"}</p>
                  {image.pieceTitle && <p className="truncate text-[0.7rem] text-muted-foreground">{image.pieceTitle}</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
