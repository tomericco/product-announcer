import { Badge } from "@/components/ui/badge";
import { listChangeEvents, type ChangeEventFilters } from "@/lib/change-events/list";
import { openAtomicUpdatesForReassign } from "@/lib/change-events/reassign";
import { ChangeEventsFilters } from "./change-events-filters";
import { ChangeEventsList } from "./change-events-list";
import {
  readChangeEventsFilters,
  type ChangeEventsFilterState,
  type SearchParamsRecord,
} from "./filter-params";

const ASSIGNMENT_LABEL: Record<ChangeEventsFilterState["assignment"], string> = {
  unassigned: "Ungrouped",
  assigned: "Grouped",
  all: "All events",
};

/**
 * The Company page's "Change events" section. It OPENS as the ungrouped queue
 * — `assignment` defaults to "unassigned" (see `CHANGE_EVENTS_DEFAULTS`) —
 * because an ungrouped event has a null `atomicUpdateId`, so it has no signal,
 * so the evidence drawer on /signals can only ever reach evidence THROUGH a
 * signal's atomic update: an event that never got clustered is structurally
 * unreachable there, and this section is the only place it exists at all.
 *
 * The assignment filter is nonetheless user-facing rather than hardcoded.
 * Bulk delete and bulk reassign over GROUPED events live on no other surface
 * now that the standalone tab is retired (the drawer is single-item by
 * construction), and a change event detached with "Remove event from this
 * update" lands at `atomicUpdateId=null, status='excluded'` — which
 * `listChangeEvents` hides unless `showHidden`, so that switch plus this
 * filter is the way back to one.
 *
 * Filter/query-param plumbing is prefixed ("ce…") and merges against the
 * page's full search params (see `./filter-params`) so it coexists with
 * `AtomicUpdatesSection`'s own filters on the same /company URL.
 */
export async function ChangeEventsSection({
  tenantId,
  searchParams,
}: {
  tenantId: string;
  searchParams: SearchParamsRecord;
}) {
  const state = readChangeEventsFilters(searchParams);

  const filters: ChangeEventFilters = {
    type: state.type === "all" ? undefined : state.type,
    provider: state.provider === "all" ? undefined : state.provider,
    assignment: state.assignment === "all" ? undefined : state.assignment,
    showHidden: state.showHidden,
  };

  const [rows, openAtomicUpdates] = await Promise.all([
    listChangeEvents(tenantId, filters),
    openAtomicUpdatesForReassign(tenantId),
  ]);

  const targets = openAtomicUpdates.map((au) => ({ id: au.id, title: au.title }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">{ASSIGNMENT_LABEL[state.assignment]}</span>
        <Badge variant="secondary">{rows.length}</Badge>
      </div>

      <ChangeEventsFilters
        type={state.type}
        provider={state.provider}
        assignment={state.assignment}
        showHidden={state.showHidden}
        basePath="/company"
      />

      {rows.length === 0 ? (
        // Required reading for the default (ungrouped) view: this is the
        // HEALTHY state — everything the resolver has seen is already grouped
        // into an atomic update — not a broken or loading list, and a plain
        // sentence rather than an empty table says so. Under a narrowed
        // assignment filter it means nothing more than "no matches".
        <p className="text-sm text-muted-foreground">
          {state.assignment !== "unassigned"
            ? "No change events match these filters."
            : state.showHidden
              ? "Nothing is ungrouped right now — every change event has been clustered into an atomic update."
              : "Nothing is ungrouped right now — every change event has been clustered into an atomic update. Some may be hidden; try “Show hidden” to see the resolver's rejects."}
        </p>
      ) : (
        <ChangeEventsList rows={rows} targets={targets} />
      )}
    </div>
  );
}
