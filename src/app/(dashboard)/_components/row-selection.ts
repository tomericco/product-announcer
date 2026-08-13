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

/**
 * The exact reconciliation `useRowSelection`'s effect runs on every `rows`
 * change. Extracted as its own named export, rather than left inline in the
 * effect body, specifically so this composition — not just `retainVisible`
 * in isolation — is what a test exercises directly: with no jsdom, a hook
 * can't be rendered, so a test can never observe whether the effect actually
 * calls this. Making the hook's effect nothing but
 * `setSelected((prev) => reconcileSelection(prev, rows))` shrinks the
 * untestable surface down to that one line, and puts everything that could
 * regress — including "does this still call `retainVisible`" — inside a
 * function a test does call.
 *
 * Preserves `prev`'s reference when nothing was dropped, so a `rows` prop
 * that changes identity without changing membership (a re-render handing
 * down a new-but-equivalent array) doesn't churn `selected`'s identity and
 * cause a needless re-render downstream.
 */
export function reconcileSelection(prev: Set<string>, rows: { id: string }[]): Set<string> {
  const next = retainVisible(prev, rows);
  return next.size === prev.size ? prev : next;
}
