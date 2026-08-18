"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveCalendarSettings } from "./actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
// From `@/lib/workspace/calendar-settings`, NEVER `@/lib/content/holidays`:
// this is a "use client" file, and the holidays module imports
// `date-holidays`, whose worldwide rule and translation data would be pulled
// into the browser bundle wholesale. The settings vocabulary is split into its
// own dependency-free module for exactly this — same shape of split as
// `calendar-view.ts` vs `calendar.ts`.
import {
  HOLIDAY_COUNTRIES,
  WEEK_START_OPTIONS,
  type WeekStartsOn,
} from "@/lib/workspace/calendar-settings";

export function CalendarForm({
  defaults,
}: {
  defaults: { weekStartsOn: WeekStartsOn; holidayCountries: string[] };
}) {
  const [weekStartsOn, setWeekStartsOn] = useState(String(defaults.weekStartsOn));

  async function handleSave(formData: FormData) {
    await saveCalendarSettings(formData);
    toast.success("Calendar settings saved");
  }

  const weekStartLabel =
    WEEK_START_OPTIONS.find((o) => String(o.value) === weekStartsOn)?.label ?? weekStartsOn;

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Week starts on</Label>
        <p className="text-xs text-muted-foreground">The first column of the calendar grid.</p>
        <Select
          name="weekStartsOn"
          value={weekStartsOn}
          onValueChange={(value) => setWeekStartsOn(value as string)}
        >
          <SelectTrigger>
            {/* Rendered explicitly so the trigger matches the menu during SSR,
                before Base UI registers the items — same as ScheduleForm. */}
            <SelectValue>{weekStartLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {WEEK_START_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Public holidays</Label>
        <p className="text-xs text-muted-foreground">
          Show each country&apos;s public holidays on the calendar.
        </p>
        <div className="space-y-1">
          {HOLIDAY_COUNTRIES.map((country) => (
            <label key={country.code} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="holidayCountries"
                value={country.code}
                defaultChecked={defaults.holidayCountries.includes(country.code)}
                className="size-4 rounded border-input"
              />
              {country.label}
            </label>
          ))}
        </div>
      </div>

      <Button type="submit" variant="outline">
        Save
      </Button>
    </form>
  );
}
