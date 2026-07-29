export type MonthGroup<T> = {
  /** Sortable "YYYY-MM" bucket key (UTC), also usable as a React key. */
  key: string;
  /** Human-readable heading, e.g. "July 2026". */
  label: string;
  items: T[];
};

// Pinned locale + UTC, like the joined-at formatter in members-section.tsx: an
// unpinned toLocaleString() renders differently on the server and the client
// and breaks hydration. UTC also decides the bucket itself, not just the text —
// an event at 2026-07-01T00:30Z must land in the same month for everyone.
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Buckets rows into calendar months (UTC), newest month first.
 *
 * Items keep their input order within a group — callers already sort
 * deliberately (see the stable-sort comment on `listAtomicUpdates`), so this
 * only imposes an order on the groups themselves.
 */
export function groupByMonth<T>(items: T[], getDate: (item: T) => Date): MonthGroup<T>[] {
  const groups = new Map<string, MonthGroup<T>>();

  for (const item of items) {
    const date = getDate(item);
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { key, label: MONTH_LABEL.format(date), items: [item] });
    }
  }

  // "YYYY-MM" sorts lexicographically the same as chronologically, so a plain
  // string compare gives latest-to-oldest.
  return [...groups.values()].sort((a, b) => b.key.localeCompare(a.key));
}
