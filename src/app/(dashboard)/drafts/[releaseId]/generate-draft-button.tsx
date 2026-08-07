"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { generateDraft } from "../../briefs/actions";

type Props = {
  contentPieceId: string;
  /** True once a previous attempt already failed — swaps the label from the
   * first-attempt "Generate draft" to "Retry generation" so the button reads
   * as a retry rather than a first try. */
  isRetry?: boolean;
};

/**
 * Runs the same generation path `after()` takes on accept
 * (`generateDraftForPiece`, via the `generateDraft` server action) — offered
 * here so a failed or still-pending generation can be kicked off by hand
 * instead of waiting on nothing to ever retry it.
 */
export function GenerateDraftButton({ contentPieceId, isRetry = false }: Props) {
  const [isPending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const result = await generateDraft(contentPieceId);
      // On success the piece flips to "draft" and `generateDraft` revalidates
      // both this route and /drafts, so the server component re-renders with
      // the generated body — no client-side navigation needed here.
      if (!result.ok) toast.error(result.error);
    });
  }

  return (
    <Button type="button" onClick={run} disabled={isPending}>
      {isPending ? "Generating…" : isRetry ? "Retry generation" : "Generate draft"}
    </Button>
  );
}
