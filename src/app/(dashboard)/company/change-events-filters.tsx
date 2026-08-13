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
  { value: "all", label: "All" },
  { value: "assigned", label: "Assigned" },
  { value: "unassigned", label: "Unassigned" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

type FilterState = {
  type: string;
  provider: string;
  assignment: string;
  showHidden: boolean;
};

/**
 * Filter bar shared by /change-events and the Company page's ungrouped-queue
 * section. Reads its current values as props from the server-rendered page
 * (the page's `searchParams` is the source of truth) and, on change, pushes a
 * new URL built from those values — Next re-renders the (Server Component)
 * page/section against the new search params, which is what actually re-runs
 * `listChangeEvents`; this component holds no event data itself, so it stays
 * free of any `db`/pg import.
 *
 * `basePath` and `paramPrefix` exist because this bar now shares a page with
 * `AtomicUpdatesFilters` (both /company sections use "showHidden" as a
 * concept): a standalone route can build its query string from scratch, but
 * /company must preserve the OTHER section's query params on every push, and
 * the two sections' filters must not collide under the same key — hence
 * reading `useSearchParams()` as the base to mutate rather than starting
 * empty, and prefixing this bar's own keys. Both default to the values that
 * reproduce the original /change-events-only behavior exactly, so the
 * standalone route needs no prop changes.
 */
export function ChangeEventsFilters({
  type,
  provider,
  assignment,
  showHidden,
  basePath = "/change-events",
  paramPrefix = "",
  showAssignmentFilter = true,
}: FilterState & { basePath?: string; paramPrefix?: string; showAssignmentFilter?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const key = (name: string) => `${paramPrefix}${name}`;

  const hasActiveFilters =
    type !== "all" || provider !== "all" || (showAssignmentFilter && assignment !== "all") || showHidden;

  function push(next: Partial<FilterState>) {
    const merged: FilterState = { type, provider, assignment, showHidden, ...next };
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key("type"));
    params.delete(key("provider"));
    params.delete(key("assignment"));
    params.delete(key("showHidden"));
    if (merged.type !== "all") params.set(key("type"), merged.type);
    if (merged.provider !== "all") params.set(key("provider"), merged.provider);
    if (showAssignmentFilter && merged.assignment !== "all") params.set(key("assignment"), merged.assignment);
    if (merged.showHidden) params.set(key("showHidden"), "1");
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key("type"));
    params.delete(key("provider"));
    params.delete(key("assignment"));
    params.delete(key("showHidden"));
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={type} onValueChange={(value) => push({ type: value as string })}>
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

      <Select value={provider} onValueChange={(value) => push({ provider: value as string })}>
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

      {showAssignmentFilter && (
        <Select value={assignment} onValueChange={(value) => push({ assignment: value as string })}>
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
      )}

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
