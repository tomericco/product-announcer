"use client";

import { useState, useTransition } from "react";
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
} from "@/components/ui/dialog";
import { groupByMonth } from "@/lib/group-by-month";
import { AtomicUpdateCard } from "./atomic-update-card";
import { bulkHideAtomicUpdates, bulkDeleteAtomicUpdates } from "../atomic-updates/actions";
import type { AtomicUpdateRow } from "@/lib/atomic-updates/list";
import type { ImportRepo } from "@/lib/change-events/list";

// Selection lives here rather than in the (async, server) page component: it's
// pure client-side UI state driving the bulk hide/delete actions below, scoped
// to the list so the page itself stays a server component.
export function AtomicUpdatesList({
  rows,
  repos,
  notionConnected = false,
}: {
  // Open updates, plus the hidden ones interleaved by month when the page's
  // "Show hidden" filter is on — `row.hidden` is what tells them apart, and
  // `AtomicUpdateCard` renders those dashed and read-only. There's no separate
  // `showHidden` prop: the presence of a hidden row IS the toggle being on.
  rows: AtomicUpdateRow[];
  repos: ImportRepo[];
  notionConnected?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hiding, startHiding] = useTransition();
  const [deleting, startDeleting] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function onSelectChange(id: string, isSelected: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (isSelected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  // Hidden cards are read-only, so they're not selectable and must stay out of
  // both the select-all set and its "are they all selected?" test — otherwise
  // select-all could never reach `allSelected`, and every bulk action would
  // report the hidden ids as failures the server refused.
  const selectableRows = rows.filter((row) => !row.hidden);
  const allSelected = selectableRows.length > 0 && selected.size === selectableRows.length;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(selectableRows.map((r) => r.id)) : new Set());
  }

  // Bulk-hide the current selection. The action skips any id that isn't an
  // open, unlinked update (released / already in a draft), so `count` may be
  // less than the number selected — surface that instead of claiming a clean
  // sweep. Clears the selection only when something actually changed.
  function hideSelected() {
    const ids = [...selected];
    startHiding(async () => {
      const { count } = await bulkHideAtomicUpdates(ids);
      if (count === 0) {
        toast.error("Nothing was hidden — the selected updates can't be hidden");
        return;
      }
      toast.success(`Hid ${count} ${count === 1 ? "update" : "updates"}`);
      if (count < ids.length) {
        toast.warning(`${ids.length - count} couldn't be hidden and were left as-is`);
      }
      setSelected(new Set());
    });
  }

  // Permanently delete the selection. Same open+unlinked guard as hide, so
  // `count` may trail the number selected; the deleted updates' change events
  // are detached back to the unassigned pool (FK set null), not deleted.
  function deleteSelected() {
    const ids = [...selected];
    startDeleting(async () => {
      const { count } = await bulkDeleteAtomicUpdates(ids);
      setConfirmDelete(false);
      if (count === 0) {
        toast.error("Nothing was deleted — the selected updates can't be deleted");
        return;
      }
      toast.success(`Deleted ${count} ${count === 1 ? "update" : "updates"}`);
      if (count < ids.length) {
        toast.warning(`${ids.length - count} couldn't be deleted and were left as-is`);
      }
      setSelected(new Set());
    });
  }

  const busy = hiding || deleting;

  // Cards are grouped under the month they were created in, newest month first.
  // `rows` already arrives newest-first from `listAtomicUpdates`, so this only
  // adds the headings — it never reorders the cards within a month.
  const monthGroups = groupByMonth(rows, (row) => row.createdAt);

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No atomic updates match these filters.</p>
      ) : (
        <>
          {/* Nothing selectable means every row on screen is hidden — the
              select-all box and the bulk actions would all be no-ops. */}
          {selectableRows.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  aria-label="Select all atomic updates"
                />
                {selected.size > 0 ? `${selected.size} selected` : "Select all"}
              </label>

              {selected.size > 0 && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busy} onClick={hideSelected}>
                    {hiding ? "Hiding…" : "Hide"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                    className="text-destructive hover:text-destructive"
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>
          )}
          {monthGroups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">{group.label}</h2>
              <ul className="flex flex-col gap-3">
                {group.items.map((row) => (
                  <li key={row.id}>
                    <AtomicUpdateCard
                      row={row}
                      repos={repos}
                      notionConnected={notionConnected}
                      selectable={!row.hidden}
                      selected={selected.has(row.id)}
                      anySelected={selected.size > 0}
                      onSelectChange={onSelectChange}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <Dialog open={confirmDelete} onOpenChange={(next) => !next && !deleting && setConfirmDelete(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {selected.size} atomic {selected.size === 1 ? "update" : "updates"}?
            </DialogTitle>
            <DialogDescription>
              Can&apos;t be undone. The change events aren&apos;t deleted — they return to the unassigned
              pool.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" disabled={deleting} />}>Cancel</DialogClose>
            <Button variant="destructive" disabled={deleting} onClick={deleteSelected}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
