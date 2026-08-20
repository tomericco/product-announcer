"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PencilLine, RefreshCw, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { lookupImageById, regenerateImage, restoreRender, type ImageLookup } from "../drafts/[releaseId]/image-actions";
import { deleteLibraryImage } from "./actions";
import type { LibraryImage } from "./image-card";

type View = "menu" | "prompt" | "edit" | "confirmDelete";

/**
 * Detail view (spec §5b): the render history strip and the same three edit
 * actions as the editor, by imageId. For an image sitting in a draft, the
 * server actions swap the URL in the stored body themselves (Task 4), so
 * this view needs no editor bridge.
 */
export function ImageDetail({ image, onClose }: { image: LibraryImage | null; onClose: () => void }) {
  const router = useRouter();
  // `key={image.id}` on this component (see ImageGrid in image-card.tsx)
  // remounts it whenever the selected image changes, so these initial values
  // are already correct for the newly-selected image — no synchronous
  // setState-in-effect reset is needed (and the lint rule
  // react-hooks/set-state-in-effect flags exactly that pattern). The effect
  // below is left with only the one thing that actually needs it: the async
  // lookup.
  const [lookup, setLookup] = useState<ImageLookup | null>(null);
  const [current, setCurrent] = useState<string | null>(image?.url ?? null);
  const [view, setView] = useState<View>("menu");
  const [prompt, setPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // By id (Finding I3), not `lookupImageBySrc(image.url)`: the url-keyed
    // lookup is ambiguous once two rows can share a blob (setCoverFromImage,
    // and "From library" body inserts, both do this on purpose), and this
    // page already has the real row id from its own listing.
    if (!image) return;
    let cancelled = false;
    void lookupImageById(image.id).then((found) => {
      if (cancelled) return;
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [image]);

  if (!image) return <Dialog open={false} />;

  const generated = image.sourceKind === "generated";

  async function run(action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, success: string) {
    if (!image) return;
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setCurrent(result.url);
      const found = await lookupImageById(image.id);
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
      setView("menu");
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!image) return;
    setBusy(true);
    try {
      const result = await deleteLibraryImage(image.id);
      if (!result.ok) {
        toast.error(result.reason === "published" ? "This image is used by a published piece and can't be deleted." : "Couldn't delete this image.");
        return;
      }
      toast.success("Image deleted");
      onClose();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  // Always the real row id (Finding I3) — this page already knows it from
  // its own listing, so it never needs to fall back through `lookup`.
  const imageId = image.id;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{image.concept || "Untitled image"}</DialogTitle>
          <DialogDescription>
            {image.usages.length > 0 ? (
              <>
                Used in{" "}
                {image.usages.map((usage, i) => (
                  <span key={usage.pieceId}>
                    {i > 0 && (i === image.usages.length - 1 ? " and " : ", ")}
                    <Link href={`/drafts/${usage.pieceId}`} className="underline">
                      {usage.pieceTitle}
                    </Link>
                  </span>
                ))}
                {" · "}
              </>
            ) : null}
            {image.sourceKind === "uploaded" ? "Uploaded" : "Generated"} · {image.role}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[1fr_16rem]">
          <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
            {busy ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Working…
              </div>
            ) : current ? (
              <Image src={current} alt={image.altText} fill sizes="(min-width: 640px) 60vw, 100vw" className="object-contain" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No image yet</div>
            )}
          </div>

          <div className="space-y-3 text-sm">
            {generated && view === "menu" && (
              <div className="space-y-1">
                <Button type="button" variant="outline" className="w-full justify-start" disabled={busy || !current} onClick={() => setView("prompt")}>
                  <PencilLine className="size-4" /> Edit prompt
                </Button>
                <Button type="button" variant="outline" className="w-full justify-start" disabled={busy || !current} onClick={() => setView("edit")}>
                  <WandSparkles className="size-4" /> Describe a change
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={busy || !current}
                  onClick={() => void run(() => regenerateImage({ imageId, mode: "same" }), "Image regenerated")}
                >
                  <RefreshCw className="size-4" /> Regenerate
                </Button>
              </div>
            )}
            {generated && view === "prompt" && (
              <div className="space-y-2">
                <Textarea rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-xs" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>Back</Button>
                  <Button type="button" size="sm" disabled={busy || !prompt.trim()} onClick={() => void run(() => regenerateImage({ imageId, mode: "prompt", prompt }), "Image regenerated")}>
                    Regenerate
                  </Button>
                </div>
              </div>
            )}
            {generated && view === "edit" && (
              <div className="space-y-2">
                <Input autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. remove the third figure" />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>Back</Button>
                  <Button type="button" size="sm" disabled={busy || !instruction.trim()} onClick={() => void run(() => regenerateImage({ imageId, mode: "edit", instruction }), "Change applied")}>
                    Apply
                  </Button>
                </div>
              </div>
            )}

            {lookup && lookup.renders.length > 1 && (
              <div className="space-y-1 border-t pt-3">
                <p className="text-xs text-muted-foreground">History</p>
                <div className="flex flex-wrap gap-1.5">
                  {lookup.renders.map((r) => {
                    const isCurrent = r.id === lookup.currentRenderId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        disabled={isCurrent || busy}
                        title={isCurrent ? "Current version" : "Restore this version"}
                        aria-label={isCurrent ? "Current version" : "Restore this version"}
                        aria-current={isCurrent || undefined}
                        className={`relative size-14 overflow-hidden rounded border ${isCurrent ? "ring-2 ring-primary" : "hover:opacity-80"}`}
                        onClick={() => void run(() => restoreRender({ imageId, renderId: r.id }), "Earlier version restored")}
                      >
                        <Image src={r.url} alt="" fill sizes="56px" className="object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="border-t pt-3">
              {image.piecePublished ? (
                <p className="text-xs text-muted-foreground">Used by a published piece — it can&apos;t be deleted while that page may still link to it.</p>
              ) : view === "confirmDelete" ? (
                <div className="space-y-2">
                  <p className="text-xs">
                    Delete this image and its earlier versions? This can&apos;t be undone.
                    {image.role === "cover" && image.pieceTitle
                      ? ` It is the cover of “${image.pieceTitle}” — that draft will lose its cover.`
                      : image.pieceTitle
                        ? ` It is used in “${image.pieceTitle}” — it will be removed from that draft too.`
                        : ""}
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setView("menu")}>Cancel</Button>
                    <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
                      {busy ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => setView("confirmDelete")}>
                  <Trash2 className="size-4" /> Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
