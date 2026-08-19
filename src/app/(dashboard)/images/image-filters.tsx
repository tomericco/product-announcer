"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ImageFilterState = { pieceId: string; role: string; source: string };

const ROLE_OPTIONS = [
  { value: "all", label: "All roles" },
  { value: "cover", label: "Cover" },
  { value: "body", label: "Body" },
  { value: "library", label: "Library" },
];
const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "generated", label: "Generated" },
  { value: "uploaded", label: "Uploaded" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * Same shape as company/change-events-filters.tsx: values come from the
 * server-rendered page (searchParams is the source of truth); a change pushes
 * a new URL and the Server Component re-runs `listLibraryImages`.
 */
export function ImageFilters({ state, pieces }: { state: ImageFilterState; pieces: { id: string; title: string }[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function push(next: Partial<ImageFilterState>) {
    const merged = { ...state, ...next };
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(merged)) {
      if (value === "all" || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.push(`/images${qs ? `?${qs}` : ""}`, { scroll: false });
  }

  const active = state.pieceId !== "all" || state.role !== "all" || state.source !== "all";
  const pieceOptions = [{ value: "all", label: "All pieces" }, ...pieces.map((p) => ({ value: p.id, label: p.title || "Untitled" }))];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={state.pieceId} onValueChange={(v) => push({ pieceId: String(v) })}>
        <SelectTrigger className="w-56">
          <SelectValue>{labelFor(pieceOptions, state.pieceId)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {pieceOptions.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={state.role} onValueChange={(v) => push({ role: String(v) })}>
        <SelectTrigger className="w-36">
          <SelectValue>{labelFor(ROLE_OPTIONS, state.role)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ROLE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={state.source} onValueChange={(v) => push({ source: String(v) })}>
        <SelectTrigger className="w-40">
          <SelectValue>{labelFor(SOURCE_OPTIONS, state.source)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SOURCE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active && (
        <Button type="button" variant="ghost" size="sm" onClick={() => push({ pieceId: "all", role: "all", source: "all" })}>
          Clear
        </Button>
      )}
    </div>
  );
}
