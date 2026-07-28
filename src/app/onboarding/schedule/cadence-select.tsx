"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Same labels as the canonical list in (dashboard)/settings/schedule-form.tsx.
const CADENCES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "none", label: "No fixed cadence" },
];

function labelFor(value: string | null): string {
  return CADENCES.find((c) => c.value === value)?.label ?? "";
}

/**
 * A client component only because `SelectValue`'s formatter is a function, which
 * cannot be passed across the server/client boundary.
 *
 * That formatter is the point: a bare `<SelectValue />` renders the raw value, so
 * the closed control read "none" while the open menu read "No fixed cadence".
 * Routing the trigger through the same label map keeps the two in agreement.
 */
export function CadenceSelect({ defaultValue = "none" }: { defaultValue?: string }) {
  return (
    <Select name="cadence" defaultValue={defaultValue}>
      <SelectTrigger>
        <SelectValue>{(value: string | null) => labelFor(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {CADENCES.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
