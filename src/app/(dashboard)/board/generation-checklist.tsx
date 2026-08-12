"use client";

import { useEffect, useState } from "react";
import { ProgressChecklist, type StepStatus } from "@/components/draft-progress-checklist";
import { DRAFT_STEPS, type DraftStepKey } from "@/lib/drafting/draft-progress";
// Type-only: GenerationProgress lives in a module with a top-level `db`
// import, and Next does not tree-shake an unused runtime import out of a
// client bundle. `import type` erases entirely at compile time, so no `pg`
// ever reaches the client.
import type { GenerationProgress } from "@/lib/content/generation-progress";
import { pollGenerationProgress } from "./progress-actions";

const POLL_INTERVAL_MS = 3000;

/**
 * Snapshot derivation, not the incremental start/done reducer
 * draft-release-dialog.tsx uses: the poll only ever reports the CURRENT
 * step, never a stream of individual step events, so every step before it
 * is inferred done rather than tracked one event at a time. The generic
 * brief path has no review pass of its own, so `generating` jumps straight
 * to `saving` and `reviewing` reads as done — intended, not a bug to "fix"
 * here by adding a second per-branch step list.
 *
 * A key that isn't in DRAFT_STEPS (a build newer than this client, or a
 * stale value) makes `currentIndex` -1, and every step renders pending —
 * "no step in flight" rather than a thrown error.
 */
export function statusesForStep(currentKey: DraftStepKey | null): Record<DraftStepKey, StepStatus> {
  const currentIndex = currentKey === null ? -1 : DRAFT_STEPS.findIndex((step) => step.key === currentKey);
  const statuses = {} as Record<DraftStepKey, StepStatus>;
  for (const [index, step] of DRAFT_STEPS.entries()) {
    statuses[step.key] =
      currentIndex === -1 ? "pending" : index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
  }
  return statuses;
}

/**
 * Whether the poll loop should stop calling the server again: a completed
 * generation (`generatedAt` set), a failure that has already cleared its
 * in-flight step (`generationError` set with a null step —
 * generateDraftForPiece clears the step on every terminal path, so that
 * combination means the failure already landed, not that one is about to),
 * or the piece having disappeared from under the poll (a null read, e.g.
 * deleted mid-generation).
 */
export function shouldStopPolling(progress: GenerationProgress | null): boolean {
  if (progress === null) return true;
  if (progress.generatedAt !== null) return true;
  if (progress.generationError !== null && progress.generationStep === null) return true;
  return false;
}

/**
 * Live checklist for a card whose draft is generating. Draft generation runs
 * in an `after()` callback with no open response to stream into, so unlike
 * draft-release-dialog.tsx's SSE-driven ProgressChecklist, this one polls
 * the persisted `generationStep` column every 3s instead of consuming an
 * event stream.
 */
export function GenerationChecklist({ contentPieceId }: { contentPieceId: string }) {
  const [step, setStep] = useState<DraftStepKey | null>(null);

  useEffect(() => {
    let stopped = false;

    async function poll() {
      const result = await pollGenerationProgress(contentPieceId);
      // The interval (or the effect cleanup on unmount) may have stopped
      // polling while this request was in flight — do not resurrect state
      // on an unmounted card, and do not race a clearInterval that already
      // ran.
      if (stopped) return;
      setStep(result?.generationStep ?? null);
      if (shouldStopPolling(result)) {
        stopped = true;
        clearInterval(intervalId);
      }
    }

    // Declared before use here, but not run: `poll`'s body only reads
    // `intervalId` once it actually executes (inside the setInterval tick or
    // after the initial call below), by which point this line has already
    // assigned it.
    const intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();

    // A board can hold many of these cards at once; a leaked timer per card
    // compounds, so every path out of this effect clears it.
    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [contentPieceId]);

  return <ProgressChecklist steps={DRAFT_STEPS} statuses={statusesForStep(step)} className="text-xs" />;
}
