"use client";

import { useEffect, useState } from "react";
import { applySelectionChange, applyToggleAll, reconcileSelection } from "./row-selection";

/**
 * Row-selection state shared by the Company page's two bulk-action lists —
 * `atomic-updates-list.tsx` and `change-events-list.tsx` carried byte-identical
 * `useState<Set<string>>` + `onSelectChange(id, isSelected)` + `toggleAll(checked)`
 * before this extraction.
 *
 * Pass the rows select-all should span — a list's *selectable* rows, not
 * necessarily its full `rows` prop (e.g. `AtomicUpdatesList` excludes its
 * hidden, read-only cards). That same array doubles as "what's currently on
 * screen" for the retain-visible effect below.
 *
 * `signals-list.tsx` carries a `retainVisible` effect because its filter bar
 * navigates with `router.push` — a soft navigation, so the list is never
 * remounted when the filtered rows narrow, and a stale selected id would
 * otherwise ride along invisibly. The Company lists' filter bars
 * (`atomic-updates-filters.tsx`, `change-events-filters.tsx`) push the exact
 * same way and had no such guard: a selection made before a filter change
 * would survive it with no row left on screen, and a subsequent bulk hide or
 * delete would act on rows the user can no longer see. This hook carries the
 * same fix for both.
 */
export function useRowSelection(rows: { id: string }[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    // `selected` is state this hook owns, but `rows` is an external input
    // (the server-rendered filter result) it must stay synchronized against —
    // the same intentional shape `signals-list.tsx`'s identical effect uses,
    // which is why the newer react-hooks lint rule needs the same suppression
    // here. All the actual reconciliation logic (including the skip-if-
    // nothing-dropped optimization) lives in `reconcileSelection`, tested
    // directly in `tests/app/row-selection.test.ts` — this effect does
    // nothing but call it, so there's as little unrendered/untested logic
    // sitting in here as possible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((prev) => reconcileSelection(prev, rows));
  }, [rows]);

  function onSelectChange(id: string, isSelected: boolean) {
    setSelected((prev) => applySelectionChange(prev, id, isSelected));
  }

  function toggleAll(checked: boolean) {
    setSelected(applyToggleAll(rows, checked));
  }

  function clear() {
    setSelected(new Set());
  }

  return { selected, setSelected, onSelectChange, toggleAll, clear };
}
