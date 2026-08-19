"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ImageIcon, Images, Loader2, PencilLine, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LibraryPicker } from "../../images/library-picker";
import { generateCover, removeCover, setCoverFromImage, suggestImagePrompt, updateCoverAlt, uploadImageFile } from "./image-actions";

export type CoverState = { url: string; alt: string; concept: string; sourceKind: "generated" | "uploaded" } | null;

/**
 * The Notion-pattern cover above the title (spec §5 Cover). A per-piece
 * secondary artifact like linkedin-panel.tsx: generate / change / edit alt /
 * remove, backed by the role:"cover" content_images row — never derived from
 * the first body image. `promptSeed` is a failed agent cover's concept, so
 * "Write a prompt" reopens with what the agent meant to draw (spec §4).
 */
export function CoverPanel({
  contentPieceId,
  initial,
  promptSeed,
}: {
  contentPieceId: string;
  initial: CoverState;
  promptSeed: string;
}) {
  const router = useRouter();
  const [cover, setCover] = useState<CoverState>(initial);
  const [busy, setBusy] = useState<string | null>(null); // label of the in-flight step
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [altOpen, setAltOpen] = useState(false);
  const [altDraft, setAltDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function run(label: string, action: () => Promise<{ ok: true; url: string } | { ok: false; error: string }>, next: (url: string) => CoverState) {
    setBusy(label);
    try {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error);
        return false;
      }
      setCover(next(result.url));
      router.refresh();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
      return false;
    } finally {
      setBusy(null);
    }
  }

  function generateFromPost() {
    void run("Generating cover from the post…", () => generateCover({ contentPieceId, mode: "from_post" }), (url) => ({
      url,
      alt: "",
      concept: "",
      sourceKind: "generated",
    }));
  }

  async function openPrompt() {
    setPromptOpen(true);
    // Never empty (spec §5): the previous concept, then a failed agent
    // cover's concept (spec §4), then an auto-drafted suggestion.
    const seed = cover?.concept || promptSeed;
    if (seed) {
      setPrompt(seed);
      return;
    }
    setSuggesting(true);
    try {
      const out = await suggestImagePrompt({ contentPieceId, surroundingMarkdown: "", role: "cover" });
      setPrompt((current) => current || out.concept);
    } catch {
      // Leave the field empty; the user can still type.
    } finally {
      setSuggesting(false);
    }
  }

  function generateFromPrompt() {
    const concept = prompt.trim();
    if (!concept) return;
    void run("Generating cover…", () => generateCover({ contentPieceId, mode: "prompt", prompt: concept }), (url) => ({
      url,
      alt: "",
      concept,
      sourceKind: "generated",
    })).then((ok) => ok && setPromptOpen(false));
  }

  function upload(file: File) {
    const fd = new FormData();
    fd.set("contentPieceId", contentPieceId);
    fd.set("role", "cover");
    fd.set("file", file);
    void run("Uploading…", () => uploadImageFile(fd), (url) => ({ url, alt: "", concept: "", sourceKind: "uploaded" }));
  }

  async function remove() {
    setBusy("Removing…");
    try {
      await removeCover({ contentPieceId });
      setCover(null);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function saveAlt() {
    if (!cover) return;
    const result = await updateCoverAlt({ contentPieceId, altText: altDraft });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setCover({ ...cover, alt: altDraft.trim() });
    setAltOpen(false);
  }

  const menu = (trigger: React.ReactElement) => (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={generateFromPost}>
          <Sparkles /> Generate from post
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void openPrompt()}>
          <PencilLine /> Write a prompt
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => fileInput.current?.click()}>
          <Upload /> Upload
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setPickerOpen(true)}>
          <Images /> From library
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <section aria-label="Cover image" className="space-y-2">
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload(file);
        }}
      />

      {busy ? (
        <div className="flex aspect-[1200/630] w-full items-center justify-center gap-3 rounded-lg border bg-muted/30 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {busy}
        </div>
      ) : cover ? (
        <div className="group relative overflow-hidden rounded-lg border">
          <Image src={cover.url} alt={cover.alt} width={1200} height={630} className="h-auto w-full" priority />
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            {menu(<Button type="button" size="sm" variant="secondary">Change</Button>)}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                setAltDraft(cover.alt);
                setAltOpen(true);
              }}
            >
              Alt text
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="size-3.5" /> Remove
            </Button>
          </div>
        </div>
      ) : (
        menu(
          <Button type="button" variant="ghost" className="dashed-outline h-auto w-full justify-center py-6 text-muted-foreground">
            <ImageIcon className="size-4" /> Add cover
          </Button>
        )
      )}

      <Dialog open={promptOpen} onOpenChange={(next) => !next && !busy && setPromptOpen(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-4" /> Cover prompt
            </DialogTitle>
            <DialogDescription>Describe what the cover shows. Style, colours and mood come from your brand&apos;s visual identity.</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={suggesting ? "Drafting a suggestion…" : "e.g. A lighthouse beam sweeping across a sea of documents"}
              disabled={suggesting}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generateFromPrompt();
              }}
            />
            {suggesting && <Loader2 className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button onClick={generateFromPrompt} disabled={suggesting || !prompt.trim()}>
              Generate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove deletes the row, its version history and its blobs — real
          data loss, so it gets the app's question-form destructive confirm
          (see board.tsx's "Delete this draft?"). */}
      <Dialog open={confirmRemove} onOpenChange={(next) => !next && !busy && setConfirmRemove(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this cover?</DialogTitle>
            <DialogDescription>
              The cover and its earlier versions will be deleted permanently. You can add a new one at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={busy !== null} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={busy !== null}
              onClick={() => {
                setConfirmRemove(false);
                void remove();
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The cover's alt is published to Webflow, LinkedIn and the webhook
          (Plan 4) and the cover is not in the markdown, so this dialog is its
          one edit path — spec §2 says alt is always human-editable. */}
      <Dialog open={altOpen} onOpenChange={(next) => !next && setAltOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cover alt text</DialogTitle>
            <DialogDescription>
              Describes the cover for screen readers and for the destinations it publishes to. One sentence, what it
              means — not how it looks. Leave empty for decorative.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            maxLength={125}
            value={altDraft}
            onChange={(e) => setAltDraft(e.target.value)}
            placeholder="e.g. A lighthouse beam sweeping over a grid of documents"
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveAlt();
            }}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button onClick={() => void saveAlt()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        forCover
        onPick={async (image) => {
          const ok = await run("Setting cover…", () => setCoverFromImage({ contentPieceId, imageId: image.imageId }), (url) => ({
            url,
            alt: "",
            concept: image.concept,
            sourceKind: "generated",
          }));
          if (!ok) throw new Error("Couldn't set the cover.");
        }}
      />
    </section>
  );
}
