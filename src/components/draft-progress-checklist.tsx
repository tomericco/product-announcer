"use client";

import { Loader2, Check, Circle, CirclePause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DraftStepKey } from "@/lib/drafting/draft-progress";

// "stalled" is distinct from "active": both mean "this step was in
// progress," but "stalled" renders without the spinner because nothing is
// actually advancing it anymore — the give-up path in generation-checklist.tsx
// downgrades a poll's last-known "active" step to this once it stops
// polling, so the last-known-in-progress step doesn't keep animating next to
// text saying the poll gave up.
export type StepStatus = "pending" | "active" | "done" | "stalled";

/** Every step pending — the state a checklist starts and resets to. */
export function initialStepStatuses(
  steps: { key: DraftStepKey }[]
): Record<DraftStepKey, StepStatus> {
  const statuses = {} as Record<DraftStepKey, StepStatus>;
  for (const step of steps) statuses[step.key] = "pending";
  return statuses;
}

/**
 * The stepped loader shared by every dialog that runs a pipeline route: the
 * compose flow (DRAFT_STEPS), the whole-update agent edit and the extract flow
 * (both EDIT_STEPS). Which step list it renders is the caller's choice; the
 * icons, colors and the active step's `detail` suffix are the same everywhere.
 */
export function ProgressChecklist({
  steps,
  statuses,
  detail,
  className,
}: {
  steps: { key: DraftStepKey; label: string }[];
  statuses: Record<DraftStepKey, StepStatus>;
  detail?: string;
  className?: string;
}) {
  return (
    <ol className={cn("space-y-2", className)}>
      {steps.map((step) => {
        const st = statuses[step.key];
        return (
          <li key={step.key} className="flex items-center gap-2 text-sm">
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
