"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Brief } from "@/db/schema";

// Mirrors `briefStatusEnum` in src/db/schema.ts. Local `as const` array
// rather than importing the enum object as a runtime value — same reasoning
// as `KIND_VALUES` in src/lib/signals/params.ts and `DISMISS_REASON_VALUES`
// in brief-decision.tsx: this is a client component, and every other client
// component in this codebase imports only types from `@/db/schema`, never
// the (large, comment-heavy) module itself. Changing one of these four
// values means changing the enum too.
const STATUS_VALUES = ["new", "accepted", "dismissed", "expired"] as const;

const STATUS_OPTIONS: { value: Brief["status"]; label: string }[] = STATUS_VALUES.map((value) => ({
  value,
  label: value === "new" ? "New" : value.charAt(0).toUpperCase() + value.slice(1),
}));

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
