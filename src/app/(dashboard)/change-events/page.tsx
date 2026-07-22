import { GitCommitHorizontal } from "lucide-react";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { requireSession } from "@/lib/workspace/session";
import { openAtomicUpdatesForReassign } from "@/lib/change-events/reassign";
import { listChangeEvents, type ChangeEventFilters } from "./actions";
import { ChangeEventsFilters } from "./change-events-filters";
import { ChangeEventRow } from "./change-event-row";

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

function parseAssignment(value: string | undefined): ChangeEventFilters["assignment"] {
  return value === "assigned" || value === "unassigned" ? value : undefined;
}

/**
 * Manual override for the resolver's clustering (phase 3): every ingested
 * change event, filterable by type/provider/assignment, with a "Show hidden"
 * toggle that surfaces the classifier's rejects (non-user-facing / filtered /
 * excluded, and unassigned) so they can be rescued by manual assignment.
 *
 * Filters come from `searchParams` — this is a Next.js 16 async Server
 * Component page, per `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
 * ("Rendering with search params": the `searchParams` prop is a `Promise`,
 * must be awaited, and reading it opts the page into dynamic rendering,
 * which is exactly what's wanted here — the list must reflect the latest
 * filter on every request).
 *
 * Both `listChangeEvents` and `openAtomicUpdatesForReassign` run here,
 * server-side, and their results are threaded into the client row/reassign
 * components as plain props — no client component in this route imports
 * `db`/pg (the phase-2a boundary lesson).
 */
export default async function ChangeEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  const filters: ChangeEventFilters = {
    type: parseType(single(params.type)),
    provider: parseProvider(single(params.provider)),
    assignment: parseAssignment(single(params.assignment)),
    showHidden: single(params.showHidden) === "1",
  };

  const session = await requireSession();
  const [rows, openAtomicUpdates] = await Promise.all([
    listChangeEvents(filters),
    openAtomicUpdatesForReassign(session.user.tenantId),
  ]);

  const targets = openAtomicUpdates.map((au) => ({ id: au.id, title: au.title }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Change events</h1>
      <p className="text-sm text-muted-foreground">
        Every commit, pull request, and task the resolver has seen. Move one to a different
        atomic update, detach it, or split it into a new one.
      </p>

      <ChangeEventsFilters
        type={filters.type ?? "all"}
        provider={filters.provider ?? "all"}
        assignment={filters.assignment ?? "all"}
        showHidden={filters.showHidden ?? false}
      />

      {rows.length === 0 ? (
        <EmptyState>
          <EmptyStateIcon>
            <GitCommitHorizontal />
          </EmptyStateIcon>
          <EmptyStateTitle>No change events</EmptyStateTitle>
          <EmptyStateDescription>
            {filters.showHidden
              ? "Nothing matches these filters."
              : "Nothing matches these filters — some events may be hidden. Try “Show hidden” to see the resolver's rejects."}
          </EmptyStateDescription>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id}>
              <ChangeEventRow row={row} openAtomicUpdates={targets} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
