import { retainVisible } from "@/lib/signals/selection";

/**
 * Pure reducer core behind `useRowSelection`. Exported separately from the
 * hook (rather than inlined in its `useState` updaters) because this
 * project's vitest config runs `environment: "node"` — there is no jsdom, so
 * a hook can't be rendered and asserted against directly. Keeping the actual
 * set-manipulation logic in plain functions is what makes it testable at
 * all; see `tests/app/row-selection.test.ts`.
 */

/**
 * Adds or removes a single id depending on `isSelected`. Mirrors the two
 * Company lists' pre-extraction `onSelectChange(id, isSelected)` — never
 * mutates `selected`, always returns a new `Set`.
 */
export function applySelectionChange(selected: Set<string>, id: string, isSelected: boolean): Set<string> {
  const next = new Set(selected);
  if (isSelected) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

/**
 * Selects every id in `rows`, or clears the selection. Mirrors the two
 * Company lists' pre-extraction `toggleAll(checked)` — `rows` should be
 * whatever set select-all is meant to span (e.g. a list's selectable rows,
 * excluding any read-only ones it renders alongside them).
 */
export function applyToggleAll(rows: { id: string }[], checked: boolean): Set<string> {
  return checked ? new Set(rows.map((row) => row.id)) : new Set();
}

// The drop-stale-ids fix already exists as `retainVisible` in
// `@/lib/signals/selection` (written for signals-list.tsx's identical
// soft-navigation problem) and is reused here rather than duplicated — same
// bug, same fix, one function. Re-exported so `useRowSelection` and its test
// have a single import for the whole reducer surface.
export { retainVisible };
