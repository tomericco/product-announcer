"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { pollGenerationProgress } from "@/app/(dashboard)/progress-actions";
// Reused, not re-derived: the same two predicates the modal's checklist
// stops on, so this page can never disagree with the loader about what
// "terminal" and "too many attempts" mean. Both are pure functions exported
// from a `"use client"` module — importing them mounts nothing, and the
// checklist component itself still has exactly one mount site (the invariant
// tests/app/drafts/one-loader-in-the-modal.test.ts pins by grepping src for
// its JSX tag — which is why this comment does not spell that tag out).
import { hasExceededPollLimit, shouldStopPolling } from "@/components/generation-checklist";

// Deliberately a local copy of the checklist's own 3s cadence rather than an
// export prised out of that file: this loop is a second, independent watcher
// and the two are free to diverge. Same value today because the thing being
// sampled is the same persisted column.
const POLL_INTERVAL_MS = 3000;

/**
 * Turns the draft page's accept-time scaffold into the real editor when the
 * generation it is waiting on lands.
 *
 * **Why this one page polls when nothing else does.** The stepped checklist
 * mounts only inside `GenerationModal`, so nothing polls while no modal is
 * open — an accepted decision. On the board the cost of that is one stale
 * badge on an otherwise-correct card, and clicking the badge self-heals it.
 * Here the cost is the whole page: `page.tsx` returns early
 * for `status = 'brief'` and renders the brief's own document in a `<pre>`
 * with no editor, no Ask AI and no publish. Someone who arrives mid-run from
 * the board's title link, another tab, or the brief editor's
 * Accept (which stays put by design) sits on that scaffold until they open
 * and close the badge's modal, or reload. So this page — and only this page —
 * watches for itself.
 *
 * **It renders nothing.** There is no second loader here: awareness while the
 * run is in flight is the "Generating…" badge's job, and the steps are the
 * modal's. This only decides when to re-read the page.
 *
 * **Why a refresh flips the branch.** `router.refresh()` re-requests the
 * current route and re-runs its Server Components, so `page.tsx` executes
 * again from the top against current rows: the piece is `status = 'draft'` by
 * then, the `brief` early return no longer matches, and the editor branch
 * renders. That is the same mechanism `GenerateDraftButton` and
 * `GeneratingBadge` already rely on in their `onClose`; this fires it without
 * needing anyone to open a modal first.
 */
export function ScaffoldPoller({
  contentPieceId,
  /**
   * Whether the server saw a step in flight for this piece
   * (`generationStep !== null`) in the render that mounted this. False means
   * there is nothing to watch — a brief that has never been generated, or one
   * whose failure already landed — and no poll starts. The page only renders
   * this component inside the scaffold branch at all, so the two conditions
   * together are "showing the scaffold for a piece that is generating right
   * now".
   */
  generating,
}: {
  contentPieceId: string;
  generating: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    // Nothing in flight — do not open a loop that can only ever read the same
    // unchanging row. A brief awaiting its first generation can sit here for
    // days.
    if (!generating) return;

    let stopped = false;
    // Per effect run, like the checklist's: the cap bounds one watcher's
    // hammering, it is not a memory of past stalls.
    let attempts = 0;

    async function poll() {
      attempts += 1;
      const result = await pollGenerationProgress(contentPieceId);
      // The cleanup (or an earlier stop) may have run while this request was
      // in flight — do not refresh a route this component has already left.
      if (stopped) return;

      if (shouldStopPolling(result)) {
        stopped = true;
        clearInterval(intervalId);
        // At most one refresh per effect run, which is what keeps a terminal
        // read that does NOT change this page's branch from looping: the deps
        // below are unchanged by a refresh, so the effect is not re-run and
        // this loop is over either way. (A landed failure is exactly that
        // case — it clears the step, so the re-read renders the same scaffold
        // with its error badge and nothing starts again.)
        router.refresh();
        return;
      }

      // A wedged run leaves `generationStep` non-null forever — the
      // interrupted-generation marker in `generateDraftForPiece` is written
      // before the model call on purpose and nothing ever clears it — and
      // `shouldStopPolling` correctly calls that non-terminal. Without a cap
      // this page would POST a server action every 3s for as long as the tab
      // stayed open. Giving up leaves the scaffold and its "Generating…"
      // badge exactly as they are: the modal behind that badge still has the
      // Retry.
      if (hasExceededPollLimit(attempts)) {
        stopped = true;
        clearInterval(intervalId);
      }
    }

    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    // Immediately as well as on the interval: the run may have landed in the
    // moment between this page's server render and its hydration, and waiting
    // out a full interval to notice that would be three seconds of scaffold
    // for a draft that already exists.
    void poll();

    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [contentPieceId, generating, router]);

  return null;
}
