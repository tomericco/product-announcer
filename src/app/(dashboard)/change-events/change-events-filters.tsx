"use client";

import { useRouter } from "next/navigation";
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
 * Filter bar for /change-events. Reads its current values as props from the
 * server-rendered page (never from `useSearchParams` — the page prop is the
 * source of truth per the getting-started docs' "load data for the page"
 * guidance) and, on change, pushes a new URL built from those values. Next
 * re-renders the (Server Component) page against the new search params,
 * which is what actually re-runs `listChangeEvents`/re-filters the list —
 * this component holds no event data itself, so it stays free of any
 * `db`/pg import.
 */
export function ChangeEventsFilters({ type, provider, assignment, showHidden }: FilterState) {
  const router = useRouter();

  const hasActiveFilters =
    type !== "all" || provider !== "all" || assignment !== "all" || showHidden;

  function push(next: Partial<FilterState>) {
    const merged: FilterState = { type, provider, assignment, showHidden, ...next };
    const params = new URLSearchParams();
    if (merged.type !== "all") params.set("type", merged.type);
    if (merged.provider !== "all") params.set("provider", merged.provider);
    if (merged.assignment !== "all") params.set("assignment", merged.assignment);
    if (merged.showHidden) params.set("showHidden", "1");
    const qs = params.toString();
    router.push(qs ? `/change-events?${qs}` : "/change-events");
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

      <div className="ml-auto flex items-center gap-3">
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={() => router.push("/change-events")}>
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
