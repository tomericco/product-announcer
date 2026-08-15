"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Check, Circle, CirclePause } from "lucide-react";
import { cn } from "@/lib/utils";
// Type-only, and safe either way: draft-progress.ts is pure types and step
// constants with no `db` import, and client components already import its
// step lists at runtime.
import type { ProgressStep } from "@/lib/drafting/draft-progress";

// "stalled" is distinct from "active": both mean "this step was in
// progress," but "stalled" renders without the spinner because nothing is
// actually advancing it anymore — the give-up path in generation-checklist.tsx
// downgrades a poll's last-known "active" step to this once it stops
// polling, so the last-known-in-progress step doesn't keep animating next to
// text saying the poll gave up.
export type StepStatus = "pending" | "active" | "done" | "stalled";

/** Every step pending — the state a checklist starts and resets to. */
export function initialStepStatuses<K extends string>(
  steps: readonly { key: K }[]
): Record<K, StepStatus> {
  const statuses = {} as Record<K, StepStatus>;
  for (const step of steps) statuses[step.key] = "pending";
  return statuses;
}

/**
 * How long a step stays on screen before the next one is allowed to replace it.
 *
 * The problem this solves: the deterministic steps are pure server bookkeeping
 * — resolving a handful of signal ids, loading a brand profile, writing a row.
 * They finish in single-digit milliseconds, so the checklist appears to open
 * already sitting on the model call, and the steps before it are never read.
 *
 * Why 800ms and not 1000: the owner asked for "another mock second", and the
 * intent behind that number — long enough to actually read a 3-to-5 word label
 * — is met well below a full second; anything past roughly half a second reads
 * as a discrete event rather than a flicker. The reason not to round up is that
 * this cost compounds. DRAFT_STEPS has three non-slow steps, so a floor of 1s
 * would add up to three seconds of pure padding to a run that had none, and
 * padding a user can *feel* is a worse failure than a step they didn't read.
 * 800ms keeps the worst case under 2.4s and the common case (PROPOSAL_STEPS,
 * one paced step) at a single beat.
 */
export const MIN_STEP_VISIBLE_MS = 800;

/**
 * Is anything still in flight in this snapshot?
 *
 * This is the terminal-state test, and it is derived rather than passed in as
 * a flag because every terminal state is already the same shape: a failure and
 * a give-up both downgrade the in-flight step to "stalled", a completion marks
 * everything "done", and a reset marks everything "pending". None of them
 * leaves an "active" step — which is also exactly why none of them should be
 * paced. Pacing exists to make room for a NEXT step; when nothing is in flight
 * there is no next step, only a result, and a result must never be held behind
 * a fake wait.
 */
function hasActiveStep<K extends string>(
  steps: readonly ProgressStep<K>[],
  statuses: Record<K, StepStatus>
): boolean {
  return steps.some((step) => statuses[step.key] === "active");
}

/**
 * Statuses to render, plus the setter that feeds it — with a minimum visible
 * duration applied to every step whose time is server bookkeeping rather than
 * a model call.
 *
 * **This is presentation only.** The server is never made slower to look
 * better: `generateDraftForPiece` and the proposal action are untouched, which
 * matters because the cron sweeps share those paths and nobody is watching
 * them. All that is delayed here is when the client repaints a row.
 *
 * The shape is an imperative setter rather than a `desired -> displayed`
 * transform on purpose. React batches state updates inside one tick, so a
 * caller that announces two steps in the same synchronous block (which
 * create-brief-modal.tsx does, deliberately: it dispatches the request between
 * them) would have the first collapse into the second before a derived hook
 * could ever observe it — the step would flash past by never existing. The
 * queue here is a ref, so both calls land.
 *
 * Two rules, both load-bearing:
 *
 *   1. The step marked `slow` is never paced. It is a model call; it has
 *      already taken as long as it takes, and holding its successor behind a
 *      floor buys nothing and would delay a fast failure out of the model. The
 *      floor is charged against the step being replaced, so `slow` on a step
 *      means "let whatever comes after you appear at once".
 *   2. A terminal update is never paced (see `hasActiveStep`). A failure, a
 *      give-up or a completion arriving mid-pace clears the pending timer and
 *      the queue and paints immediately. Making someone wait out a fake second
 *      to be told the thing broke is the worst possible version of this.
 *
 * `steps` is captured once. Every caller passes a module-level constant, and a
 * checklist does not change its step list mid-run.
 */
export function usePacedStatuses<K extends string>(
  steps: readonly ProgressStep<K>[],
  initial?: Record<K, StepStatus>
): [Record<K, StepStatus>, (next: Record<K, StepStatus>) => void] {
  const [displayed, setDisplayed] = useState<Record<K, StepStatus>>(
    () => initial ?? initialStepStatuses(steps)
  );

  const stepsRef = useRef(steps);
  // Mirrors `displayed` for the timer callbacks, and is written synchronously
  // so two setter calls in one tick see each other — the batching problem the
  // docstring above describes.
  const displayedRef = useRef(displayed);
  // Steps announced while a pace is running. Without it, a burst would show
  // the first step and then jump to the last, dropping the middle ones
  // entirely — the same "never read" outcome this hook exists to fix.
  const queueRef = useRef<Record<K, StepStatus>[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAtRef = useRef(0);

  // One timer at a time, and it must not outlive the component: a board can
  // hold many checklists at once.
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const show = useCallback((next: Record<K, StepStatus>) => {
    displayedRef.current = next;
    shownAtRef.current = Date.now();
    setDisplayed(next);
  }, []);

  const advance = useCallback(
    function advance(): void {
      // A pace is already running; it will drain the queue when it fires.
      if (timerRef.current !== null) return;
      const next = queueRef.current.shift();
      if (next === undefined) return;

      const outgoing = stepsRef.current.find(
        (step) => displayedRef.current[step.key] === "active"
      );
      // Nothing in flight to hold (the run is only just starting), or the step
      // being replaced is the model call — either way, no floor.
      const floor = outgoing !== undefined && outgoing.slow !== true ? MIN_STEP_VISIBLE_MS : 0;
      const remaining = floor - (Date.now() - shownAtRef.current);

      if (remaining <= 0) {
        show(next);
        advance();
        return;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        show(next);
        advance();
      }, remaining);
    },
    [show]
  );

  const showPaced = useCallback(
    (next: Record<K, StepStatus>) => {
      if (!hasActiveStep(stepsRef.current, next)) {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        queueRef.current = [];
        show(next);
        return;
      }
      queueRef.current.push(next);
      advance();
    },
    [advance, show]
  );

  return [displayed, showPaced];
}

/**
 * The stepped loader shared by every dialog that runs a pipeline route: the
 * compose flow (DRAFT_STEPS), the whole-update agent edit and the extract flow
 * (both EDIT_STEPS), and the brief proposal flow (PROPOSAL_STEPS). Which step
 * list it renders is the caller's choice; the icons, colors and the active
 * step's `detail` suffix are the same everywhere.
 *
 * Generic over the step key rather than fixed to `DraftStepKey`: different
 * flows carry different, unrelated key sets (see the comment on
 * `ProposalStepKey` in draft-progress.ts for why they aren't unioned into one
 * type), and this renderer has no reason to care which one a caller passes —
 * `steps` and `statuses` just need to agree with each other.
 */
export function ProgressChecklist<K extends string>({
  steps,
  statuses,
  detail,
  className,
}: {
  steps: readonly ProgressStep<K>[];
  statuses: Record<K, StepStatus>;
  detail?: string;
  className?: string;
}) {
  return (
    <ol className={cn("space-y-2", className)}>
      {steps.map((step) => {
        const st = statuses[step.key];
        // `data-status` is the only machine-readable trace of a step's state:
        // everything else about it is an icon swap, reachable from a test only
        // through Tailwind class names. The brief-creation modal drives this
        // checklist for real in jsdom
        // (tests/components/create-brief-modal.test.tsx) and asserts on it.
        return (
          <li key={step.key} data-status={st} className="flex items-center gap-2 text-sm">
            {st === "done" ? (
              <Check className="size-4 text-emerald-600" />
            ) : st === "active" ? (
              <Loader2 className="size-4 animate-spin text-foreground" />
            ) : st === "stalled" ? (
              <CirclePause className="size-4 text-muted-foreground" />
            ) : (
              <Circle className="size-4 text-muted-foreground/40" />
            )}
            <span className={st === "pending" ? "text-muted-foreground" : "text-foreground"}>
              {step.label}
            </span>
            {st === "active" && detail && (
              <span className="text-xs text-muted-foreground">· {detail}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
