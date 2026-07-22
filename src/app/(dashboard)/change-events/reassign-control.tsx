"use client";

import { useTransition } from "react";
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
import { reassign } from "./actions";

export type ReassignTargetOption = { id: string; title: string };

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
 */
export function ReassignControl({ eventId, currentAtomicUpdateId, openAtomicUpdates }: Props) {
  const [pending, startTransition] = useTransition();

  function submit(fields: { targetKind: "existing" | "detach" | "new"; atomicUpdateId?: string }) {
    const formData = new FormData();
    formData.set("eventId", eventId);
    formData.set("targetKind", fields.targetKind);
    if (fields.atomicUpdateId) formData.set("atomicUpdateId", fields.atomicUpdateId);

    startTransition(async () => {
      const result = await reassign(formData);
      if (result.ok) {
        toast.success("Change event reassigned");
      } else {
        toast.error(result.reason);
      }
    });
  }

  // Assigning an event to the atomic update it's already in is a no-op the
  // core would happily perform, but offering it as a menu choice is just
  // clutter.
  const moveTargets = openAtomicUpdates.filter((au) => au.id !== currentAtomicUpdateId);

  return (
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
  );
}
