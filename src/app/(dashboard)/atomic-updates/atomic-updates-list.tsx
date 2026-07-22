"use client";

import { useState } from "react";
import { AtomicUpdateCard } from "./atomic-update-card";
import { DraftReleaseDialog } from "./draft-release-dialog";
import { ImportCommitsDialog, type ImportRepo } from "./import-commits-dialog";
import type { AtomicUpdateRow } from "./actions";

// Selection lives here rather than in the (async, server) page component: it's
// pure client-side UI state driving which atomic updates go into the next
// release draft, scoped to the list so the page itself stays a server component.
export function AtomicUpdatesList({ rows, repos }: { rows: AtomicUpdateRow[]; repos: ImportRepo[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <ImportCommitsDialog repos={repos} />
        <DraftReleaseDialog atomicUpdateIds={[...selected]} />
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.id}>
            <AtomicUpdateCard
              row={row}
              selectable
              selected={selected.has(row.id)}
              onSelectChange={onSelectChange}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
