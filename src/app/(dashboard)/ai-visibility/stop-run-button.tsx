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
import { cancelRunAction } from "./actions";

/**
 * "Stop" — beside "Run now", and only while a run is in flight.
 *
 * Destructive tone, unlike the in-progress line next to it: this is money and
 * it does not come back. A run is ~270 calls and a few dollars; the calls
 * already made are paid for whatever happens next, and the ones this cancels
 * are the ones the operator has decided not to buy. `--destructive` is for real
 * errors and genuinely irreversible actions, and this is the second.
 *
 * Confirmed, like "Run now" is, and for the mirror-image reason: the same click
 * that must not spend $18 by accident must not throw away a run in progress by
 * accident either. The dialog states all three consequences, because "Stop"
 * alone reads like it might mean "pause and resume later" — which it is not.
 */
export function StopRunButton({
  completedCalls,
  plannedCalls,
}: {
  completedCalls: number;
  plannedCalls: number;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function stop() {
    startTransition(async () => {
      const result = await cancelRunAction();
      if (result.ok) {
        setOpen(false);
        // The header reads run state on the server; refreshing is what swaps
        // "Running… 41 / 270 calls" for the stopped line and re-enables
        // "Run now" — which is immediately true, since `cancelled` is not an
        // in-flight status.
        router.refresh();
        toast.success("Run stopped");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive">Stop</Button>} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Stop this run?</DialogTitle>
          <DialogDescription>
            The {completedCalls} of {plannedCalls} calls already made are kept and counted toward your
            numbers. The remaining {Math.max(0, plannedCalls - completedCalls)} are not run and not
            charged. Stopping can&apos;t be undone — but you can start a new run straight away.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" disabled={pending} />}>Keep running</DialogClose>
          <Button variant="destructive" onClick={stop} disabled={pending}>
            {pending ? "Stopping…" : "Stop run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
