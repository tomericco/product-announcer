"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  ProgressChecklist,
  usePacedStatuses,
  type StepStatus,
} from "@/components/draft-progress-checklist";
import { DRAFT_STEPS, type DraftStepKey } from "@/lib/drafting/draft-progress";
// Type-only: GenerationProgress lives in a module with a top-level `db`
// import, and Next does not tree-shake an unused runtime import out of a
// client bundle. `import type` erases entirely at compile time, so no `pg`
// ever reaches the client.
import type { GenerationProgress } from "@/lib/content/generation-progress";
import { pollGenerationProgress } from "@/app/(dashboard)/progress-actions";
// A "use server" export, like `pollGenerationProgress` above — what crosses
// the boundary is a Server Function reference, not a runtime value out of a
// server module, so the `db` its module imports at top level never reaches
// the client graph. Same pattern board/card.tsx already uses.
import { generateDraft } from "@/app/(dashboard)/briefs/actions";

const POLL_INTERVAL_MS = 3000;

// A wedged generation can leave `generationStep` permanently non-null (the
// interrupted-marker write in draft.ts survives a process death specifically
// so an in-progress run doesn't read as "never started" — but nothing else
// in the codebase ever clears it afterward) or permanently null with no
// error (a throw before that marker write). `shouldStopPolling` correctly
// returns false for both — they are not terminal — so without a cap this
// effect would poll forever: a server-action POST plus a session check and a
// DB query every POLL_INTERVAL_MS for as long as the tab stays open. This
// bounds it instead of trusting every generation to eventually reach a
// terminal state. ~5 minutes at the current interval; generation steps take
// tens of seconds per the design doc, so this is generous, not tight.
export const MAX_POLL_ATTEMPTS = 100;

export function hasExceededPollLimit(attempts: number): boolean {
  return attempts >= MAX_POLL_ATTEMPTS;
}

/**
 * What the checklist renders for. `"complete"` is a display-only sentinel —
 * it never comes from the server, which only ever returns a `DraftStepKey`
 * or `null` (see `GenerationProgress`). The poll loop substitutes it once a
 * run lands *successfully* (never on a failure — see `terminalOutcome`)
 * instead of passing the server's now-null `generationStep` straight
 * through, which is what used to make a successful generation flash from
 * "4 of 5 done" to every step pending on its last poll —
 * `generateDraftForPiece` clears the column on every terminal write, so the
 * terminal poll always reads null.
 */
export type ChecklistDisplayState = DraftStepKey | "complete" | null;

export type TerminalOutcome = "complete" | "failed" | "gone";

/**
 * What kind of terminal state a stopped poll landed in — only meaningful
 * once `shouldStopPolling(progress)` is already true.
 *
 * Finding 1: an earlier version of this component collapsed every terminal
 * case to the same "complete" sentinel, which painted five green checkmarks
 * over a *failed* generation — a landed failure looked identical to a
 * finished one instead of rendering distinctly from it. `"gone"` (the piece
 * disappeared from under the poll, e.g. deleted mid-generation) is also not
 * a success and gets its own branch rather than folding into either.
 */
export function terminalOutcome(progress: GenerationProgress | null): TerminalOutcome {
  if (progress === null) return "gone";
  if (progress.generatedAt !== null) return "complete";
  return "failed";
}

/**
 * Snapshot derivation, not the incremental start/done reducer
 * agent-edit-dialog.tsx uses: the poll only ever reports the CURRENT
 * step, never a stream of individual step events, so every step before it
 * is inferred done rather than tracked one event at a time. The generic
 * brief path has no review pass of its own, so `generating` jumps straight
 * to `saving` and `reviewing` reads as done — intended, not a bug to "fix"
 * here by adding a second per-branch step list.
 *
 * `"complete"` marks every step done — the state the poll loop substitutes
 * once a run has landed, instead of re-deriving "nothing in flight" from a
 * cleared column (see `ChecklistDisplayState`).
 *
 * A key that isn't in DRAFT_STEPS (a build newer than this client, or a
 * stale value) makes `currentIndex` -1, and every step renders pending —
 * "no step in flight" rather than a thrown error.
 */
export function statusesForStep(currentKey: ChecklistDisplayState): Record<DraftStepKey, StepStatus> {
  if (currentKey === "complete") {
    const statuses = {} as Record<DraftStepKey, StepStatus>;
    for (const step of DRAFT_STEPS) statuses[step.key] = "done";
    return statuses;
  }
  const currentIndex = currentKey === null ? -1 : DRAFT_STEPS.findIndex((step) => step.key === currentKey);
  const statuses = {} as Record<DraftStepKey, StepStatus>;
  for (const [index, step] of DRAFT_STEPS.entries()) {
    statuses[step.key] =
      currentIndex === -1 ? "pending" : index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
  }
  return statuses;
}

/**
 * Downgrades an "active" step to "stalled" once the poll loop has given up
 * (see `hasExceededPollLimit`) — everything else passes through unchanged.
 *
 * Without this, the give-up branch kept rendering `statusesForStep`'s last
 * poll result as-is, which left whatever step was in flight marked "active" —
 * and `ProgressChecklist` renders "active" with an `animate-spin` `Loader2`
 * (src/components/draft-progress-checklist.tsx) regardless of whether
 * anything is still polling. The CSS animation doesn't know the interval was
 * cleared, so the step kept spinning forever directly above text saying
 * polling gave up: the same misleading "still working" UI the cap itself was
 * written to eliminate. "stalled" keeps the step's done-so-far progress
 * visible (it isn't reset to "pending") without implying it is still moving.
 */
export function statusesForGaveUp(
  statuses: Record<DraftStepKey, StepStatus>
): Record<DraftStepKey, StepStatus> {
  const frozen = {} as Record<DraftStepKey, StepStatus>;
  for (const key of Object.keys(statuses) as DraftStepKey[]) {
    frozen[key] = statuses[key] === "active" ? "stalled" : statuses[key];
  }
  return frozen;
}

/**
 * Whether the give-up branch should offer a Retry control rather than only
 * reporting the stall.
 *
 * A wedged piece is recoverable without an operator and without a
 * `generationStartedAt`: it is still `status = 'brief'` with `bodyEditedAt`
 * null, which is exactly what `queueGeneration`'s WHERE asks for, so
 * `generateDraft` will claim it and schedule a fresh run. That is what this
 * control is for — before it, the give-up branch told the user to reload the
 * page, which for a piece wedged by a dead `after()` does nothing at all:
 * `generationStep` is still non-null, so every surface hides its Generate
 * button and re-renders this same checklist.
 *
 * `terminal === null` is the guard that matters. A run that LANDED must never
 * be offered a retry — "complete" in particular falls through to the checklist
 * rather than returning early (only "failed" and "gone" return), so without
 * this a finished draft could be offered a button that would regenerate over
 * it. `generateDraftForPiece` would refuse that piece anyway, but offering the
 * click at all is the bug.
 */
export function shouldOfferRetry(gaveUp: boolean, terminal: TerminalOutcome | null): boolean {
  return gaveUp && terminal === null;
}

/**
 * Whether the poll loop should stop calling the server again: a completed
 * generation (`generatedAt` set), a failure that has already cleared its
 * in-flight step (`generationError` set with a null step — that combination
 * means the failure already landed, not that one is about to), or the piece
 * having disappeared from under the poll (a null read, e.g. deleted
 * mid-generation).
 *
 * This does NOT cover every terminal case, despite what an earlier version
 * of this docstring claimed. `generateDraftForPiece`'s interrupted-generation
 * marker (`src/lib/briefs/draft.ts`) writes `generationError` with
 * `generationStep` still `"generating"` — deliberately, so a process that
 * dies mid-callback (a function timeout, a worker recycle) still leaves a
 * *visible* error instead of nothing. Nothing else in the codebase ever
 * clears that step afterward, so that combination polls forever here. A
 * throw before that marker write is the mirror case: step and error both
 * land null, indistinguishable from "generation hasn't started yet" — also
 * polls forever. Neither is a bug in this function; both are exactly why the
 * poll loop has its own attempt cap (`MAX_POLL_ATTEMPTS`) rather than relying
 * on this function alone to bound the loop.
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
 * agent-edit-dialog.tsx's stream-driven ProgressChecklist, this one polls
 * the persisted `generationStep` column every 3s instead of consuming an
 * event stream.
 *
 * Shared by the board card and the drafts list — both poll the same piece
 * under the same condition (`status === "brief"` with a step in flight), so
 * this lives in `src/components/` rather than under either route.
 */
export function GenerationChecklist({ contentPieceId }: { contentPieceId: string }) {
  const router = useRouter();
  // Paced rather than set straight through, so a run that crosses two
  // deterministic steps between polls doesn't repaint both at once and leave
  // the first unread. Nothing about the poll itself changes: the interval, the
  // cap and the terminal branches are untouched, and every terminal update
  // (complete, failed, gone, and the reset a retry does) has no "active" step,
  // so `usePacedStatuses` paints it immediately.
  const [statuses, showStatuses] = usePacedStatuses<DraftStepKey>(DRAFT_STEPS);
  const [terminal, setTerminal] = useState<TerminalOutcome | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [retrying, startRetry] = useTransition();
  // Bumped by a successful retry. It is in the effect's dependency list, so
  // incrementing it tears the stopped loop down and starts a fresh one —
  // which is what resets `attempts`, since that lives in the effect closure.
  //
  // This is what makes the budget per-CYCLE rather than per-component: a
  // piece that genuinely never starts will exhaust the new cycle and give up
  // again (offering Retry again), instead of either polling forever or being
  // permanently stuck after one stall.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    let stopped = false;
    // Counts polls for this mount only — not persisted, not shared across
    // cards. A remount (e.g. a `key` change) starts the budget over, which
    // is fine: the cap exists to bound one component's indefinite hammering,
    // not to remember a stall across unrelated mounts.
    let attempts = 0;

    async function poll() {
      attempts += 1;
      const result = await pollGenerationProgress(contentPieceId);
      // The interval (or the effect cleanup on unmount) may have stopped
      // polling while this request was in flight — do not resurrect state
      // on an unmounted card, and do not race a clearInterval that already
      // ran.
      if (stopped) return;

      if (shouldStopPolling(result)) {
        stopped = true;
        clearInterval(intervalId);
        const outcome = terminalOutcome(result);
        setTerminal(outcome);
        // Only a genuine success renders "every step done" — see
        // terminalOutcome's docstring for why a failure must not.
        if (outcome === "complete") showStatuses(statusesForStep("complete"));
        // card.tsx / drafts/page.tsx render from server-fetched props
        // (status, generationStep, generationError) that are stale the
        // moment this poll notices the run landed — nothing else tells
        // either page to re-fetch them. Without this, a successful run
        // stays under an "Awaiting generation" badge, and a failed one never
        // flips to "Generation failed", until an unrelated navigation
        // happens to refresh the page.
        router.refresh();
        return;
      }

      if (hasExceededPollLimit(attempts)) {
        stopped = true;
        clearInterval(intervalId);
        setGaveUp(true);
        return;
      }

      showStatuses(statusesForStep(result?.generationStep ?? null));
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
  }, [contentPieceId, router, cycle, showStatuses]);

  /**
   * Re-queues a wedged piece and resumes polling. Both state resets are
   * load-bearing: clearing `gaveUp` without resetting `step` would poll a
   * fresh cycle while still rendering the previous one's frozen "stalled"
   * row, and bumping `cycle` without clearing `gaveUp` would leave the
   * give-up text and its Retry button on screen while a run was genuinely
   * under way again.
   */
  function retry() {
    startRetry(async () => {
      const result = await generateDraft(contentPieceId);
      // Meaningful here, not boilerplate: a refusal means `queueGeneration`
      // no longer matches the piece — something else already moved it on
      // (published, rejected, hand-edited), so there is nothing to resume.
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Generation restarted");
      // Every step pending — no "active" step, so this lands at once rather
      // than waiting out the frozen cycle's pace.
      showStatuses(statusesForStep(null));
      setGaveUp(false);
      setCycle((c) => c + 1);
      // The piece is marked "collecting" again before the action returned, so
      // the parent's own gate stays satisfied and re-renders in sync.
      router.refresh();
    });
  }

  // A landed failure or a disappeared piece — router.refresh() (above) is
  // already on its way to replace this whole component with the parent's
  // own "Generation failed" badge/error text, but that refetch is async and
  // must not leave a false "all done" checklist on screen in the meantime.
  // "gone" renders nothing: there is no id left to report anything about,
  // and the row itself is about to disappear from the refreshed list.
  if (terminal === "failed") {
    return <p className="text-xs text-destructive">Generation failed.</p>;
  }
  if (terminal === "gone") {
    return null;
  }

  return (
    <div>
      <ProgressChecklist
        steps={DRAFT_STEPS}
        statuses={gaveUp ? statusesForGaveUp(statuses) : statuses}
        className="text-xs"
      />
      {/* The frozen steps above still render (stalled, not spinning) — the
          point is that the checklist stops lying about being in motion, not
          that it stops showing how far the run got. What changed is the
          advice underneath it: "reload the page" was dead for the case that
          actually produces this state. A piece wedged by a dead `after()`
          keeps a non-null `generationStep` across any number of reloads, so
          every surface keeps hiding its Generate button and re-rendering this
          checklist. Retry re-queues the piece instead, which works because a
          wedged piece still satisfies `queueGeneration`'s WHERE. */}
      {shouldOfferRetry(gaveUp, terminal) && (
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-muted-foreground">This is taking longer than expected.</p>
          <Button type="button" size="sm" variant="outline" onClick={retry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}
    </div>
  );
}
