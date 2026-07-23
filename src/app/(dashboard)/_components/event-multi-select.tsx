"use client";

import { useEffect, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type PickerType = "commit" | "pull_request";

export type PickerRow = {
  key: string; // unique selection key
  title: string; // primary line
  meta?: React.ReactNode; // secondary line
  externalUrl?: string | null; // external "open" link (right side)
  locked?: boolean; // rendered checked + disabled (e.g. already imported)
  badge?: React.ReactNode; // right-side badge
};

const TYPE_LABEL: Record<PickerType, string> = { commit: "Commits", pull_request: "PRs" };

export function EventMultiSelect({
  activeType,
  onTypeChange,
  enabledTypes,
  rows,
  loading,
  error,
  emptyLabel = "Nothing to show.",
  selected,
  onSelectedChange,
  search,
  onSearchChange,
  filtersSlot,
  searchPlaceholder = "Search…",
  submitLabel,
  submitting,
  onSubmit,
}: {
  activeType: PickerType;
  onTypeChange: (t: PickerType) => void;
  enabledTypes: PickerType[];
  rows: PickerRow[];
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  search: string;
  onSearchChange: (s: string) => void;
  filtersSlot?: React.ReactNode;
  searchPlaceholder?: string;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: () => void;
}) {
  // Anchor for shift-click range selection, by key (survives filtering).
  const anchorKey = useRef<string | null>(null);
  const shiftHeldRef = useRef(false);

  // A new type tab is a different result set — its selection and anchor don't
  // carry over.
  useEffect(() => {
    anchorKey.current = null;
  }, [activeType]);

  const query = search.trim().toLowerCase();
  const visible = query ? rows.filter((r) => r.title.toLowerCase().includes(query)) : rows;
  const selectable = visible.filter((r) => !r.locked);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key));

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  }

  function selectRange(fromIndex: number, toIndex: number) {
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    const clicked = visible[toIndex];
    const target = !selected.has(clicked.key);
    const next = new Set(selected);
    for (let i = lo; i <= hi; i++) {
      const r = visible[i];
      if (r.locked) continue;
      if (target) next.add(r.key);
      else next.delete(r.key);
    }
    onSelectedChange(next);
  }

  function onCheckboxChange(row: PickerRow, index: number) {
    const anchorIndex =
      shiftHeldRef.current && anchorKey.current
        ? visible.findIndex((r) => r.key === anchorKey.current)
        : -1;
    if (anchorIndex !== -1) selectRange(anchorIndex, index);
    else toggle(row.key);
    anchorKey.current = row.key;
    shiftHeldRef.current = false;
  }

  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) for (const r of selectable) next.delete(r.key);
    else for (const r of selectable) next.add(r.key);
    onSelectedChange(next);
  }

  return (
    <>
      {/* Header: caller-supplied filters (e.g. the import dialog's repo tabs)
          on the left, the event-type dropdown right-aligned. With no
          filtersSlot the dropdown simply sits on the right. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{filtersSlot}</div>
        <Select value={activeType} onValueChange={(v) => onTypeChange(v as PickerType)}>
          <SelectTrigger className="w-36 shrink-0">
            <SelectValue>{TYPE_LABEL[activeType]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {enabledTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {TYPE_LABEL[t]}
              </SelectItem>
            ))}
            <SelectItem value="task" disabled>
              Tasks — soon
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Input
        placeholder={searchPlaceholder}
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />

      <div className="h-80 overflow-y-auto rounded-lg border border-border">
        <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-border bg-background px-4 py-2.5 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allSelected}
            disabled={selectable.length === 0}
            onChange={toggleAll}
          />
          Select all{selectable.length > 0 ? ` (${selectable.length})` : ""}
          <span className="ml-auto text-xs font-normal text-muted-foreground">Shift-click to select a range</span>
        </label>
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((row, index) => {
              const checked = row.locked || selected.has(row.key);
              return (
                <li key={row.key}>
                  <label
                    className={
                      "flex cursor-pointer items-start gap-3 px-4 py-3.5 text-sm hover:bg-muted/50" +
                      (row.locked ? " cursor-not-allowed opacity-60" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-input"
                      checked={checked}
                      disabled={row.locked}
                      onClick={(e) => {
                        shiftHeldRef.current = e.shiftKey;
                      }}
                      onChange={() => onCheckboxChange(row, index)}
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate font-medium">{row.title}</span>
                      {row.meta && <span className="block text-xs text-muted-foreground">{row.meta}</span>}
                    </span>
                    {row.badge && (
                      <Badge variant="secondary" className="shrink-0 self-center">
                        {row.badge}
                      </Badge>
                    )}
                    {row.externalUrl && (
                      <a
                        href={row.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Open externally"
                        className="shrink-0 self-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{selected.size} selected</span>
        <Button type="button" onClick={onSubmit} disabled={selected.size === 0 || submitting}>
          {submitLabel}
        </Button>
      </div>
    </>
  );
}
