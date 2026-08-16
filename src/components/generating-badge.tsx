"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { GenerationModal } from "@/components/generation-modal";
import { cn } from "@/lib/utils";

/**
 * The "Generating…" badge, as a control that opens the generation modal for
 * that piece.
 *
 * **Why it is a control and not a label.** `GenerationChecklist` used to mount
 * inline on the board card, the drafts list and the draft detail page as well
 * as inside `GenerationModal`. It now mounts only in the modal — which would
 * leave a run started in another tab, or continued after the modal was closed,
 * with no loader anywhere. That was the exact reason an earlier pass kept the
 * card's inline checklist, and it is answered here rather than ignored:
 * awareness stays on every surface, and this badge is the way back to the
 * detail.
 *
 * So it is a real `<button>` with an accessible name, not a `<div>` with an
 * `onClick`. It is the only route to watching a generation, and a route that
 * exists only for a mouse is a route half the users don't have.
 *
 * **It replaces the loader, not the error state.** Every surface keeps its own
 * "Generation failed" / "Awaiting generation" badge and its own retry
 * affordance; this renders only while a step is actually in flight.
 *
 * The modal is mounted here rather than hoisted to each surface's root because
 * nothing unmounts this badge while it is open: the piece stays
 * `status = 'brief'` with a step in flight for the whole run, and the modal's
 * checklist deliberately does not refresh the page underneath it — the refresh
 * is deferred to `onClose` below. (Contrast the accept flows, where the modal
 * must sit above the brief card/editor that accepting destroys; those keep
 * their own mount.)
 */
export function GeneratingBadge({
  contentPieceId,
  title,
  className,
}: {
  contentPieceId: string;
  /**
   * The piece's title, appended to the accessible name. A list can hold
   * several generating rows, and "Generating…" three times over says nothing
   * about which one a control opens. Kept as a suffix so the visible text is
   * still a prefix of the accessible name (WCAG 2.5.3, "Label in Name").
   */
  title?: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Badge
        variant="outline"
        // `render` swaps the span for a button — same badge chrome, real
        // semantics. The hover rule in `badgeVariants` is anchor-scoped, so
        // the affordance is restated here.
        render={<button type="button" />}
        aria-label={title ? `Generating… — ${title}` : undefined}
        className={cn("cursor-pointer hover:bg-muted hover:text-muted-foreground", className)}
        onClick={() => setOpen(true)}
      >
        Generating…
      </Badge>

      {/* `joining`: this piece was already generating when the badge was
          clicked — see the modal's description branches. Closing re-reads the
          surface, which is what picks up a run that landed while the modal was
          open (the checklist inside it never refreshes on its own). */}
      <GenerationModal
        contentPieceId={open ? contentPieceId : null}
        joining
        onClose={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </>
  );
}
