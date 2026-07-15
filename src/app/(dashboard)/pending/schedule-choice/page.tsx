import { chooseSchedule } from "../actions";
import { Button } from "@/components/ui/button";

export default async function ScheduleChoicePage({
  searchParams,
}: {
  searchParams: Promise<{ repoId: string }>;
}) {
  const { repoId } = await searchParams;

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Update generated</h1>
      <p className="text-sm text-muted-foreground">
        Keep the next scheduled update as planned, or skip it since you just ran one manually?
      </p>
      <div className="flex gap-3">
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="keep" />
          <Button type="submit" variant="outline">
            Keep next scheduled update
          </Button>
        </form>
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="skip" />
          <Button type="submit" variant="outline">
            Skip it
          </Button>
        </form>
      </div>
    </div>
  );
}
