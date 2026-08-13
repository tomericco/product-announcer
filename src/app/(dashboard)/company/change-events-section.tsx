import { Badge } from "@/components/ui/badge";
import { listChangeEvents, type ChangeEventFilters } from "@/lib/change-events/list";
import { openAtomicUpdatesForReassign } from "@/lib/change-events/reassign";
import { ChangeEventsFilters } from "./change-events-filters";
import { ChangeEventsList } from "./change-events-list";

const TYPE_VALUES = ["commit", "pull_request", "task"] as const;
const PROVIDER_VALUES = ["github", "notion"] as const;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseType(value: string | undefined): ChangeEventFilters["type"] {
  return (TYPE_VALUES as readonly string[]).includes(value ?? "")
    ? (value as ChangeEventFilters["type"])
    : undefined;
}

function parseProvider(value: string | undefined): ChangeEventFilters["provider"] {
  return (PROVIDER_VALUES as readonly string[]).includes(value ?? "")
    ? (value as ChangeEventFilters["provider"])
    : undefined;
}

/**
 * The Company page's "Change events" section: the UNGROUPED queue —
 * `assignment: "unassigned"` is hardcoded here, not a user-facing filter
 * (unlike the standalone /change-events page this was lifted from). These
 * events have a null `atomicUpdateId`, so they have no signal, and the Task 4
 * evidence drawer on /signals can only reach evidence THROUGH a signal's
 * atomic update — an event that never got clustered is structurally
 * unreachable there. This section is the only place it's reachable at all.
 *
 * Filter/query-param plumbing is prefixed ("ce…") and merges against the
 * page's full search params (see `ChangeEventsFilters`) so it coexists with
 * `AtomicUpdatesSection`'s own filters on the same /company URL.
 */
export async function ChangeEventsSection({
  tenantId,
  searchParams,
}: {
  tenantId: string;
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  const filters: ChangeEventFilters = {
    type: parseType(single(searchParams.ceType)),
    provider: parseProvider(single(searchParams.ceProvider)),
    assignment: "unassigned",
    showHidden: single(searchParams.ceShowHidden) === "1",
  };

  const [rows, openAtomicUpdates] = await Promise.all([
    listChangeEvents(tenantId, filters),
    openAtomicUpdatesForReassign(tenantId),
  ]);

  const targets = openAtomicUpdates.map((au) => ({ id: au.id, title: au.title }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Ungrouped</span>
        <Badge variant="secondary">{rows.length}</Badge>
      </div>

      <ChangeEventsFilters
        type={filters.type ?? "all"}
        provider={filters.provider ?? "all"}
        assignment="all"
        showHidden={filters.showHidden ?? false}
        basePath="/company"
        paramPrefix="ce"
        showAssignmentFilter={false}
      />

      {rows.length === 0 ? (
        // Required reading: this is the HEALTHY state (everything the resolver
        // has seen is already grouped into an atomic update), not a broken or
        // loading list — a plain sentence, not an empty table, says so.
        <p className="text-sm text-muted-foreground">
          {filters.showHidden
            ? "Nothing is ungrouped right now — every change event has been clustered into an atomic update."
            : "Nothing is ungrouped right now — every change event has been clustered into an atomic update. Some may be hidden; try “Show hidden” to see the resolver's rejects."}
        </p>
      ) : (
        <ChangeEventsList rows={rows} targets={targets} />
      )}
    </div>
  );
}
