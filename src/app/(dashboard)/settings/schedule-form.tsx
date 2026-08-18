"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWorkspaceSchedule } from "./actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${String(h).padStart(2, "0")}:00`,
}));

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

export function ScheduleForm({ defaults }: { defaults: { hour: number } }) {
  const [hour, setHour] = useState(String(defaults.hour));

  async function handleSave(formData: FormData) {
    await saveWorkspaceSchedule(formData);
    toast.success("Publishing schedule saved");
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-2">
        <Label>Run daily at</Label>
        <p className="text-xs text-muted-foreground">
          The hour (UTC) the ideation agent runs.
        </p>
        <Select name="hour" value={hour} onValueChange={(value) => setHour(value as string)}>
          <SelectTrigger>
            {/* Render the label explicitly so the trigger matches the menu casing
                even during SSR (before Base UI registers the items). */}
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

      <Button type="submit" variant="outline">
        Save
      </Button>
    </form>
  );
}
