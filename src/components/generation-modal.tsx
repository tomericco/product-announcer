"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GenerationChecklist, type GenerationOutcome } from "@/components/generation-checklist";

/**
 * Draft generation, shown as it happens — the same stepped modal brief
 * *creation* uses (`signals/create-brief-modal.tsx`), so the two flows read
 * alike: one dialog, a checklist, a Close that is always safe, and an
 * open-the-thing-that-was-made button once there is one.
 *
 * **This is presentation over machinery that already exists.** There is no
 * second progress system here: `contentPieces.generationStep` is persisted by
 * `generateDraftForPiece`, `GenerationChecklist` polls it, and this component
 * wraps that one poll in a dialog. It deliberately does not poll itself — the
 * checklist's `onOutcome` is the only seam added, and only so the footer knows
 * when a draft exists to open and the description knows what to say.
 *
 * **Closing is not a cancel.** Generation runs in an `after()` callback with
 * no open response and no abort seam; it continues whether or not anyone is
 * watching, and the piece is on the board either way. So there is no cancel
 * control and closing stops nothing — the surface behind keeps its
 * "Generating…" badge, and that badge (`GeneratingBadge`) reopens this modal,
 * which is also what covers a generation started in another tab. This is the
 * ONLY loader for a draft generation; nothing renders `GenerationChecklist`
 * inline anymore.
 *
 * Where this is mounted matters, in all three callers. For the two accept
 * flows it must sit ABOVE anything that a re-render of the accepted brief can
 * unmount — the board renders it beside its columns rather than inside the
 * brief card (accepting removes that card), and the brief editor renders it
 * outside the `canDecide` gate. `GeneratingBadge` mounts it beside the badge
 * instead, which is safe for the opposite reason: nothing unmounts a badge
 * whose piece is still generating.
 */
export function GenerationModal({
  contentPieceId,
  onClose,
  joining = false,
}: {
  /** The piece being generated, or null when nothing is being watched. */
  contentPieceId: string | null;
  /**
   * Whether this was opened onto a run ALREADY under way (the badge) rather
   * than by the acceptance that started one. Only the wording changes — the
   * poll is identical either way, since it reads a persisted column and has
   * never cared when it started watching. But "this takes a minute or so" is
   * a promise about a run that began a second ago, and repeating it over a
   * run that has been going for three minutes is simply false.
   */
  joining?: boolean;
  /**
   * Fired when the dialog is dismissed — by the footer's Close, Escape, or a
   * backdrop click, which all take the same path so there is one behaviour to
   * learn. The caller clears its own `contentPieceId` here, and this is where
   * a deferred `router.refresh()` belongs.
   */
  onClose: () => void;
}) {
  return (
    <Dialog open={contentPieceId !== null} onOpenChange={(next) => !next && onClose()}>
      {/* `showCloseButton={false}`: the footer's Close is the only control
          with that accessible name, so there is exactly one button to find —
          the create-brief modal makes the same call. */}
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        {/* Keyed by the piece, so a second acceptance starts from a clean
            checklist and a clean outcome instead of inheriting the previous
            run's. Guarded on null so no poll is mounted while closed. */}
        {contentPieceId !== null && (
          <GenerationRun
            key={contentPieceId}
            contentPieceId={contentPieceId}
            joining={joining}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One run's worth of state. Split out purely so `key` above can reset it, and
 * so the poll unmounts with the dialog rather than living on behind it.
 */
function GenerationRun({
  contentPieceId,
  joining,
  onClose,
}: {
  contentPieceId: string;
  joining: boolean;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<GenerationOutcome | null>(null);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Generating a draft</DialogTitle>
        <DialogDescription>
          {outcome === "complete"
            ? "The draft is ready. It's on the board either way — closing this won't lose it."
            : outcome === null
              ? // Said out loud, because a modal over a background job is
                // otherwise read as one you have to sit through. The closing
                // half is the same either way; only the promise about how
                // long differs, because only one of these two openings knows
                // when the run started.
                joining
                ? "This run is already under way. Closing won't stop it — the Generating… badge reopens this."
                : "This takes a minute or so. Closing won't stop it — the Generating… badge reopens this."
              : outcome === "stalled"
                ? // The poll gave up; the run itself may or may not still be
                  // alive. Anything reassuring about a minute would contradict
                  // the checklist immediately below, which by now reads "This
                  // is taking longer than expected" beside a Retry.
                  "Still no result. Nothing was lost — the piece is on the board, and Retry below re-queues it."
                : // "failed" and "gone" both land here; the checklist below
                  // says which, and neither leaves a draft to open.
                  "Nothing was lost — the piece is still on the board."}
        </DialogDescription>
      </DialogHeader>

      {/* The one poll, and the one place a draft generation is ever shown as
          steps. It does not refresh the page underneath it — that is deferred
          to `onClose`, which each caller owns. */}
      <GenerationChecklist contentPieceId={contentPieceId} onOutcome={setOutcome} />

      <DialogFooter>
        {/* Deliberately not a `DialogClose`: the parent owns `contentPieceId`,
            so every exit goes through `onOpenChange`/`onClose` and there is
            one path to reason about. Never disabled, in flight or not — a
            wait nobody can walk out of is the trap the create-brief modal
            already documents, and here there is not even a request to wait
            for: the work is in an `after()` callback. */}
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {outcome === "complete" && (
          <Button render={<Link href={`/drafts/${contentPieceId}`} />}>Open draft</Button>
        )}
      </DialogFooter>
    </>
  );
}
