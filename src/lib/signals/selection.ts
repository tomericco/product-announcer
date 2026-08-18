/**
 * Drops any id from `selected` that is not among `rows`' ids. Returns a new
 * `Set` — `selected` itself is never mutated, so a caller holding the same
 * reference elsewhere (e.g. mid-render) never sees it change out from
 * under them.
 *
 * Why this exists: `/signals`' filters navigate via `router.push`, a soft
 * navigation, so the list component holding the selection is never
 * remounted — its selection state survives a new, narrower `rows` prop
 * completely untouched unless something reconciles it. Left alone, a signal
 * selected under one filter and then filtered out keeps eating a cap slot,
 * keeps riding along in the "create brief" link, and is not rendered
 * anywhere the user could see it or deselect it: a selection the user
 * cannot see is a selection they cannot revoke. Calling this whenever `rows`
 * changes keeps the selection honest — it only ever holds ids the user can
 * currently look at.
 */
export function retainVisible(selected: Set<string>, rows: { id: string }[]): Set<string> {
  const visibleIds = new Set(rows.map((row) => row.id));
  const next = new Set<string>();
  for (const id of selected) {
    if (visibleIds.has(id)) next.add(id);
  }
  return next;
}
