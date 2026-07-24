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
 * Filter bar for /atomic-updates, mirroring `ChangeEventsFilters`: current
 * values arrive as props from the server-rendered page (the page's search
 * params are the source of truth), and on change it pushes a new URL built
 * from them. Next re-renders the Server Component page against the new params,
 * which re-runs `listAtomicUpdates` with the filters — this component holds no
 * update data and never imports `db`.
 */
export function AtomicUpdatesFilters({ category, size, showHidden }: FilterState) {
  const router = useRouter();

  const hasActiveFilters = category !== "all" || size !== "all" || showHidden;

  function push(next: Partial<FilterState>) {
    const merged: FilterState = { category, size, showHidden, ...next };
    const params = new URLSearchParams();
    if (merged.category !== "all") params.set("category", merged.category);
    if (merged.size !== "all") params.set("size", merged.size);
    if (merged.showHidden) params.set("showHidden", "1");
    const qs = params.toString();
    router.push(qs ? `/atomic-updates?${qs}` : "/atomic-updates");
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
          <Button variant="ghost" size="sm" onClick={() => router.push("/atomic-updates")}>
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
