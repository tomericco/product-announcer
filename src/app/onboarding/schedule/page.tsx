import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { saveOnboardingSchedule, skipScheduleStep } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default async function ScheduleStepPage() {
  await guardOnboardingStep(4);

  return (
    <div className="space-y-8">
      <StepHeader
        step={4}
        title="Choose your rhythm"
        description="How often should we draft an update? Change it anytime in Settings."
      />
      <form action={saveOnboardingSchedule} className="space-y-6">
        <div className="space-y-2">
          <Label>Cadence</Label>
          <Select name="cadence" defaultValue="none">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="biweekly">Every 2 weeks</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              {/* Label matches the canonical list in settings/schedule-form.tsx. */}
              <SelectItem value="none">No fixed cadence</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="threshold">Or after at least this many changes</Label>
          <Input id="threshold" type="number" name="threshold" min={1} defaultValue={5} />
        </div>
        <Button type="submit" className="w-full">
          Finish setup
        </Button>
      </form>
      <form action={skipScheduleStep}>
        <Button type="submit" variant="ghost" className="text-muted-foreground w-full">
          Skip for now
        </Button>
      </form>
    </div>
  );
}
