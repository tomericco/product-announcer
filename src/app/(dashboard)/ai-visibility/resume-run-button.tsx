"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resumeRunAction } from "./actions";

/**
 * "Resume" — shown only while a run is stalled: in flight, nothing written to
 * it for `STALL_AFTER_MS`, and holding no live slice lease. That is exactly the
 * condition `resumeRunAction` enforces, so the button is never offered for a
 * run that would then refuse it.
 *
 * The plain `outline` variant, and the choice is about the two controls it sits
 * with. "Run now" is the only filled button in this header and stays the
 * primary, disabled while a run is in flight. "Stop" is `outline` wearing the
 * `--destructive` hue, because it throws work away. Resume is the third: it
 * needs to be visibly a button rather than a link, and it must not read as
 * either the primary action or a dangerous one — so it takes the same unfilled
 * shape as Stop with the default neutral border, and the hue is what tells them
 * apart at a glance.
 *
 * No confirmation dialog, unlike its two neighbours. Both of those change what
 * money is spent — one commits ~$18 of calls, the other throws away a run that
 * cannot be got back. Resuming does neither: the calls were planned and
 * authorised when the run started, the cap is re-checked between batches, and
 * the worst case of a mistaken click is that the run finishes sooner.
 */
export function ResumeRunButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function resume() {
    startTransition(async () => {
      const result = await resumeRunAction();
      if (result.ok) {
        // The header reads run state on the server; refreshing is what swaps
        // the stalled line back to "Running…" once the driver takes the lease.
        router.refresh();
        toast.success("Resuming the run");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button variant="outline" onClick={resume} disabled={pending}>
      {pending ? "Resuming…" : "Resume"}
    </Button>
  );
}
