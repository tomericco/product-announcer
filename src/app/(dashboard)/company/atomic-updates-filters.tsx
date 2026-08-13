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
  atomicUpdatesFiltersAreDefault,
  toQuerySuffix,
  writeAtomicUpdatesFilters,
  ATOMIC_UPDATES_DEFAULTS,
  type AtomicUpdatesFilterState,
} from "./filter-params";

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

/**
 * Filter bar for the Company page's atomic-updates ledger section, mirroring
 * `ChangeEventsFilters`: current values arrive as props from the
 * server-rendered section (search params are the source of truth), and on
 * change it pushes a new URL built from them. Next re-renders the Server
 * Component against the new params, which re-runs `listAtomicUpdates` — this
 * component holds no update data and never imports `db`.
 *
 * The keys it writes come from `./filter-params`, the same module the section
 * reads them back with; pushes merge against the CURRENT search params so the
 * change-events section's filters on this same page survive. "Show hidden" is
 * the load-bearing one: `listAtomicUpdates` returns only `status='open'`
 * without it, so it is the ONLY way to reach a hidden atomic update, and
 * therefore the only entry point to Unhide anywhere in the product.
 *
 * `scroll: false` on every push, for the same reason as the change-events bar
 * — both sit at the bottom of a long settings page.
 */
export function AtomicUpdatesFilters({
  category,
  size,
  showHidden,
  basePath = "/company",
}: AtomicUpdatesFilterState & { basePath?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const state: AtomicUpdatesFilterState = { category, size, showHidden };
  const hasActiveFilters = !atomicUpdatesFiltersAreDefault(state);

  function pushState(next: AtomicUpdatesFilterState) {
    const params = writeAtomicUpdatesFilters(new URLSearchParams(searchParams.toString()), next);
    router.push(`${basePath}${toQuerySuffix(params)}`, { scroll: false });
  }

  function push(next: Partial<AtomicUpdatesFilterState>) {
    pushState({ ...state, ...next });
  }

  function clearFilters() {
    pushState(ATOMIC_UPDATES_DEFAULTS);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        value={category}
        onValueChange={(value) => push({ category: value as AtomicUpdatesFilterState["category"] })}
      >
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

      <Select value={size} onValueChange={(value) => push({ size: value as AtomicUpdatesFilterState["size"] })}>
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
