"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PreflightItem } from "@/lib/ai-visibility/preflight";
import { pollRunProgressAction, type RunProgressSnapshot } from "./actions";
import { ResumeRunButton } from "./resume-run-button";
import { RunNowButton, type RunEstimate } from "./run-now-button";
import { StopRunButton } from "./stop-run-button";

/**
 * How often the in-flight run's counter is re-read.
 *
 * The same 3s the draft page's scaffold poller uses, and for the same reason:
 * fast enough that a moving number reads as movement, slow enough that a run
 * lasting the full four-minute budget costs ~80 reads rather than hundreds.
 * Each read is one indexed `latestRun` query and no revalidation.
 */
const POLL_INTERVAL_MS = 3000;

/**
 * The hard ceiling on one watcher, per effect run.
 *
 * A run whose driver dies mid-slice stays `running` until `STALL_AFTER_MS`
 * (3 minutes) elapses, at which point `stalled` goes true and the loop below
 * stops on its own — so this cap is not the stall backstop. It is the backstop
 * for a run that keeps writing but never finishes: 200 reads is ten minutes,
 * comfortably past `RUN_NOW_TOTAL_BUDGET_MS` plus a sweep slice, after which
 * the page is stale rather than wrong and a reload fixes it.
 */
const MAX_POLLS = 200;

/**
 * The two sentences a run's own state produces, live.
 *
 * Split out so the string the poller renders is provably the string the server
 * render produced for the same counts — this is the wording the overview's
 * tests pin, and there is exactly one copy of it.
 */
export function runningLineFor(progress: RunProgressSnapshot): string | null {
  if (!progress.inFlight) return null;
  return progress.stalled
    ? `Stalled at ${progress.completedCalls} / ${progress.plannedCalls} calls — resume to finish it`
    : `Running… ${progress.completedCalls} / ${progress.plannedCalls} calls`;
}

/**
 * The /ai-visibility header's run cluster: Resume, Stop, "Run now", and the one
 * line underneath that says why the button is disabled or when the next
 * scheduled scan lands.
 *
 * **Why this is a client component at all.** Everything here except the counter
 * is server-derivable, and it used to be — the page computed "Running… 41 / 270
 * calls" in its own body. The problem was that the count only ever changed on a
 * navigation: `runNowAction` fires one `router.refresh()` at the instant the
 * run is PLANNED, which is 0 of 270 by definition, and then nothing moved for
 * the several minutes the run took. The number on screen was not a progress
 * indicator, it was a timestamp of when the button was pressed, and the only
 * way to learn whether a run was advancing or wedged was to reload by hand.
 *
 * So the run's live state is owned here and everything else is still computed
 * on the server and passed in. The server's snapshot remains the seed and the
 * authority: `initialProgress` re-seeds this component's state whenever a new
 * one arrives (see below), so a refresh from any source — Stop, Resume, the
 * poller's own finish refresh, a navigation — wins over whatever the last poll
 * read.
 */
export function RunControls({
  initialProgress,
  estimate,
  blockedReason,
  capBlocking,
  nextScanNote,
  warnings = [],
}: {
  /** The in-flight run as the server saw it in the render that mounted this. */
  initialProgress: RunProgressSnapshot;
  estimate: RunEstimate;
  /** No engine key connected. Outranks the cap: a key is missing first. */
  blockedReason: string | null;
  /** Spend plus the next run would cross the monthly cap. */
  capBlocking: string | null;
  /** "Next scan in 3 days" — only ever shown when nothing above is set. */
  nextScanNote: string | null;
  /** Readiness warnings, listed in the confirm dialog. See `RunNowButton`. */
  warnings?: PreflightItem[];
}) {
  const router = useRouter();
  const [progress, setProgress] = useState(initialProgress);

  // Re-seed from the server, the React-documented way: compare the incoming
  // props against the last ones this component was seeded with and adjust state
  // during render rather than in an effect, which would paint the stale counts
  // for one frame first. Without this the component would keep whatever its
  // last poll read forever — including across a Stop, whose whole point is that
  // the server now says the run is over.
  const seed = `${initialProgress.inFlight}:${initialProgress.stalled}:${initialProgress.completedCalls}:${initialProgress.plannedCalls}`;
  const [seenSeed, setSeenSeed] = useState(seed);
  if (seenSeed !== seed) {
    setSeenSeed(seed);
    setProgress(initialProgress);
  }

  // Watch only while there is something to watch. A stalled run's counter does
  // not move again without a Resume press — and that press refreshes, which
  // re-seeds and restarts this effect — so stalled is a stopping condition
  // rather than a slower cadence.
  const watching = progress.inFlight && !progress.stalled;

  useEffect(() => {
    if (!watching) return;

    let stopped = false;
    let polls = 0;

    async function read() {
      polls += 1;
      const next = await pollRunProgressAction();
      // The effect may have been cleaned up while this request was in flight.
      if (stopped) return;

      setProgress(next);

      if (!next.inFlight) {
        // The run is over: everything BELOW the header — the tiles, the trend,
        // the matrix, the cited domains — is now stale by a whole run, and only
        // the server can produce it. One refresh, then this watcher is done;
        // the re-seed above takes the fresh server snapshot from there.
        stopped = true;
        clearInterval(intervalId);
        router.refresh();
        return;
      }

      if (next.stalled || polls >= MAX_POLLS) {
        stopped = true;
        clearInterval(intervalId);
      }
    }

    const intervalId = setInterval(() => void read(), POLL_INTERVAL_MS);
    // And once immediately: the run may have moved — or finished — between the
    // server render and this hydration, and a fresh page showing "0 / 270" for
    // three seconds is the exact staleness this component exists to remove.
    void read();

    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }, [watching, router]);

  const runningLine = runningLineFor(progress);
  // The order the page's own comment gives: a run in progress, then a missing
  // key, then the cap. Each is a reason "Run now" cannot be pressed right now,
  // and only the most immediate one is worth the line.
  const disabledReason = runningLine ?? blockedReason ?? capBlocking;

  return (
    <RunNowButton
      estimate={estimate}
      disabledReason={disabledReason}
      // `--destructive` owns warnings; a run in progress is not one.
      disabledTone={runningLine ? "muted" : "destructive"}
      actions={
        <>
          {progress.stalled && <ResumeRunButton />}
          {progress.inFlight && (
            <StopRunButton
              completedCalls={progress.completedCalls}
              plannedCalls={progress.plannedCalls}
            />
          )}
        </>
      }
      footnote={nextScanNote}
      warnings={warnings}
    />
  );
}
