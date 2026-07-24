"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { AtomicUpdateCard } from "./atomic-update-card";
import { DraftReleaseDialog } from "./draft-release-dialog";
import { NewAtomicUpdateDialog } from "./new-atomic-update-dialog";
import { unhideAtomicUpdate, bulkMarkAtomicUpdatesHidden } from "./actions";
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
}: {
  rows: AtomicUpdateRow[];
  hiddenRows: AtomicUpdateRow[];
  repos: ImportRepo[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [hiding, startHiding] = useTransition();

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

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {selected.size > 0 && (
          <Button variant="outline" size="sm" disabled={hiding} onClick={markSelectedHidden}>
            {hiding ? "Marking…" : `Mark ${selected.size} as not user-facing`}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => setShowHidden((v) => !v)}>
          {showHidden ? "Hide hidden" : "Show hidden"}
          {hiddenRows.length > 0 ? ` (${hiddenRows.length})` : ""}
        </Button>
        <NewAtomicUpdateDialog repos={repos} />
        <DraftReleaseDialog atomicUpdateIds={[...selected]} />
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id}>
            <AtomicUpdateCard
              row={row}
              repos={repos}
              selectable
              selected={selected.has(row.id)}
              anySelected={selected.size > 0}
              onSelectChange={onSelectChange}
            />
          </li>
        ))}
      </ul>
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
    </div>
  );
}
