"use client";

import { useRef, useState } from "react";
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
import {
  ProgressChecklist,
  initialStepStatuses,
  usePacedStatuses,
} from "@/components/draft-progress-checklist";
import { PROPOSAL_STEPS, type ProposalStepKey } from "@/lib/drafting/draft-progress";
import { proposeAndCreateBrief } from "./propose-actions";

type Outcome =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "created"; briefId: string; usedSignalCount: number; droppedSignalCount: number }
  | { phase: "failed"; error: string };

const GENERIC_FAILURE = "Couldn't create the brief. Please try again.";

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * "Create brief" on `/signals`, as a modal instead of a navigation (spec B,
 * `docs/superpowers/specs/2026-08-14-brief-creation-modal-design.md`).
 *
 * What this replaces: a `Link` to `/briefs/new?signals=…`, whose server
 * render awaited a model call to pre-fill the form. That was a frozen
 * navigation with no feedback for as long as one `generateObject` call takes.
 *
 * **Closing is not a cancel.** `proposeAndCreateBrief` has already inserted
 * the brief by the time this modal offers Close: it sits in the inbox at
 * `status = "new"` and is dismissed there if it isn't wanted. There is
 * deliberately no delete-on-close — that absence is what makes Close a safe
 * default rather than a decision. It is also why the brief carries the same
 * TTL an agent-proposed one does: nobody had read it when it was written, so
 * ignoring it must cost nothing, and the sweep clears what nobody decided on.
 *
 * ### Why the three steps advance the way they do
 *
 * There is exactly ONE round trip here, and the server reports nothing from
 * inside it. So the client can observe two events — the request going out and
 * the result coming back — and it maps them onto the three real moments the
 * action passes through:
 *
 *   - `resolving` is active only until the request is dispatched. It is over
 *     in a frame, which is honest: resolving a handful of signal ids is not
 *     what anyone is waiting for.
 *   - `proposing` is active for the entire round trip, because that is where
 *     the time actually goes — `proposeBriefForSelection`'s single
 *     `generateObject` call is nearly the whole wait.
 *   - `saving` is marked done together with the result, because by the time
 *     the client hears back the row exists.
 *
 * No timer *invents* any of this. Advancing the middle step on a `setTimeout`
 * to make the wait feel busier would be theatre, and the spec argues for three
 * honest steps precisely against that. If `proposeBriefFromSignals` ever
 * grows real internal phases, they belong inside `proposing`, reported over a
 * stream the way the draft pipeline already does.
 *
 * What `usePacedStatuses` adds is narrower than that and does not change which
 * steps exist or when the server hears about them: `resolving` really does
 * happen, and it is held on screen for `MIN_STEP_VISIBLE_MS` so it can be
 * read, instead of being over in a frame nobody sees. `proposing` is marked
 * `slow` in PROPOSAL_STEPS and is never padded, and every terminal update
 * below — the two failure paths and the success — lands immediately even if a
 * pace is still running.
 *
 * Note the two `showStatuses` calls in the synchronous block below. React
 * would batch two `useState` setters there into a single render and
 * `resolving: "active"` would never exist; the hook queues through a ref
 * instead, which is what makes the first of the pair observable at all.
 *
 * ### Why the wait can be walked out of
 *
 * The run cannot be *cancelled* — it is one dispatched server round trip with
 * no abort seam — but the user must never be locked in front of it. A Server
 * Action fetch has no timeout, so a stalled connection with Escape swallowed,
 * the corner X gone and the footer Close disabled left a page reload as the
 * only exit. Close therefore abandons the wait instead of blocking on it:
 * the request keeps going, and if it lands the brief is in the inbox, which
 * is the same place Close leaves it after a success. Abandoning is only safe
 * because of that — there is no half-written state to strand.
 *
 * `runSeq` is what makes abandoning safe in the other direction: a run whose
 * result arrives after a newer one started must not write its statuses over
 * the newer run's. Without it, walking out mid-flight and starting again
 * would let the first result overwrite the second's progress.
 */
export function CreateBriefModal({
  signalIds,
  onBriefCreated,
}: {
  signalIds: string[];
  /**
   * Fired once per successful run, when the modal is done showing it —
   * `/signals` uses it to drop the selection, so the same evidence can't be
   * turned into a second brief by clicking the same button again.
   *
   * Deliberately NOT fired the instant the action returns: `SignalsList`
   * renders this component inside its `selectedIds.length > 0` bar, so
   * clearing the selection unmounts the modal. Firing on close (or, for an
   * abandoned run, once the result lands with the modal already shut) means
   * that unmount only ever happens when there is nothing left on screen to
   * tear down.
   */
  onBriefCreated?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ phase: "idle" });
  const [statuses, showStatuses] = usePacedStatuses<ProposalStepKey>(
    PROPOSAL_STEPS,
    initialStepStatuses(PROPOSAL_STEPS)
  );
  // The ids this run was started with, captured rather than read live off the
  // prop: the "Write it by hand" link must carry the selection the failed
  // proposal actually used, even if the list behind the modal re-renders with
  // a different one.
  const [ranIds, setRanIds] = useState<string[]>([]);

  const runSeq = useRef(0);
  // Mirrors `open` for the async run to read. State would be stale in that
  // closure, and the run needs to know whether anyone is still watching it.
  const openRef = useRef(false);

  function show(next: boolean) {
    openRef.current = next;
    setOpen(next);
  }

  function requestClose() {
    // Read before `show`, since `outcome` is this render's value either way.
    const created = outcome.phase === "created";
    show(false);
    if (created) onBriefCreated?.();
  }

  function start() {
    const ids = signalIds;
    const seq = ++runSeq.current;
    setRanIds(ids);
    setOutcome({ phase: "running" });
    // Reset first. An all-pending snapshot has no step in flight, so the hook
    // treats it as terminal: it drops whatever a walked-out-of run still had
    // queued and starts this run's pacing from zero, rather than making the
    // new run queue up behind the old one's floor. Nothing of this renders on
    // its own — React commits only the last of the setters in this block.
    showStatuses(initialStepStatuses(PROPOSAL_STEPS));
    showStatuses({ resolving: "active", proposing: "pending", saving: "pending" });
    show(true);

    void (async () => {
      let result: Awaited<ReturnType<typeof proposeAndCreateBrief>>;
      try {
        // Inside the try, and called before the first `await` so the request
        // is genuinely in flight when `proposing` goes active below. The two
        // `showStatuses` calls in this synchronous block are one tick apart,
        // which is precisely why they go through the pacing queue rather than
        // a plain setter: React would batch two setters into a single render
        // and "resolving" would never be a state the user could see, which is
        // the flash-past this task exists to fix. Outside the try, a
        // synchronous throw here became an unhandled rejection that pinned the
        // modal at `resolving: "active"` with no result ever arriving.
        const pending = proposeAndCreateBrief(ids);
        showStatuses({ resolving: "done", proposing: "active", saving: "pending" });
        result = await pending;
      } catch {
        // A thrown Server Function is the network/deploy failure path — it
        // carries no message worth showing, unlike an `{ ok: false }` refusal.
        if (runSeq.current !== seq) return;
        showStatuses({ resolving: "done", proposing: "stalled", saving: "pending" });
        setOutcome({ phase: "failed", error: GENERIC_FAILURE });
        return;
      }

      // A newer run owns the modal now; this one's result is history.
      if (runSeq.current !== seq) return;

      if (!result.ok) {
        // "stalled", not "active": nothing is advancing this step anymore, so
        // it must stop spinning next to text saying the run failed.
        showStatuses({ resolving: "done", proposing: "stalled", saving: "pending" });
        setOutcome({ phase: "failed", error: result.error });
        return;
      }

      showStatuses({ resolving: "done", proposing: "done", saving: "done" });
      setOutcome({
        phase: "created",
        briefId: result.briefId,
        usedSignalCount: result.usedSignalCount,
        droppedSignalCount: result.droppedSignalCount,
      });
      // Nobody is watching: the wait was abandoned and it landed anyway. No
      // Close will ever fire for this run, so hand the selection back now.
      if (!openRef.current) onBriefCreated?.();
    })();
  }

  return (
    <>
      {/* Never disabled while a run is in flight. It is unreachable behind the
          modal's backdrop anyway, so the only way to click it mid-run is to
          have walked out of one — and locking a retry behind a request that
          may never return is the same trap the exit above exists to undo.
          `runSeq` is what makes the retry safe. */}
      <Button size="sm" onClick={start}>
        Create brief
      </Button>

      {/* Escape and a backdrop click go through the same path as the footer
          button, in flight or not — see the "walked out of" note above. */}
      <Dialog open={open} onOpenChange={(next) => !next && requestClose()}>
        {/* `showCloseButton={false}`: the footer's Close is the only control
            with that accessible name, so there is exactly one button to find
            and it behaves identically at every phase. */}
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Creating a brief</DialogTitle>
            <DialogDescription>
              {outcome.phase === "created"
                ? // Reports what the brief was actually built from, not what
                  // was selected — those differ whenever `listSignals` drops
                  // something. And says out loud why Close is safe, so nobody
                  // reads it as "discard what was just made".
                  // "your briefs inbox" pointed at a page that no longer
                  // exists: the pivot retired the Briefs tab, and there is no
                  // inbox for a brief to wait in. A new brief shows up in the
                  // board's Brief column, which is the only place to find it
                  // again once this modal is closed — so that is what the
                  // reassurance has to name.
                  `Built from ${outcome.usedSignalCount} ${plural(outcome.usedSignalCount, "signal", "signals")}. It's in the board's Brief column — closing this won't lose it.`
                : outcome.phase === "failed"
                  ? // Deliberately not "nothing was created": that holds for
                    // every `{ ok: false }` refusal (each returns before
                    // createManualBrief's insert) but NOT for a thrown
                    // Server Function, where the row may exist and only the
                    // response was lost.
                    "Your selection is still here."
                  : // No count here on purpose. The resolved count isn't
                    // known until the action returns, and stating the
                    // selected one would be a number the success line then
                    // contradicts.
                    "Proposing an angle from the signals you selected. Closing won't stop it."}
            </DialogDescription>
          </DialogHeader>

          <ProgressChecklist steps={PROPOSAL_STEPS} statuses={statuses} className="py-1" />

          {outcome.phase === "created" && outcome.droppedSignalCount > 0 && (
            // Surfaced rather than swallowed. `listSignals` drops stale
            // signals and anything past its 60-day window before the proposal
            // ever sees them, so a five-signal selection can quietly become a
            // three-signal brief. `/briefs/new` says the same thing about its
            // own over-cap drop; this is the modal's equivalent.
            <p role="status" className="text-sm text-muted-foreground">
              {outcome.droppedSignalCount} of the {outcome.usedSignalCount + outcome.droppedSignalCount} signals you
              selected {plural(outcome.droppedSignalCount, "wasn't", "weren't")} usable — stale signals and anything
              older than 60 days are left out.
            </p>
          )}

          {outcome.phase === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {outcome.error}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={requestClose}>
              Close
            </Button>
            {outcome.phase === "created" && (
              <Button render={<Link href={`/briefs/${outcome.briefId}`} />}>Open brief</Button>
            )}
            {outcome.phase === "failed" && (
              // The degradation path the spec calls "never block the form":
              // the proposal is gone but the selection isn't, so the same ids
              // ride along to the hand-written form.
              <Button
                variant="outline"
                render={<Link href={`/briefs/new?signals=${ranIds.join(",")}`} />}
              >
                Write it by hand
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
