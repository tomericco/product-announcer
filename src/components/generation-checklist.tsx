"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
 * What this checklist reports to an owner watching it: the three ways a run
 * can LAND, plus `"stalled"` for the poll loop giving up — terminal for the
 * loop without being terminal for the run, since a wedged piece may still be
 * re-queued (that is what Retry is for). `null` means "back in flight", which
 * only a successful Retry produces.
 *
 * `"stalled"` is deliberately NOT folded into `TerminalOutcome`. This
 * component's own `terminal` state has to stay null through a give-up, or
 * `shouldOfferRetry` stops offering the very Retry the give-up branch exists
 * to show.
 */
export type GenerationOutcome = TerminalOutcome | "stalled";

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
 * The steps to announce for a poll that observed `observed`, given the last
 * step this client already announced.
 *
 * The poll SAMPLES a persisted column every `POLL_INTERVAL_MS`; it does not
 * receive one event per transition. On the real server timeline
 * (`src/lib/briefs/draft.ts`) `collecting`, `preparing` and `generating` are
 * written a few statements apart — the last two milliseconds apart — so
 * `preparing` is essentially never the value a poll happens to catch.
 * Announcing only what was observed therefore takes the checklist from
 * `collecting` straight to the model call with `preparing` retro-marked done:
 * the exact jump the minimum-visible pacing was commissioned to remove, and
 * one that pacing alone cannot fix, because a step the client never observed
 * is a step it can never hold on screen.
 *
 * So the skipped steps are announced too, in order, and the pacing hook holds
 * each of them for its floor on the way past. They are not invented: every one
 * of them ran on the server, in this order, between the two polls. They were
 * merely unsampled.
 *
 * Two cases deliberately announce `observed` on its own:
 *
 *   - Nothing has been announced yet. This is the first sample of this
 *     component's life and the run may have started long before it mounted —
 *     a board card rendering a generation begun in another tab is the normal
 *     case, not the edge one. Walking there would replay steps that finished
 *     minutes ago, which is the dishonest version of this.
 *   - The observed step is not ahead of the last announced one: a repeat (the
 *     common case — a model call spans many polls), or a key this build does
 *     not know. Nothing to walk through either way, and `statusesForStep`
 *     already renders an unknown key as "nothing in flight".
 */
export function stepsToAnnounce(
  announced: DraftStepKey | null,
  observed: DraftStepKey | null
): (DraftStepKey | null)[] {
  if (observed === null) return [null];
  const to = DRAFT_STEPS.findIndex((step) => step.key === observed);
  const from = announced === null ? -1 : DRAFT_STEPS.findIndex((step) => step.key === announced);
  if (to === -1 || from === -1 || to <= from) return [observed];
  return DRAFT_STEPS.slice(from + 1, to + 1).map((step) => step.key);
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
 * Shared by the board card, the drafts list and `GenerationModal` — all three
 * poll the same piece under the same condition (`status === "brief"` with a
 * step in flight), so this lives in `src/components/` rather than under any
 * one route.
 */
export function GenerationChecklist({
  contentPieceId,
  onOutcome,
  refreshOnTerminal = true,
}: {
  contentPieceId: string;
  /**
   * Fired when the poll loop stops — with a landed outcome, or `"stalled"`
   * when it gives up — and again with `null` if a Retry puts a run back in
   * flight. The seam `GenerationModal` needs to keep its own description
   * honest, without a second poll of its own beside this one.
   */
  onOutcome?: (outcome: GenerationOutcome | null) => void;
  /**
   * Whether landing also asks the surrounding page to re-read itself. True
   * for the inline consumers, whose parents render from server-fetched props
   * that are stale the moment a run lands (see the call below).
   *
   * `GenerationModal` passes false, and defers that refresh to its own close.
   * On `/briefs/[briefId]` the refresh is destructive while the modal is
   * open: the brief is `accepted` by then, so the re-render returns the
   * page's read-only branch, which unmounts the workspace — and the modal
   * with it, at the exact moment it had a finished draft to offer.
   */
  refreshOnTerminal?: boolean;
}) {
  const router = useRouter();
  // The latest-ref pattern: `onTerminal` is usually an inline closure, and
  // putting it in the effect's dependency list would tear down and restart
  // the poll loop (resetting `attempts` with it) on every parent render.
  const onOutcomeRef = useRef(onOutcome);
  useEffect(() => {
    onOutcomeRef.current = onOutcome;
  });
  const refreshRef = useRef(refreshOnTerminal);
  useEffect(() => {
    refreshRef.current = refreshOnTerminal;
  });
  // Paced — but note that on THIS path the floor never bites on its own, which
  // an earlier comment in this spot claimed it did. A poll announces at most
  // one snapshot every POLL_INTERVAL_MS (3s), already far past the 800ms
  // floor, so no announcement of this component's is ever held back by pacing
  // alone. What makes the floor bite is `stepsToAnnounce`: it announces the
  // steps a poll SKIPPED as well as the one it saw — several in a single tick
  // — and the hook's queue then holds each of those for its floor.
  //
  // The poll itself is untouched: same interval, same cap, same terminal
  // branches. Every terminal update either arrives with no "active" step (a
  // completion, the reset a retry does) and paints at once, or cancels the
  // walk outright via `cancelPacing` (a failure, a disappeared piece, a
  // give-up) — never held behind a floor.
  const [statuses, showStatuses, cancelPacing] = usePacedStatuses<DraftStepKey>(DRAFT_STEPS);
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
  // The last step ANNOUNCED to the pacing hook — not the one currently on
  // screen, which lags it while a walk-through is in flight. `stepsToAnnounce`
  // reads it to work out which steps a poll skipped over. A ref rather than
  // state: nothing renders from it, and the poll must see its own previous
  // write without waiting for a re-render.
  const announcedRef = useRef<DraftStepKey | null>(null);

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
        // terminalOutcome's docstring for why a failure must not. That
        // snapshot has no "active" step, so it also cancels any walk-through
        // still in flight rather than queueing behind it.
        if (outcome === "complete") showStatuses(statusesForStep("complete"));
        // "failed" and "gone" stop rendering the checklist entirely (see the
        // branches at the bottom), so there is no final snapshot to push
        // through the setter — cancel the walk explicitly instead of leaving
        // a timer to fire into a result that is already on screen.
        else cancelPacing();
        // card.tsx / drafts/page.tsx render from server-fetched props
        // (status, generationStep, generationError) that are stale the
        // moment this poll notices the run landed — nothing else tells
        // either page to re-fetch them. Without this, a successful run
        // stays under an "Awaiting generation" badge, and a failed one never
        // flips to "Generation failed", until an unrelated navigation
        // happens to refresh the page.
        if (refreshRef.current) router.refresh();
        // Last, so the owner hears about the outcome with the checklist's own
        // state already settled.
        onOutcomeRef.current?.(outcome);
        return;
      }

      if (hasExceededPollLimit(attempts)) {
        stopped = true;
        clearInterval(intervalId);
        // Freeze what is on screen. The render branch below downgrades the
        // DISPLAYED active step to "stalled", which a walk-through still in
        // flight would paint straight over with the next step.
        cancelPacing();
        setGaveUp(true);
        // Without this the modal's own outcome stayed null, so it kept saying
        // "This takes a minute or so" directly above this checklist's "This is
        // taking longer than expected."
        onOutcomeRef.current?.("stalled");
        return;
      }

      const observed = result?.generationStep ?? null;
      // One call per step, all inside this tick. The pacing hook's queue is
      // what turns them into one-at-a-time repaints (its docstring covers why
      // it is a queue in a ref rather than a derived transform: React would
      // otherwise batch them into only the last one).
      for (const key of stepsToAnnounce(announcedRef.current, observed)) {
        showStatuses(statusesForStep(key));
      }
      announcedRef.current = observed;
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
  }, [contentPieceId, router, cycle, showStatuses, cancelPacing]);

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
      // The new cycle's first poll is the first sample of a fresh run: it must
      // not be walked to from the step the previous cycle stalled on.
      announcedRef.current = null;
      setGaveUp(false);
      setCycle((c) => c + 1);
      // Back in flight, so an owner told about the stall above has to be told
      // it is over — otherwise the modal keeps describing a stall while a run
      // is genuinely under way again.
      onOutcomeRef.current?.(null);
      // Gated exactly as the terminal path is, and for the same reason.
      // Ungated, this is precisely the destructive refresh `refreshOnTerminal`
      // exists to suppress: on /briefs/[briefId] the brief is `accepted` by
      // now, so re-reading the page returns its read-only branch, which
      // unmounts BriefWorkspace — and the modal with it — mid-retry, one line
      // under a toast saying generation restarted, with nowhere left to watch
      // it. `GenerationModal`'s `onClose` already carries the deferred
      // refresh. The inline consumers (board card, drafts list) still get it:
      // the piece is marked "collecting" again before the action returned, so
      // their own gate stays satisfied and re-renders in sync.
      if (refreshRef.current) router.refresh();
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
