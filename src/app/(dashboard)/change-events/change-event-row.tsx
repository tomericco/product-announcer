"use client";

import { Badge } from "@/components/ui/badge";
import type { ChangeEventRow as ChangeEventRowData } from "./actions";
import { ReassignControl, type ReassignTargetOption } from "./reassign-control";
import { SelectionCheckbox } from "../_components/selection-checkbox";

const TYPE_LABEL: Record<ChangeEventRowData["type"], string> = {
  commit: "Commit",
  pull_request: "PR",
  task: "Task",
};

const PROVIDER_LABEL: Record<ChangeEventRowData["provider"], string> = {
  github: "GitHub",
  notion: "Notion",
};

function assignmentLabel(row: ChangeEventRowData): string {
  if (row.atomicUpdateTitle) return row.atomicUpdateTitle;
  if (row.status === "excluded") return "Excluded";
  return "Unassigned";
}

/**
 * One row in the /change-events list. Everything here — the event, its
 * current atomic update (or lack of one), and the list of valid reassign
 * targets — arrives as props from the server-rendered page; this component
 * (and `ReassignControl` beneath it) never imports `db`/pg.
 */
export function ChangeEventRow({
  row,
  openAtomicUpdates,
  selectable = false,
  selected = false,
  anySelected = false,
  onSelectChange,
}: {
  row: ChangeEventRowData;
  openAtomicUpdates: ReassignTargetOption[];
  selectable?: boolean;
  selected?: boolean;
  // True when any row in the list is selected — reveals this row's checkbox
  // even without hover, so the list shows all boxes together during selection.
  anySelected?: boolean;
  onSelectChange?: (id: string, isSelected: boolean) => void;
}) {
  return (
    <div className="group flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      {selectable && (
        <SelectionCheckbox
          checked={selected}
          onCheckedChange={(next) => onSelectChange?.(row.id, next)}
          label={`Select ${row.title}`}
          collapsedMarginClass="-mr-3"
          forceVisible={anySelected}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="shrink-0">
            {TYPE_LABEL[row.type]}
          </Badge>
          <Badge variant="outline" className="shrink-0">
            {PROVIDER_LABEL[row.provider]}
          </Badge>
          {row.externalUrl ? (
            <a
              href={row.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-medium hover:underline"
            >
              {row.title}
            </a>
          ) : (
            <span className="truncate font-medium">{row.title}</span>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {row.atomicUpdateId ? "In " : ""}
          {assignmentLabel(row)}
        </p>
      </div>
      <ReassignControl
        eventId={row.id}
        currentAtomicUpdateId={row.atomicUpdateId}
        openAtomicUpdates={openAtomicUpdates}
      />
    </div>
  );
}
