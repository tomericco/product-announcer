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
import { AtomicUpdateCard } from "./atomic-update-card";
import { DraftReleaseDialog } from "./draft-release-dialog";
import { unhideAtomicUpdate, bulkMarkAtomicUpdatesHidden, bulkDeleteAtomicUpdates } from "./actions";
import { CategoryBadge } from "./page";
import type { AtomicUpdateRow } from "./actions";
import type { ImportRepo } from "../change-events/actions";

// Read-only summary of a hidden (non-user-facing) atomic update, plus its one
// available action. Deliberately not the full `AtomicUpdateCard` — a hidden
// update is a curation dead-end (out of scope: re-running the classifier or
// editing evidence on it), so the only thing worth offering here is reversing
// the hide.
function HiddenAtomicUpdateCard({ row }: { row: AtomicUpdateRow }) {
  const [pending, startTransition] = useTransition();

  function unhide() {
    startTransition(async () => {
      const result = await unhideAtomicUpdate(row.id);
      if (result.ok) {
        toast.success("Atomic update restored");
      } else {
        toast.error("Could not un-hide this atomic update");
      }
    });
  }

  return (
    <div className="rounded-lg border border-dashed p-4">
      <div className="flex items-center gap-2">
        <h2 className="font-medium text-muted-foreground">{row.title}</h2>
        <CategoryBadge category={row.category} />
      </div>
      <p className="text-sm text-muted-foreground">{row.summary}</p>
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {row.events.length} {row.events.length === 1 ? "change" : "changes"}
        </span>
        <Button variant="ghost" size="sm" disabled={pending} onClick={unhide}>
          {pending ? "Restoring…" : "Un-hide"}
        </Button>
      </div>
    </div>
  );
}

// Selection lives here rather than in the (async, server) page component: it's
// pure client-side UI state driving which atomic updates go into the next
// release draft, scoped to the list so the page itself stays a server component.
export function AtomicUpdatesList({
  rows,
  hiddenRows,
  repos,
  notionConnected = false,
  showHidden,
}: {
  rows: AtomicUpdateRow[];
  hiddenRows: AtomicUpdateRow[];
  repos: ImportRepo[];
  notionConnected?: boolean;
  // Whether the hidden section is expanded — driven by the URL/filter bar on
  // the page, not local state, so it survives navigation like the filters.
  showHidden: boolean;
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

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
  }

  // Bulk-hide the current selection. The action skips any id that isn't an
  // open, unlinked update (released / already in a draft), so `count` may be
  // less than the number selected — surface that instead of claiming a clean
  // sweep. Clears the selection only when something actually changed.
  function markSelectedHidden() {
    const ids = [...selected];
    startHiding(async () => {
      const { count } = await bulkMarkAtomicUpdatesHidden(ids);
      if (count === 0) {
        toast.error("Nothing was marked — the selected updates can't be hidden");
        return;
      }
      toast.success(`Marked ${count} ${count === 1 ? "update" : "updates"} as not user-facing`);
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

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No atomic updates match these filters.</p>
      ) : (
        <>
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
                <Button variant="outline" size="sm" disabled={busy} onClick={markSelectedHidden}>
                  {hiding ? "Marking…" : "Mark as not user-facing"}
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

            <div className="ml-auto">
              <DraftReleaseDialog atomicUpdateIds={[...selected]} />
            </div>
          </div>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li key={row.id}>
                <AtomicUpdateCard
                  row={row}
                  repos={repos}
                  notionConnected={notionConnected}
                  selectable
                  selected={selected.has(row.id)}
                  anySelected={selected.size > 0}
                  onSelectChange={onSelectChange}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {showHidden && (
        <div className="space-y-2 border-t pt-4">
          <h2 className="text-sm font-medium text-muted-foreground">Hidden atomic updates</h2>
          {hiddenRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No hidden atomic updates.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {hiddenRows.map((row) => (
                <li key={row.id}>
                  <HiddenAtomicUpdateCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
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
