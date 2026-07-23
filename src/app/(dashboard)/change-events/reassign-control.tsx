"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Ban, Split } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { reassign } from "./actions";

export type ReassignTargetOption = { id: string; title: string };

type PendingFields = { targetKind: "existing" | "detach" | "new"; atomicUpdateId?: string };

type ConfirmState = {
  fields: PendingFields;
  emptiedAtomicUpdate: { id: string; title: string; inDraft: boolean };
};

type Props = {
  eventId: string;
  currentAtomicUpdateId: string | null;
  /**
   * Every OPEN atomic update for the tenant (from `openAtomicUpdatesForReassign`,
   * fetched server-side by the page). Passed as a prop rather than queried here
   * — this stays a plain client component with no `db`/pg import.
   */
  openAtomicUpdates: ReassignTargetOption[];
};

/**
 * The reassignment menu for a single change-event row: move it to a
 * different open atomic update, detach it (excluded, won't be re-attached by
 * the cron sweep), or split it into a brand-new atomic update. Posts to the
 * `reassign` server action (tenant/user derived there from the session) and
 * shows a pending state via `useTransition`, mirroring the
 * action-posting + toast pattern in `atomic-update-card.tsx` /
 * `catch-up-banner.tsx`. Unlike those, the action here RETURNS `{ok:false}`
 * instead of throwing on a rejected move (e.g. out of a released atomic
 * update), so success/failure is read off the resolved value rather than a
 * try/catch.
 *
 * A move that would leave its source atomic update with zero change events
 * comes back as `needsConfirmation` (Finding 2) rather than silently
 * deleting it — this opens a confirm dialog (mirroring the destructive
 * "Start over" confirm in `catch-up-banner.tsx`) that warns the user, and
 * mentions the draft-release case specifically, before re-posting the exact
 * same move with `confirmEmptyDeletion=true`.
 */
export function ReassignControl({ eventId, currentAtomicUpdateId, openAtomicUpdates }: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  function post(fields: PendingFields, confirmEmptyDeletion: boolean) {
    const formData = new FormData();
    formData.set("eventId", eventId);
    formData.set("targetKind", fields.targetKind);
    if (fields.atomicUpdateId) formData.set("atomicUpdateId", fields.atomicUpdateId);
    if (confirmEmptyDeletion) formData.set("confirmEmptyDeletion", "true");

    startTransition(async () => {
      const result = await reassign(formData);

      if (result.ok) {
        setConfirmState(null);
        if (result.deletedAtomicUpdate) {
          toast.success(`Deleted empty atomic update "${result.deletedAtomicUpdate.title}"`);
        } else {
          toast.success("Change event reassigned");
        }
        return;
      }

      if ("needsConfirmation" in result && result.needsConfirmation) {
        setConfirmState({ fields, emptiedAtomicUpdate: result.emptiedAtomicUpdate });
        return;
      }

      toast.error(result.reason);
    });
  }

  function submit(fields: PendingFields) {
    post(fields, false);
  }

  // Assigning an event to the atomic update it's already in is a no-op the
  // core would happily perform, but offering it as a menu choice is just
  // clutter.
  const moveTargets = openAtomicUpdates.filter((au) => au.id !== currentAtomicUpdateId);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
          {pending ? "Reassigning…" : "Reassign"}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {moveTargets.length > 0 && (
            <>
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              {moveTargets.map((au) => (
                <DropdownMenuItem
                  key={au.id}
                  onClick={() => submit({ targetKind: "existing", atomicUpdateId: au.id })}
                >
                  <ArrowRightLeft />
                  <span className="truncate">{au.title}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => submit({ targetKind: "new" })}>
            <Split />
            Split to new
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => submit({ targetKind: "detach" })}>
            <Ban />
            Detach
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmState !== null} onOpenChange={(next) => !next && !pending && setConfirmState(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete emptied atomic update?</DialogTitle>
            <DialogDescription>
              {confirmState && (
                <>
                  Moving this event will leave &quot;{confirmState.emptiedAtomicUpdate.title}&quot; with no change
                  events, so it will be deleted.
                  {confirmState.emptiedAtomicUpdate.inDraft
                    ? " It's part of a draft release — deleting it removes a member the draft's body still describes."
                    : null}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => confirmState && post(confirmState.fields, true)}
            >
              {pending ? "Deleting…" : "Delete and move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
