"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { GenerationChecklist } from "@/components/generation-checklist";
import { generateDraft } from "../../briefs/actions";

type Props = {
  contentPieceId: string;
  /** True once a previous attempt already failed — swaps the label from the
   * first-attempt "Generate draft" to "Retry generation" so the button reads
   * as a retry rather than a first try. */
  isRetry?: boolean;
  /** Whether the SERVER already sees a step in flight for this piece
   * (`generationStep !== null`), as of this render. */
  inFlight: boolean;
};

/**
 * Runs the same generation path `after()` takes on accept
 * (`generateDraftForPiece`, via the `generateDraft` server action) — offered
 * here so a failed or still-pending generation can be kicked off by hand
 * instead of waiting on nothing to ever retry it.
 *
 * `generateDraft` is fire-and-forget now, so this button reports STARTED, not
 * done. Completion is the checklist's job.
 */
export function GenerateDraftButton({ contentPieceId, isRetry = false, inFlight }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Covers the window between "the action queued the work" and "a server
  // render can see `generationStep`". The action returns before
  // `generateDraftForPiece` has written its first step, so the refresh below
  // can land on a row that still reads null — without this the page would
  // show nothing at all for a run that is genuinely under way.
  const [started, setStarted] = useState(false);

  // The page already renders the shared checklist above under the same
  // condition. Rendering a button here too would only invite a second run on
  // a piece that is mid-generation — see the re-entrancy note in `run`.
  if (inFlight) return null;

  function run() {
    startTransition(async () => {
      await generateDraft(contentPieceId);
      // "Started", never "done" — the action returns as soon as the work is
      // queued, and a button that claimed the draft was ready here would be
      // lying for the next thirty to sixty seconds.
      setStarted(true);
      toast.success("Generation started");
      // Picks up `generationStep` so the PAGE takes over rendering the
      // checklist (and this component returns null on that render). A
      // generation that is refused outright leaves both this and the server
      // gate empty; that case is logged server-side.
      router.refresh();
    });
  }

  // Swapping the button out for the checklist is also what closes the
  // re-entrancy hole the fire-and-forget action opens: the action resolves in
  // milliseconds now, so `isPending` goes false almost immediately and a
  // plain `disabled={isPending}` would leave the button live for the whole
  // run.
  //
  // A click landing AFTER the first run finishes is refused by
  // `generateDraftForPiece`'s status guard — the piece is "draft" by then, not
  // "brief", and the generator is never called (locked in by "refuses to
  // regenerate a piece already promoted to draft"). A click landing DURING the
  // run is the weaker case: that guard is a read-then-act, so two overlapping
  // runs can both pass it and the later write wins. Removing the control is
  // what makes that unreachable from this client — `disabled={isPending}`
  // covers only the round trip before `started` flips.
  if (started) return <GenerationChecklist contentPieceId={contentPieceId} />;

  return (
    <Button type="button" onClick={run} disabled={isPending}>
      {isPending ? "Starting…" : isRetry ? "Retry generation" : "Generate draft"}
    </Button>
  );
}
