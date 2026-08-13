"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  changeEventsFiltersAreDefault,
  toQuerySuffix,
  writeChangeEventsFilters,
  CHANGE_EVENTS_DEFAULTS,
  type ChangeEventsFilterState,
} from "./filter-params";

const TYPE_OPTIONS = [
  { value: "all", label: "All types" },
  { value: "commit", label: "Commit" },
  { value: "pull_request", label: "Pull request" },
  { value: "task", label: "Task" },
];

const PROVIDER_OPTIONS = [
  { value: "all", label: "All providers" },
  { value: "github", label: "GitHub" },
  { value: "notion", label: "Notion" },
];

const ASSIGNMENT_OPTIONS = [
  { value: "unassigned", label: "Ungrouped" },
  { value: "assigned", label: "Grouped" },
  { value: "all", label: "All events" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Filter bar for the Company page's change-events section. Reads its current
 * values as props from the server-rendered section (the page's `searchParams`
 * is the source of truth) and, on change, pushes a new URL built from those
 * values — Next re-renders the (Server Component) section against the new
 * search params, which is what actually re-runs `listChangeEvents`; this
 * component holds no event data itself, so it stays free of any `db`/pg
 * import.
 *
 * The keys it writes come from `./filter-params`, the same module the section
 * reads them back with — see that file for why the derivation is shared
 * rather than spelled out on each side. Pushes merge against the CURRENT
 * search params instead of starting empty, because the atomic-updates section
 * on this same page has filters of its own that a push here must preserve.
 *
 * `scroll: false` on every push: this bar sits below seven other cards on a
 * long settings page, and the App Router's default (`scroll: true`) would
 * throw the user back up to "Company context" on every filter change.
 */
export function ChangeEventsFilters({
  type,
  provider,
  assignment,
  showHidden,
  basePath = "/company",
}: ChangeEventsFilterState & { basePath?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state: ChangeEventsFilterState = { type, provider, assignment, showHidden };
  const hasActiveFilters = !changeEventsFiltersAreDefault(state);

  function pushState(next: ChangeEventsFilterState) {
    const params = writeChangeEventsFilters(new URLSearchParams(searchParams.toString()), next);
    router.push(`${basePath}${toQuerySuffix(params)}`, { scroll: false });
  }

  function push(next: Partial<ChangeEventsFilterState>) {
    pushState({ ...state, ...next });
  }

  function clearFilters() {
    pushState(CHANGE_EVENTS_DEFAULTS);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={type} onValueChange={(value) => push({ type: value as ChangeEventsFilterState["type"] })}>
        <SelectTrigger className="w-40">
          <SelectValue>{labelFor(TYPE_OPTIONS, type)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TYPE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={provider}
        onValueChange={(value) => push({ provider: value as ChangeEventsFilterState["provider"] })}
      >
        <SelectTrigger className="w-40">
          <SelectValue>{labelFor(PROVIDER_OPTIONS, provider)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Ungrouped is the default, but the other two are not decoration: bulk
          delete and bulk reassign over GROUPED events exist on no other
          surface now that the standalone tab is retired — through the
          evidence drawer a grouped event is reachable only one at a time. */}
      <Select
        value={assignment}
        onValueChange={(value) => push({ assignment: value as ChangeEventsFilterState["assignment"] })}
      >
        <SelectTrigger className="w-40">
          <SelectValue>{labelFor(ASSIGNMENT_OPTIONS, assignment)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ASSIGNMENT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ml-auto flex items-center gap-3">
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
        <Label>
          <Switch
            checked={showHidden}
            onCheckedChange={(checked) => push({ showHidden: checked })}
          />
          Show hidden
        </Label>
      </div>
    </div>
  );
}
