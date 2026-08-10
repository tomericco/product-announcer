import { requireSession } from "@/lib/workspace/session";
import { readMonth } from "@/lib/content/calendar";
import { single } from "@/lib/signals/params";
import { MonthGrid } from "./month-grid";

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Falls back to the current month for anything that isn't a clean
 * `YYYY-MM` in range — absent, malformed (`?month=nonsense`), out-of-range
 * (`?month=2026-13`), or repeated (`?month=a&month=b`, where `single()`
 * already collapses to the first value before this runs). A bad query
 * string is a navigation mistake, not an error condition, so this never
 * throws.
 */
function resolveMonth(raw: string | undefined): string {
  const now = new Date();
  const fallback = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  if (!raw || !MONTH_RE.test(raw)) return fallback;
  const [, yearStr, monthStr] = raw.match(/^(\d{4})-(\d{2})$/)!;
  const monthNum = Number(monthStr);
  if (monthNum < 1 || monthNum > 12) return fallback;
  return `${yearStr}-${monthStr}`;
}

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
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const month = resolveMonth(single(params.month));

  const session = await requireSession();
  const data = await readMonth(session.user.tenantId, month);

  return (
    <div className="flex flex-1 flex-col gap-4">
      <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Calendar</h1>
      <MonthGrid month={month} pieces={data.pieces} undatedPublished={data.undatedPublished} />
    </div>
  );
}
