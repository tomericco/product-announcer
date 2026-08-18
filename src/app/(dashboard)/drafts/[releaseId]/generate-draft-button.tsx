"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GenerationModal } from "@/components/generation-modal";
import { generateDraft } from "../../briefs/actions";

type Props = {
  contentPieceId: string;
  /** True once a previous attempt already failed — swaps the label from the
   * first-attempt "Generate draft" to "Retry generation" so the button reads
   * as a retry rather than a first try. */
  isRetry?: boolean;
  /** Whether the server sees a step in flight for this piece
   * (`generationStep !== null`). Purely server state, deliberately: an earlier
   * version of this component also tracked "I just started one" locally, and
   * because nothing ever reset that flag a FAILED generation left the button
   * replaced by a checklist forever, with no way to retry short of a full
   * browser reload. `queueGeneration` writes the step before the action
   * returns, so this prop is already true by the first refresh and the local
   * flag has nothing left to cover. */
  inFlight: boolean;
};

/**
 * Runs the same generation path `after()` takes on accept
 * (`generateDraftForPiece`, via the `generateDraft` server action) — offered
 * here so a failed or still-pending generation can be kicked off by hand
 * instead of waiting on nothing to ever retry it.
 *
 * `generateDraft` is fire-and-forget, so this button reports STARTED, not
 * done. Completion — and failure — is the generation modal's job, and this
 * button opens it, the same way accepting a brief does. That is not a
 * courtesy: the modal is the only thing that polls a run now, so a Generate
 * that merely refreshed would leave this page sitting on its accept-time
 * scaffold with nothing watching, and nothing to flip it into the editor when
 * the draft landed.
 */
export function GenerateDraftButton({ contentPieceId, isRetry = false, inFlight }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // The piece being watched in the modal — non-null IS "the modal is open".
  // Same shape as the board's `generatingPieceId` and the brief editor's, so
  // there is one way this modal is opened rather than three.
  const [watching, setWatching] = useState<string | null>(null);

  function run() {
    startTransition(async () => {
      const result = await generateDraft(contentPieceId);
      // A refusal is knowable synchronously again: `queueGeneration` checks
      // eligibility in the same statement that claims the piece, so this is a
      // real answer rather than an optimistic one. Nothing was started, so
      // nothing is opened.
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // "Started", never "done" — the action returns as soon as the work is
      // queued, and a button that claimed the draft was ready here would be
      // lying for the next thirty to sixty seconds.
      toast.success("Generation started");
      // The loader first, then the re-read that hides this button behind it.
      // `joining` is left false: this run began a second ago, which is the one
      // thing the modal's wording depends on.
      setWatching(contentPieceId);
      // The step is already written, so this render reliably sees it and the
      // page swaps this button for its "Generating…" badge.
      router.refresh();
    });
  }

  return (
    <>
      {/* Removing the control (rather than disabling it) for the duration is
          what closes the re-entrancy the fire-and-forget action opens: the
          action resolves in milliseconds now, so `disabled={isPending}` covers
          only the round trip. A click landing AFTER the run finishes is
          refused by `generateDraftForPiece`'s status guard — the piece is
          "draft" by then and the generator is never called. A click landing
          DURING the run is the weaker case: that guard is a read-then-act, so
          two overlapping runs can both pass it.

          Note what is NOT conditional: this component itself. It used to
          `return null` outright while `inFlight`, which is fine for a lone
          button and fatal for one that owns a modal — the refresh two lines
          above sets `inFlight`, so the loader it had just opened would be
          unmounted on the next render by the very refetch that proves the run
          started. */}
      {!inFlight && (
        <Button type="button" onClick={run} disabled={isPending}>
          {isPending ? "Starting…" : isRetry ? "Retry generation" : "Generate draft"}
        </Button>
      )}

      {/* Closing is not a cancel — the run continues in `after()`. The refresh
          on close is what matters most on this page: while a piece is still
          `status = 'brief'` the page returns early with the accept-time
          scaffold in a `<pre>` and no editor at all, so re-reading it is what
          turns the finished draft into an editable one. */}
      <GenerationModal
        contentPieceId={watching}
        onClose={() => {
          setWatching(null);
          router.refresh();
        }}
      />
    </>
  );
}
