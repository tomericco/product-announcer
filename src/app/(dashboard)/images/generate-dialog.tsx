"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { generateLibraryImage } from "./actions";

/** "Generate new" (spec §5b): a standalone concept → render into the library. */
export function GenerateDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  async function generate() {
    const concept = prompt.trim();
    if (!concept) return;
    setBusy(true);
    try {
      const result = await generateLibraryImage({ prompt: concept, concept });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Image generated");
      setPrompt("");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger render={<Button />}>
        <Sparkles className="size-4" /> Generate new
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Generate an image</DialogTitle>
          <DialogDescription>Describe what it shows; your brand&apos;s visual identity decides how it looks. It lands in the library, ready to reuse in any draft.</DialogDescription>
        </DialogHeader>
        {busy ? (
          <div className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Generating image…
          </div>
        ) : (
          <Textarea
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A compass resting on an unfolded map"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void generate();
            }}
          />
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={busy} />}>Cancel</DialogClose>
          <Button onClick={() => void generate()} disabled={busy || !prompt.trim()}>
            {busy ? "Working…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
