"use client";

import { useState } from "react";
import { MoreHorizontal, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { publishDraft, deleteDraft } from "./actions";

type Props = {
  releaseId: string;
  title: string;
  /** Commits batched into this draft; named in the delete confirmation. */
  sourceItemCount: number;
  /**
   * published_at as rendered by this page load — always null/"" here since
   * this list only ever shows drafts, but threaded through rather than
   * hardcoded so publishDraft's compare-and-swap guard stays the same
   * mechanism as approveDraft's, not a special case.
   */
  publishedAt: string | null;
};

type Confirming = "publish" | "delete" | null;

export function DraftRowMenu({ releaseId, title, sourceItemCount, publishedAt }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [submitting, setSubmitting] = useState(false);

  async function run(action: (formData: FormData) => Promise<void>, success: string) {
    setSubmitting(true);
    const formData = new FormData();
    formData.set("releaseId", releaseId);
    formData.set("publishedAt", publishedAt ?? "");
    try {
      await action(formData);
      setConfirming(null);
      toast.success(success);
    } catch (error) {
      // Server actions reject with an opaque digest in production; surface what
      // we can rather than leaving the dialog silently stuck.
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const commits = `${sourceItemCount} ${sourceItemCount === 1 ? "commit" : "commits"}`;

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${title}`}
              // Hover-revealed, but kept visible while the menu is open and on
              // keyboard focus so the action isn't pointer-only.
              className="size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => setConfirming("publish")}>
            <Send />
            Publish
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming("delete")}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={confirming === "publish"}
        onOpenChange={(next) => !next && !submitting && setConfirming(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish this update?</DialogTitle>
            <DialogDescription>
              “{title}” will be published as written and sent to your changelog webhook. Sending
              can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={submitting} />}>Cancel</DialogClose>
            <Button onClick={() => run(publishDraft, "Update published")} disabled={submitting}>
              {submitting ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming === "delete"}
        onOpenChange={(next) => !next && !submitting && setConfirming(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              “{title}” will be deleted permanently. Its {commits} return to Pending, so they can go
              into a future update.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={submitting} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => run(deleteDraft, "Draft deleted")}
              disabled={submitting}
            >
              {submitting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
