"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const KIND_OPTIONS = [
  { value: "all", label: "All kinds" },
  { value: "shipped_work", label: "Shipped work" },
  { value: "competitor_move", label: "Competitor move" },
  { value: "market_news", label: "Market news" },
  { value: "manual", label: "Manual" },
  { value: "ai_visibility", label: "AI visibility" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

type FilterState = {
  kind: string;
  competitorId: string;
  minScore: string;
  from: string;
  to: string;
  includeStale: boolean;
};

const COMMIT_DEBOUNCE_MS = 500;

/**
 * Buffers a free-text filter locally and commits it (via `onCommit`, which
 * pushes a new URL and re-renders the Server Component page) on a debounce,
 * or immediately when the caller calls `commitNow` (blur/Enter).
 *
 * Why this exists: `minScore` and the date inputs used to be controlled
 * straight from the server-rendered `value` prop with every keystroke pushing
 * a new route immediately. Typing "0.55" fired four navigations; when the
 * first one landed with `minScore=0`, the page re-rendered with that prop and
 * React reset the DOM value mid-type, discarding the rest of what was typed.
 * Buffering locally means the input always reflects what the user is
 * actually typing, and only the settled value is pushed.
 *
 * `value` still wins over local state when it changes for a reason other
 * than our own last commit — "Clear filters", browser back/forward, or
 * another filter control's push replacing the whole query string. `lastCommitted`
 * is what distinguishes "the server echoed back what we just sent" (ignore)
 * from "something else changed this filter out from under us" (resync).
 */
function useDebouncedFilterValue(value: string, onCommit: (next: string) => void, delay = COMMIT_DEBOUNCE_MS) {
  const [local, setLocal] = useState(value);
  const lastCommitted = useRef(value);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value !== lastCommitted.current) {
      setLocal(value);
      lastCommitted.current = value;
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  function handleChange(next: string) {
    setLocal(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      lastCommitted.current = next;
      onCommit(next);
    }, delay);
  }

  function commitNow() {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (local !== lastCommitted.current) {
      lastCommitted.current = local;
      onCommit(local);
    }
  }

  return { local, handleChange, commitNow };
}

// Mirrors `DateFilter` in change-events/import-dialog.tsx: native
// <input type="date"> ignores `placeholder`, so this renders as a text input
// (showing the placeholder) while empty and unfocused, and swaps to a real
// date picker on focus or once a date is set.
//
// Debounced like `minScore` (see `useDebouncedFilterValue`) rather than
// pushed on every change: a date picker's `onChange` fires per keystroke while
// typing digits directly into the text-mode field too, and the same
// value-reset-mid-type bug applies. Also commits immediately on blur, so
// picking a date from the native calendar (which fires one `onChange` then
// blurs) doesn't wait out the debounce.
function DateFilter({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  const { local, handleChange, commitNow } = useDebouncedFilterValue(value, onChange);
  return (
    <Input
      type={local || focused ? "date" : "text"}
      className="w-36"
      placeholder={placeholder}
      aria-label={placeholder}
      value={local}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commitNow();
      }}
      onChange={(e) => handleChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitNow();
      }}
    />
  );
}

/**
 * Filter bar for /signals, mirroring `ChangeEventsFilters`: reads its current
 * values as props from the server-rendered page (never `useSearchParams`) and,
 * on change, pushes a new URL built from those values so the (Server
 * Component) page re-runs `listSignals` against the new search params. This
 * component holds no signal data itself and never imports `db`/pg.
 *
 * `from`/`to` filter `occurredAt` — when the thing happened — which is a
 * different question from the 60-day `createdAt` retention window `listSignals`
 * always applies underneath; there is deliberately no control here that could
 * widen that window, because none exists as a filter to widen.
 *
 * `minScore` is a plain text field rather than a slider: unscored signals
 * (relevanceScore null) always survive this filter regardless of its value,
 * which a slider's implied 0..1 range would misleadingly suggest it controls.
 *
 * `kind`, `competitorId` and `includeStale` push on every change and need no
 * debouncing — they're a Select/Switch, so every "change" is already one
 * discrete, complete value, unlike a free-text field mid-keystroke.
 */
export function SignalsFilters({
  kind,
  competitorId,
  minScore,
  from,
  to,
  includeStale,
  competitors,
}: FilterState & { competitors: { id: string; name: string }[] }) {
  const router = useRouter();

  const hasActiveFilters =
    kind !== "all" || competitorId !== "all" || minScore !== "" || from !== "" || to !== "" || includeStale;

  function push(next: Partial<FilterState>) {
    const merged: FilterState = { kind, competitorId, minScore, from, to, includeStale, ...next };
    const params = new URLSearchParams();
    if (merged.kind !== "all") params.set("kind", merged.kind);
    if (merged.competitorId !== "all") params.set("competitorId", merged.competitorId);
    if (merged.minScore !== "") params.set("minScore", merged.minScore);
    if (merged.from !== "") params.set("from", merged.from);
    if (merged.to !== "") params.set("to", merged.to);
    if (merged.includeStale) params.set("includeStale", "1");
    const qs = params.toString();
    router.push(qs ? `/signals?${qs}` : "/signals");
  }

  const minScoreFilter = useDebouncedFilterValue(minScore, (value) => push({ minScore: value }));

  const competitorOptions = [
    { value: "all", label: "All competitors" },
    ...competitors.map((competitor) => ({ value: competitor.id, label: competitor.name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={kind} onValueChange={(value) => push({ kind: value as string })}>
        <SelectTrigger className="w-44">
          <SelectValue>{labelFor(KIND_OPTIONS, kind)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {KIND_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {competitors.length > 0 && (
        <Select value={competitorId} onValueChange={(value) => push({ competitorId: value as string })}>
          <SelectTrigger className="w-44">
            <SelectValue>{labelFor(competitorOptions, competitorId)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {competitorOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex items-center gap-1.5">
        <DateFilter value={from} onChange={(v) => push({ from: v })} placeholder="From" />
        <DateFilter value={to} onChange={(v) => push({ to: v })} placeholder="To" />
      </div>

      <Input
        type="number"
        min={0}
        max={1}
        step={0.05}
        placeholder="Min score"
        aria-label="Minimum relevance score"
        className="w-28"
        value={minScoreFilter.local}
        onChange={(e) => minScoreFilter.handleChange(e.target.value)}
        onBlur={minScoreFilter.commitNow}
        onKeyDown={(e) => {
          if (e.key === "Enter") minScoreFilter.commitNow();
        }}
      />

      <div className="ml-auto flex items-center gap-3">
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={() => router.push("/signals")}>
            Clear filters
          </Button>
        )}
        <Label>
          <Switch checked={includeStale} onCheckedChange={(checked) => push({ includeStale: checked })} />
          Show stale
        </Label>
      </div>
    </div>
  );
}
