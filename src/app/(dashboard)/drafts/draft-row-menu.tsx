"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { saveDraftBody } from "./[releaseId]/actions";
import { InvalidLinksDialog } from "./invalid-links-dialog";
import type { LinkProblem } from "@/lib/ai/validate-links";

type Props = {
  releaseId: string;
  title: string;
  /** Atomic updates composed into this draft; named in the delete confirmation. */
  atomicUpdateCount: number;
  /**
   * published_at as rendered by this page load — always null/"" here since
   * this list only ever shows drafts, but threaded through rather than
   * hardcoded so publishDraft's compare-and-swap guard stays the same
   * mechanism as approveDraft's, not a special case.
   */
  publishedAt: string | null;
};

type Confirming = "publish" | "delete" | null;

export function DraftRowMenu({ releaseId, title, atomicUpdateCount, publishedAt }: Props) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [submitting, setSubmitting] = useState(false);
  // Non-null while the error modal is open: the stored body + its problems.
  const [fixTarget, setFixTarget] = useState<{ body: string; problems: LinkProblem[] } | null>(null);

  async function run(
    action: (formData: FormData) => Promise<{ problems: LinkProblem[]; body: string } | void>,
    success: string
  ) {
    setSubmitting(true);
    const formData = new FormData();
    formData.set("releaseId", releaseId);
    formData.set("publishedAt", publishedAt ?? "");
    try {
      const result = await action(formData);
      setConfirming(null);
      // publishDraft returns invalid links (and the body) instead of publishing —
      // open the fix modal rather than reporting success.
      if (result?.problems.length) setFixTarget({ body: result.body, problems: result.problems });
      else toast.success(success);
    } catch (error) {
      // Server actions reject with an opaque digest in production; surface what
      // we can rather than leaving the dialog silently stuck.
      toast.error(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  // Save inline link fixes to the stored body, then refresh so the list reflects
  // the edit. No editor to sync here — the list has no live editor.
  async function saveFixes(patchedBody: string) {
    await saveDraftBody({ releaseId, body: patchedBody });
    setFixTarget(null);
    toast.success("Links updated — you can publish now.");
    router.refresh();
  }

  const atomicUpdatesLabel = `${atomicUpdateCount} ${atomicUpdateCount === 1 ? "update" : "updates"}`;

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
              “{title}” will be deleted permanently. Its {atomicUpdatesLabel} become available again,
              so they can go into a future update.
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

      <InvalidLinksDialog
        target={fixTarget}
        onSave={saveFixes}
        onOpenChange={(next) => !next && setFixTarget(null)}
      />
    </>
  );
}
