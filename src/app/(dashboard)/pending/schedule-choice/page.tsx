import { chooseSchedule } from "../actions";

export default async function ScheduleChoicePage({
  searchParams,
}: {
  searchParams: Promise<{ repoId: string }>;
}) {
  const { repoId } = await searchParams;

  return (
    <div className="space-y-4 max-w-md">
      <h1 className="text-xl font-semibold">Update generated</h1>
      <p>Keep the next scheduled update as planned, or skip it since you just ran one manually?</p>
      <div className="flex gap-4">
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="keep" />
          <button type="submit" className="border px-4 py-2">
            Keep next scheduled update
          </button>
        </form>
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="skip" />
          <button type="submit" className="border px-4 py-2">
            Skip it
          </button>
        </form>
      </div>
    </div>
  );
}
