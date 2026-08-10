import { requireSession } from "@/lib/workspace/session";
import { readMonth } from "@/lib/content/calendar";
import { resolveMonth, isValidMonthParam } from "@/lib/content/calendar-view";
import { single } from "@/lib/signals/params";
import { MonthGrid } from "./month-grid";

/**
 * `/calendar`: a read-only month view over `content_pieces` — nothing here
 * writes. `searchParams` is a Promise in this Next.js version, per the
 * "Rendering with search params" note in
 * node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md,
 * mirroring `/signals` and `/board`.
 *
 * `readMonth` runs here, on the server, because it imports the database.
 * `bucketByLocalDay` deliberately does NOT run here — see `month-grid.tsx`,
 * a Client Component, for why "local day" has to mean local to the viewer,
 * not to this server process.
 *
 * A missing/malformed `?month=` gets the same treatment: `resolveMonth`
 * falls back to THIS process's `now`, which is only ever a first-paint
 * guess — the server has no idea what month it is for the viewer. `isDefaulted`
 * tells `MonthGrid` whether that guess happened at all, so it can redo the
 * fallback against the viewer's real clock once mounted and navigate to the
 * correct month if the two disagree. See month-grid.tsx's effect.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const rawMonth = single(params.month);
  const month = resolveMonth(rawMonth);
  const isDefaulted = !isValidMonthParam(rawMonth);

  const session = await requireSession();
  const data = await readMonth(session.user.tenantId, month);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Calendar</h1>
      <MonthGrid
        month={month}
        isDefaulted={isDefaulted}
        pieces={data.pieces}
        undatedPublished={data.undatedPublished}
      />
    </div>
  );
}
