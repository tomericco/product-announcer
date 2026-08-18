import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { saveOnboardingSchedule, skipScheduleStep } from "../actions";
import { HourSelect } from "./hour-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default async function ScheduleStepPage() {
  await guardOnboardingStep(4);

  return (
    <div className="space-y-8">
      <StepHeader
        step={4}
        title="Choose your rhythm"
        description="What hour should the ideation agent run? Change it anytime in Settings."
      />
      <form action={saveOnboardingSchedule} className="space-y-6">
        <div className="space-y-2">
          <Label>Run daily at</Label>
          <HourSelect defaultValue="9" />
        </div>
        <Button type="submit" className="w-full">
          Finish setup
        </Button>
      </form>
      <form action={skipScheduleStep} className="flex justify-center">
        <Button type="submit" variant="ghost" className="text-muted-foreground">
          Skip for now
        </Button>
      </form>
    </div>
  );
}
