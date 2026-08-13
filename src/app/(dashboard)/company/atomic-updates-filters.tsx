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

const CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  { value: "new", label: "New" },
  { value: "improvement", label: "Improvement" },
  { value: "fix", label: "Fix" },
  { value: "announcement", label: "Announcement" },
];

const SIZE_OPTIONS = [
  { value: "all", label: "All sizes" },
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
  { value: "xl", label: "XL" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

type FilterState = {
  category: string;
  size: string;
  showHidden: boolean;
};

/**
 * Filter bar shared by /atomic-updates and the Company page's atomic-updates
 * ledger section, mirroring `ChangeEventsFilters`: current values arrive as
 * props from the server-rendered page/section (search params are the source
 * of truth), and on change it pushes a new URL built from them. Next
 * re-renders the Server Component against the new params, which re-runs
 * `listAtomicUpdates` — this component holds no update data and never
 * imports `db`.
 *
 * `basePath` and `paramPrefix` exist for the same reason as in
 * `ChangeEventsFilters`: on /company this bar shares a page with the
 * change-events section, both of which use "showHidden" as a concept, so
 * pushes must merge against the CURRENT search params (not start empty) and
 * this bar's own keys must be prefixed to avoid colliding with the other
 * section's. Both default to the values that reproduce the original
 * /atomic-updates-only behavior exactly.
 */
export function AtomicUpdatesFilters({
  category,
  size,
  showHidden,
  basePath = "/atomic-updates",
  paramPrefix = "",
}: FilterState & { basePath?: string; paramPrefix?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const key = (name: string) => `${paramPrefix}${name}`;

  const hasActiveFilters = category !== "all" || size !== "all" || showHidden;

  function push(next: Partial<FilterState>) {
    const merged: FilterState = { category, size, showHidden, ...next };
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key("category"));
    params.delete(key("size"));
    params.delete(key("showHidden"));
    if (merged.category !== "all") params.set(key("category"), merged.category);
    if (merged.size !== "all") params.set(key("size"), merged.size);
    if (merged.showHidden) params.set(key("showHidden"), "1");
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(key("category"));
    params.delete(key("size"));
    params.delete(key("showHidden"));
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={category} onValueChange={(value) => push({ category: value as string })}>
        <SelectTrigger className="w-44">
          <SelectValue>{labelFor(CATEGORY_OPTIONS, category)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CATEGORY_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={size} onValueChange={(value) => push({ size: value as string })}>
        <SelectTrigger className="w-32">
          <SelectValue>{labelFor(SIZE_OPTIONS, size)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SIZE_OPTIONS.map((option) => (
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
