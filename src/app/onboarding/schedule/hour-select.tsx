"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Same labels as the canonical list in (dashboard)/settings/schedule-form.tsx.
const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00`,
}));

function labelFor(value: string | null): string {
  return HOURS.find((h) => h.value === value)?.label ?? "";
}

/**
 * A client component only because `SelectValue`'s formatter is a function, which
 * cannot be passed across the server/client boundary.
 *
 * That formatter is the point: a bare `<SelectValue />` renders the raw value, so
 * the closed control read "9" while the open menu read "09:00". Routing the
 * trigger through the same label map keeps the two in agreement.
 */
export function HourSelect({ defaultValue = "9" }: { defaultValue?: string }) {
  return (
    <Select name="hour" defaultValue={defaultValue}>
      <SelectTrigger>
        <SelectValue>{(value: string | null) => labelFor(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {HOURS.map((h) => (
          <SelectItem key={h.value} value={h.value}>
            {h.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
