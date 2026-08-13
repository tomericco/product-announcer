"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
 * done. Completion — and failure — is the checklist's job.
 */
export function GenerateDraftButton({ contentPieceId, isRetry = false, inFlight }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // The page already renders the shared checklist above under exactly this
  // condition. Rendering a button here too would only invite a second run on
  // a piece that is mid-generation — see the re-entrancy note in `run`.
  if (inFlight) return null;

  function run() {
    startTransition(async () => {
      const result = await generateDraft(contentPieceId);
      // A refusal is knowable synchronously again: `queueGeneration` checks
      // eligibility in the same statement that claims the piece, so this is a
      // real answer rather than an optimistic one.
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // "Started", never "done" — the action returns as soon as the work is
      // queued, and a button that claimed the draft was ready here would be
      // lying for the next thirty to sixty seconds.
      toast.success("Generation started");
      // The step is already written, so this render reliably sees it and the
      // page takes over with the checklist.
      router.refresh();
    });
  }

  // Removing the control (rather than disabling it) for the duration is what
  // closes the re-entrancy the fire-and-forget action opens: the action
  // resolves in milliseconds now, so `disabled={isPending}` covers only the
  // round trip. A click landing AFTER the run finishes is refused by
  // `generateDraftForPiece`'s status guard — the piece is "draft" by then and
  // the generator is never called. A click landing DURING the run is the
  // weaker case: that guard is a read-then-act, so two overlapping runs can
  // both pass it and the later write wins.
  return (
    <Button type="button" onClick={run} disabled={isPending}>
      {isPending ? "Starting…" : isRetry ? "Retry generation" : "Generate draft"}
    </Button>
  );
}
