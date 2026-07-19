"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWorkspaceSchedule } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CADENCES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "none", label: "No fixed cadence" },
];

const WEEKDAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00`,
}));

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

export function ScheduleForm({
  defaults,
}: {
  defaults: {
    cadence: string;
    threshold: number | null;
    thresholdEnabled: boolean;
    hour: number;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
  };
}) {
  const [cadence, setCadence] = useState(defaults.cadence);
  const [hour, setHour] = useState(String(defaults.hour));
  const [dayOfWeek, setDayOfWeek] = useState(String(defaults.dayOfWeek ?? 1));
  const [dayOfMonth, setDayOfMonth] = useState(String(defaults.dayOfMonth ?? 1));
  const [thresholdEnabled, setThresholdEnabled] = useState(defaults.thresholdEnabled);

  async function handleSave(formData: FormData) {
    await saveWorkspaceSchedule(formData);
    toast.success("Publishing schedule saved");
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Cadence</Label>
        <p className="text-xs text-muted-foreground">
          How often pending changes are automatically bundled into a new update.
        </p>
        <Select name="cadence" value={cadence} onValueChange={(value) => setCadence(value as string)}>
          <SelectTrigger>
            {/* Render the label explicitly so the trigger matches the menu casing
                even during SSR (before Base UI registers the items). */}
            <SelectValue>{labelFor(CADENCES, cadence)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CADENCES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(cadence === "weekly" || cadence === "biweekly") && (
        <div className="space-y-2">
          <Label>Day of week</Label>
          <Select name="dayOfWeek" value={dayOfWeek} onValueChange={(value) => setDayOfWeek(value as string)}>
            <SelectTrigger>
              <SelectValue>{labelFor(WEEKDAYS, dayOfWeek)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {WEEKDAYS.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {cadence === "monthly" && (
        <div className="space-y-2">
          <Label>Day of month</Label>
          <Select name="dayOfMonth" value={dayOfMonth} onValueChange={(value) => setDayOfMonth(value as string)}>
            <SelectTrigger>
              <SelectValue>{dayOfMonth}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DAYS_OF_MONTH.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {cadence !== "none" && (
        <div className="space-y-2">
          <Label>Time of day</Label>
          <p className="text-xs text-muted-foreground">
            The hour (UTC) the update is generated.
          </p>
          <Select name="hour" value={hour} onValueChange={(value) => setHour(value as string)}>
            <SelectTrigger>
              <SelectValue>{labelFor(HOURS, hour)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch
            name="thresholdEnabled"
            checked={thresholdEnabled}
            onCheckedChange={(checked) => setThresholdEnabled(checked as boolean)}
          />
          Publish early when changes pile up
        </label>
        <p className="text-xs text-muted-foreground">
          When on, generate an update as soon as at least this many changes are pending, without
          waiting for the next scheduled run.
        </p>
        <Input
          id="threshold"
          type="number"
          name="threshold"
          min={1}
          defaultValue={defaults.threshold ?? 5}
          disabled={!thresholdEnabled}
        />
      </div>

      <Button type="submit" variant="outline">
        Save
      </Button>
    </form>
  );
}
