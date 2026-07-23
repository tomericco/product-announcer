"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { catchUp, startOver } from "./actions";

type Props = {
  /** From `computeReleaseDelta` server-side — never queried client-side, so
   * this component pulls in no `db`/pg import (see the pg-in-client-bundle
   * boundary noted elsewhere in this codebase). */
  count: number;
  releaseId: string;
};

/**
 * Shown above the editor only when the draft has gone stale (Task 3's
 * `computeReleaseDelta` found new or changed atomic updates since compose).
 * "Catch up" merge-regenerates, preserving wording; "Start over" discards the
 * current body and regenerates from scratch, so it sits behind a confirm
 * dialog (mirrors the destructive-action pattern in `draft-row-menu.tsx`).
 * Both calls are multi-second LLM round trips with no streaming, hence the
 * pending state disabling the row instead of an optimistic update.
 */
export function CatchUpBanner({ count, releaseId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [confirmingStartOver, setConfirmingStartOver] = useState(false);

  function run(action: (formData: FormData) => Promise<void>, success: string) {
    const formData = new FormData();
    formData.set("releaseId", releaseId);
    startTransition(async () => {
      try {
        await action(formData);
        setConfirmingStartOver(false);
        toast.success(success);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong");
      }
    });
  }

  const label = `${count} new ${count === 1 ? "update" : "updates"} since this draft`;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
        <span>{label} — catch up.</span>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={isPending}
            onClick={() => run(catchUp, "Draft updated")}
          >
            {isPending ? "Catching up…" : "Catch up"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={isPending}
            onClick={() => setConfirmingStartOver(true)}
          >
            Start over
          </Button>
        </div>
      </div>

      <Dialog
        open={confirmingStartOver}
        onOpenChange={(next) => !next && !isPending && setConfirmingStartOver(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Start this draft over?</DialogTitle>
            <DialogDescription>
              The current wording will be discarded and regenerated from scratch over all of this
              draft&apos;s changes. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={isPending} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() => run(startOver, "Draft regenerated")}
            >
              {isPending ? "Starting over…" : "Start over"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
