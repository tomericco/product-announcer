import { groupByMonth } from "@/lib/group-by-month";
import type { Signal } from "@/db/schema";
import { SignalRow } from "./signal-row";

/**
 * Read-only list for the signals browser (selection and bulk actions are
 * spec 6, deliberately not here). Rows are grouped by the month they
 * *occurred* in, newest first — `occurredAt` is the "when did this happen"
 * question a debugging view is worth grouping by, distinct from `createdAt`'s
 * "how long do we keep it" that `listSignals`'s 60-day window already
 * enforces upstream of this component ever seeing a row.
 *
 * `rows` already arrives newest-occurredAt-first from `listSignals`, so this
 * only adds the month headings — it never reorders rows within a month.
 */
export function SignalsList({
  rows,
  competitorsById,
}: {
  rows: Signal[];
  competitorsById: Map<string, string>;
}) {
  const monthGroups = groupByMonth(rows, (row) => row.occurredAt);

  return (
    <div className="space-y-3">
      {monthGroups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{group.label}</h2>
          <ul className="flex flex-col gap-3">
            {group.items.map((row) => (
              <li key={row.id}>
                <SignalRow
                  row={row}
                  competitorName={row.competitorId ? competitorsById.get(row.competitorId) : undefined}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
