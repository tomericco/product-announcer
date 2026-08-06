"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { briefStatusEnum, type Brief } from "@/db/schema";

const STATUS_OPTIONS: { value: Brief["status"]; label: string }[] = briefStatusEnum.enumValues.map(
  (value) => ({
    value,
    label: value === "new" ? "New" : value.charAt(0).toUpperCase() + value.slice(1),
  })
);

function labelFor(value: Brief["status"]) {
  return STATUS_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * The single filter on `/briefs`. Unlike `SignalsFilters`, there is no "all"
 * option: `listBriefs` always scopes to exactly one status (defaulting to
 * `new`), because `briefs.status` is a decision — new, accepted, dismissed,
 * expired — and mixing them in one list would blur what's still awaiting a
 * human.
 *
 * Reads its current value as a prop from the server-rendered page (never
 * `useSearchParams`) and pushes a new URL on change, the same convention as
 * `SignalsFilters`.
 */
export function BriefsFilters({ status }: { status: Brief["status"] }) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-3">
      <Select
        value={status}
        onValueChange={(value) => {
          const next = value as Brief["status"];
          router.push(next === "new" ? "/briefs" : `/briefs?status=${next}`);
        }}
      >
        <SelectTrigger className="w-44">
          <SelectValue>{labelFor(status)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
