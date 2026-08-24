"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DisabledHint } from "../_components/disabled-hint";
import { runNowAction } from "./actions";

export type RunEstimate = { prompts: number; engines: number; samples: number; calls: number; usd: number };

/**
 * The cost, in dollars, before anything is spent — the design's trust cue,
 * and the reason there is a confirmation dialog at all. Never credits: the
 * research found credit systems are disliked precisely because they hide
 * this number.
 *
 * `calls` is quoted, and the three factors are demoted to a parenthetical that
 * says "up to". The sentence used to read "≈ 26 prompts × 3 engines × 3
 * samples", inviting the reader to multiply — and the product was wrong: 234
 * against a real plan of 216, because brand-check prompts are sampled ONCE per
 * engine whatever the samples setting says. A trust cue whose own arithmetic
 * does not check out is worse than no trust cue, and this is the one screen
 * that has to be right about money. `calls` comes from `plannedCallsForPrompts`,
 * which is the count the planner actually inserts.
 */
export function estimateSentence(estimate: RunEstimate): string {
  return `≈ ${estimate.calls} calls — ${estimate.prompts} prompts × ${estimate.engines} engines × up to ${estimate.samples} samples — about $${estimate.usd.toFixed(2)}`;
}

/**
 * "Run now" — the /ai-visibility header control. Only there: the /company card
 * offers the two navigation links and the on/off switch, and nothing that
 * spends money. Disabled states carry their reason twice on purpose: in a
 * `DisabledHint` for the pointer, and as a line under the button, because
 * "Paused — monthly engine budget reached" must be readable without hovering.
 */
export function RunNowButton({
  estimate,
  disabledReason,
  disabledTone = "muted",
  label = "Run now",
}: {
  estimate: RunEstimate;
  disabledReason: string | null;
  /**
   * The tone of the reason line. `--destructive` owns warnings and errors, and
   * the cap is one; a run being in progress is not, and painting "Running…
   * 41 / 270 calls" red reports a healthy run as a failure.
   */
  disabledTone?: "muted" | "destructive";
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (disabledReason) {
    return (
      <div className="flex flex-col items-end gap-1">
        <DisabledHint hint={disabledReason}>
          <Button disabled>{label}</Button>
        </DisabledHint>
        <p className={disabledTone === "destructive" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {disabledReason}
        </p>
      </div>
    );
  }

  function start() {
    startTransition(async () => {
      const result = await runNowAction();
      if (result.ok) {
        setOpen(false);
        // The overview reads run state on the server; refreshing is what
        // swaps the header into "Running… 41 / 270 calls".
        router.refresh();
        toast.success("Run started");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{label}</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{label}?</DialogTitle>
          <DialogDescription>
            {estimateSentence(estimate)}. Most runs finish in a few minutes; anything left over completes with
            the next daily sweep. Content changes show in 60–90 days.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
          <Button onClick={start} disabled={pending}>
            {pending ? "Starting…" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
