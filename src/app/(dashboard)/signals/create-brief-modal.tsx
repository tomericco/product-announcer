"use client";

import { useState } from "react";
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
  type StepStatus,
} from "@/components/draft-progress-checklist";
import { PROPOSAL_STEPS, type ProposalStepKey } from "@/lib/drafting/draft-progress";
import { proposeAndCreateBrief } from "./propose-actions";

type Outcome =
  | { phase: "running" }
  | { phase: "created"; briefId: string }
  | { phase: "failed"; error: string };

const GENERIC_FAILURE = "Couldn't create the brief. Please try again.";

type Statuses = Record<ProposalStepKey, StepStatus>;

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
 * `status = "new"`, exactly like an agent-proposed one, and is dismissed
 * there if it isn't wanted. There is deliberately no delete-on-close — that
 * absence is what makes Close a safe default rather than a decision.
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
 * No timer paces any of this. Advancing the middle step on a `setTimeout` to
 * make the wait feel busier would be theatre, and the spec argues for three
 * honest steps precisely against that. If `proposeBriefFromSignals` ever
 * grows real internal phases, they belong inside `proposing`, reported over a
 * stream the way the draft pipeline already does.
 */
export function CreateBriefModal({ signalIds }: { signalIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ phase: "running" });
  const [statuses, setStatuses] = useState<Statuses>(() => initialStepStatuses(PROPOSAL_STEPS));
  // The ids this run was started with, captured rather than read live off the
  // prop: the "Write it by hand" link must carry the selection the failed
  // proposal actually used, even if the list behind the modal re-renders with
  // a different one.
  const [ranIds, setRanIds] = useState<string[]>([]);

  const running = outcome.phase === "running" && open;

  function start() {
    const ids = signalIds;
    setRanIds(ids);
    setOutcome({ phase: "running" });
    setStatuses({ resolving: "active", proposing: "pending", saving: "pending" });
    setOpen(true);

    void (async () => {
      // Called before the first `await` so the request is genuinely in flight
      // when `proposing` goes active below — the two `setStatuses` calls in
      // this synchronous block batch into one render, which is the point:
      // "resolving" is never a state the user sits in.
      const pending = proposeAndCreateBrief(ids);
      setStatuses({ resolving: "done", proposing: "active", saving: "pending" });

      let result: Awaited<ReturnType<typeof proposeAndCreateBrief>>;
      try {
        result = await pending;
      } catch {
        // A thrown Server Function is the network/deploy failure path — it
        // carries no message worth showing, unlike an `{ ok: false }` refusal.
        setStatuses({ resolving: "done", proposing: "stalled", saving: "pending" });
        setOutcome({ phase: "failed", error: GENERIC_FAILURE });
        return;
      }

      if (!result.ok) {
        // "stalled", not "active": nothing is advancing this step anymore, so
        // it must stop spinning next to text saying the run failed.
        setStatuses({ resolving: "done", proposing: "stalled", saving: "pending" });
        setOutcome({ phase: "failed", error: result.error });
        return;
      }

      setStatuses({ resolving: "done", proposing: "done", saving: "done" });
      setOutcome({ phase: "created", briefId: result.briefId });
    })();
  }

  return (
    <>
      <Button size="sm" onClick={start}>
        Create brief
      </Button>

      {/* A close request is ignored while the action is in flight: the run
          cannot be cancelled (one server round trip, already dispatched), so
          tearing the modal down mid-flight would hide a brief that is about
          to exist. Same shape as extract-dialog.tsx's `busy` gate. */}
      <Dialog open={open} onOpenChange={(next) => !next && !running && setOpen(false)}>
        {/* `showCloseButton={false}`: the footer's Close is the only way out,
            so the corner X isn't a second control with the same accessible
            name — and, more to the point, isn't a way to dismiss the modal
            mid-run that bypasses the footer button's disabled state. */}
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Creating a brief</DialogTitle>
            <DialogDescription>
              {outcome.phase === "created"
                ? // Says out loud why Close is safe, so nobody reads it as
                  // "discard what was just made".
                  "It's waiting in your briefs inbox — closing this won't lose it."
                : outcome.phase === "failed"
                  ? // Deliberately not "nothing was created": that holds for
                    // every `{ ok: false }` refusal (each returns before
                    // createManualBrief's insert) but NOT for a thrown
                    // Server Function, where the row may exist and only the
                    // response was lost.
                    "Your selection is still here."
                  : `Proposing an angle from ${ranIds.length} selected ${ranIds.length === 1 ? "signal" : "signals"}.`}
            </DialogDescription>
          </DialogHeader>

          <ProgressChecklist steps={PROPOSAL_STEPS} statuses={statuses} className="py-1" />

          {outcome.phase === "failed" && (
            <p role="alert" className="text-sm text-destructive">
              {outcome.error}
            </p>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={running}>
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
