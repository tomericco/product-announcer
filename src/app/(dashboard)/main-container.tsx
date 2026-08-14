"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The dashboard's content column. Reading-shaped pages stay at max-w-4xl —
 * a measure that keeps prose and forms readable. Wide routes opt out: the
 * board is five side-by-side columns and the calendar is a seven-day grid,
 * and squeezing either into 56rem forces horizontal scrolling that hides
 * the very columns those pages exist to show.
 *
 * A client component because the parent layout is a Server Component and
 * cannot read the current route; a nested route layout would not help,
 * since it renders *inside* this element's max-width.
 */
const WIDE_ROUTES = ["/board", "/calendar"];

export function MainContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const wide = WIDE_ROUTES.some((href) => pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className={cn("mx-auto flex w-full flex-1 flex-col", wide ? "max-w-none" : "max-w-4xl")}>
      {children}
    </div>
  );
}
