"use client";

import { useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey } from "lexical";
import {
  openEditImageDialog$,
  parseImageDimension,
  readOnly$,
  useCellValue,
  usePublisher,
} from "@mdxeditor/editor";
import { History, Loader2, PencilLine, RefreshCw, Settings2, Sparkles, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ImageEditToolbarProps } from "@/components/markdown/mdx-editor";
import { useUnsavedChanges } from "../../unsaved-changes";
import { useAgentEdit } from "./agent-edit-context";
import { useDraftImage } from "./draft-image-context";
import { saveDraftBody } from "./actions";
import { lookupImageBySrc, regenerateImage, restoreRender, type ImageLookup } from "./image-actions";

const ICON_BUTTON =
  "flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50";

/**
 * Replaces imagePlugin's default per-image toolbar. Keeps its two buttons
 * (delete, image settings — reproduced from
 * @mdxeditor/editor/dist/plugins/image/EditImageToolbar.js) and adds the
 * spec §5 image actions behind a popover, only for images whose src maps to
 * a generated content_images row.
 */
export function ImageEditToolbar({ nodeKey, imageSource, initialImagePath, title, alt, width, height }: ImageEditToolbarProps) {
  const [editor] = useLexicalComposerContext();
  const readOnly = useCellValue(readOnly$);
  const openEditImageDialog = usePublisher(openEditImageDialog$);

  return (
    <div
      className="absolute right-1 top-1 z-10 flex items-center gap-0.5 rounded-md border bg-background/95 p-0.5 shadow-sm"
      // Keep Lexical from treating clicks here as a click on the image
      // (which would select/deselect the node under the toolbar).
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ImageActionsPopover src={imageSource} nodeKey={nodeKey} />
      <button
        type="button"
        className={ICON_BUTTON}
        title="Image settings"
        aria-label="Image settings"
        disabled={readOnly}
        onClick={() =>
          openEditImageDialog({
            nodeKey,
            initialValues: {
              src: initialImagePath ?? imageSource,
              title,
              altText: alt,
              width: parseImageDimension(width),
              height: parseImageDimension(height),
            },
          })
        }
      >
        <Settings2 className="size-3.5" />
      </button>
      <button
        type="button"
        className={ICON_BUTTON}
        title="Delete image"
        aria-label="Delete image"
        disabled={readOnly}
        onClick={(e) => {
          e.preventDefault();
          editor.update(() => {
            $getNodeByKey(nodeKey)?.remove();
          });
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

type View = "menu" | "prompt" | "edit";

function ImageActionsPopover({ src, nodeKey }: { src: string; nodeKey: string }) {
  const { contentPieceId } = useDraftImage();
  const { ops } = useAgentEdit();
  const { notifySaved } = useUnsavedChanges();
  const [open, setOpen] = useState(false);
  const [lookup, setLookup] = useState<ImageLookup | null | "loading">("loading");
  const [view, setView] = useState<View>("menu");
  const [prompt, setPrompt] = useState("");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(url: string) {
    setLookup("loading");
    try {
      const found = await lookupImageBySrc(url);
      setLookup(found);
      setPrompt(found?.currentPrompt ?? "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't load this image");
      setLookup(null);
    }
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setView("menu");
      setInstruction("");
      void load(src);
    }
  }

  /** Swap the editor's image to the new render and persist — the shared tail of every action.
   *
   * `nodeKey` scopes the swap to THIS toolbar's own image node, not every
   * node in the document that happens to share `src` — see
   * `EditorOps.replaceImageSrc`'s doc comment in agent-edit-context.tsx for
   * why an unscoped, URL-only match would be wrong when an image is
   * duplicated in the document. */
  async function swapTo(url: string) {
    const editorOps = ops.current;
    if (!editorOps) throw new Error("The editor isn't ready yet — try again in a moment.");
    const body = await editorOps.replaceImageSrc(src, url, nodeKey);
    await saveDraftBody({ contentPieceId, body });
    notifySaved();
  }

  async function run(action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, success: string) {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      await swapTo(result.url);
      toast.success(success);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const generated = lookup !== "loading" && lookup !== null && lookup.sourceKind === "generated";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={<button type="button" className={ICON_BUTTON} title="Image actions" aria-label="Image actions" />}
      >
        <Sparkles className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onKeyDown={(e) => e.key === "Escape" && !busy && setOpen(false)}>
        {lookup === "loading" ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : lookup === null ? (
          <p className="text-muted-foreground">This image isn&apos;t one of yours — replace or remove it with the buttons beside this one.</p>
        ) : !generated ? (
          <p className="text-muted-foreground">This image was uploaded — replace or remove it with the buttons beside this one.</p>
        ) : busy ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating image…
          </div>
        ) : view === "prompt" ? (
          <div className="space-y-2">
            <p className="font-medium">Edit prompt</p>
            <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-xs" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!prompt.trim()}
                onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "prompt", prompt, skipBodyWrite: true }), "Image regenerated")}
              >
                Regenerate
              </Button>
            </div>
          </div>
        ) : view === "edit" ? (
          <div className="space-y-2">
            <p className="font-medium">Describe a change</p>
            <Input
              autoFocus
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. make the background darker"
              onKeyDown={(e) => {
                if (e.key === "Enter" && instruction.trim()) {
                  void run(() => regenerateImage({ imageId: lookup.imageId, mode: "edit", instruction, skipBodyWrite: true }), "Change applied");
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setView("menu")}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!instruction.trim()}
                onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "edit", instruction, skipBodyWrite: true }), "Change applied")}
              >
                Apply
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setView("prompt")}>
              <PencilLine className="size-4" /> Edit prompt
            </button>
            <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => setView("edit")}>
              <WandSparkles className="size-4" /> Describe a change
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted"
              onClick={() => void run(() => regenerateImage({ imageId: lookup.imageId, mode: "same", skipBodyWrite: true }), "Image regenerated")}
            >
              <RefreshCw className="size-4" /> Regenerate
            </button>
            {lookup.renders.length > 1 && (
              <div className="space-y-1 border-t pt-2">
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <History className="size-3.5" /> History
                </p>
                <div className="flex gap-1.5 overflow-x-auto">
                  {lookup.renders.map((r) => {
                    const current = r.id === lookup.currentRenderId;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        title={current ? "Current version" : "Restore this version"}
                        aria-label={current ? "Current version" : "Restore this version"}
                        aria-current={current || undefined}
                        disabled={current}
                        className={`relative shrink-0 overflow-hidden rounded border ${current ? "ring-2 ring-primary" : "hover:opacity-80"}`}
                        onClick={() => void run(() => restoreRender({ imageId: lookup.imageId, renderId: r.id, skipBodyWrite: true }), "Earlier version restored")}
                      >
                        {/* Thumbnails are the blob itself; a plain img keeps this component free of next/image's remotePatterns dependency inside the editor. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={r.url} alt="" className="h-12 w-16 object-cover" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
