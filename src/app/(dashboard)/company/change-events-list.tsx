"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Ban, Trash2 } from "lucide-react";
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
import { groupByMonth } from "@/lib/group-by-month";
import { useRowSelection } from "../_components/use-row-selection";
import { ChangeEventRow } from "./change-event-row";
import type { ReassignTargetOption } from "./reassign-control";
import type { ChangeEventRow as ChangeEventRowData } from "@/lib/change-events/list";
import { bulkReassignChangeEvents, bulkDeleteChangeEvents } from "./change-events-actions";

/**
 * Client wrapper around the change-events list that owns row selection and the
 * bulk-action bar. Selection is pure client UI state, so it lives here rather
 * than in the (async, server) page — the page fetches `rows`/`targets`
 * server-side and passes them down as plain props, keeping `db`/pg out of the
 * client bundle (the phase-2a boundary lesson).
 *
 * Bulk targets mirror the single-row `ReassignControl` minus "split to new":
 * move all selected onto one existing atomic update, detach all, or hard
 * delete. Each posts to a `"use server"` action; outcomes surface as toasts,
 * matching the per-row pattern.
 */
export function ChangeEventsList({
  rows,
  targets,
}: {
  rows: ChangeEventRowData[];
  targets: ReassignTargetOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  // See `AtomicUpdatesList` for why this hook exists and what the
  // retain-visible effect inside it fixes: this list's filter bar
  // (`change-events-filters.tsx`) navigates the same soft `router.push` way,
  // so without it a selection made before a filter change would survive with
  // no row left on screen to show or deselect it.
  const { selected, onSelectChange, toggleAll, clear } = useRowSelection(rows);
  const allSelected = rows.length > 0 && selected.size === rows.length;

  function reassignSelected(target: { kind: "existing"; atomicUpdateId: string } | { kind: "detach" }) {
    const ids = [...selected];
    startTransition(async () => {
      const { succeeded, failed, deletedAtomicUpdates } = await bulkReassignChangeEvents(ids, target);
      if (succeeded > 0) {
        const verb = target.kind === "detach" ? "Detached" : "Moved";
        toast.success(`${verb} ${succeeded} ${succeeded === 1 ? "event" : "events"}`);
        if (deletedAtomicUpdates > 0) {
          toast.success(
            `Deleted ${deletedAtomicUpdates} emptied atomic ${deletedAtomicUpdates === 1 ? "update" : "updates"}`
          );
        }
        clear();
      }
      if (failed > 0) {
        toast.error(`${failed} ${failed === 1 ? "event" : "events"} couldn't be reassigned`);
      }
    });
  }

  function deleteSelected() {
    const ids = [...selected];
    startTransition(async () => {
      const { count } = await bulkDeleteChangeEvents(ids);
      setConfirmDelete(false);
      if (count === 0) {
        toast.error("Nothing was deleted");
        return;
      }
      toast.success(`Deleted ${count} ${count === 1 ? "event" : "events"}`);
      if (count < ids.length) {
        toast.warning(`${ids.length - count} couldn't be deleted (part of a published release)`);
      }
      clear();
    });
  }

  // Rows are grouped under the month they were ingested in, newest month first.
  // `rows` already arrives newest-first from `listChangeEvents`, so this only
  // adds the headings — it never reorders rows within a month.
  const monthGroups = groupByMonth(rows, (row) => row.createdAt);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allSelected}
            // Some-but-not-all selected reads as "not fully checked"; the box
            // is a select-all toggle, not a tri-state, so partial shows unchecked.
            onChange={(e) => toggleAll(e.target.checked)}
            aria-label="Select all change events"
          />
          {selected.size > 0 ? `${selected.size} selected` : "Select all"}
        </label>

        {selected.size > 0 && (
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
                {pending ? "Working…" : "Reassign"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {targets.length > 0 && (
                  <>
                    <DropdownMenuLabel>Move to</DropdownMenuLabel>
                    {targets.map((au) => (
                      <DropdownMenuItem
                        key={au.id}
                        onClick={() => reassignSelected({ kind: "existing", atomicUpdateId: au.id })}
                      >
                        <ArrowRightLeft />
                        <span className="truncate">{au.title}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => reassignSelected({ kind: "detach" })}>
                  <Ban />
                  Detach all
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setConfirmDelete(true)}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 />
              Delete
            </Button>
          </div>
        )}
      </div>

      {monthGroups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{group.label}</h2>
          <ul className="flex flex-col gap-3">
            {group.items.map((row) => (
              <li key={row.id}>
                <ChangeEventRow
                  row={row}
                  openAtomicUpdates={targets}
                  selectable
                  selected={selected.has(row.id)}
                  anySelected={selected.size > 0}
                  onSelectChange={onSelectChange}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Dialog open={confirmDelete} onOpenChange={(next) => !next && !pending && setConfirmDelete(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {selected.size} change {selected.size === 1 ? "event" : "events"}?</DialogTitle>
            <DialogDescription>
              This permanently removes {selected.size === 1 ? "this event" : "these events"} from the database. It
              can&apos;t be undone. Events that belong to a published release are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={pending} onClick={deleteSelected}>
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
