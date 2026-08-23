import { cn } from "@/lib/utils";

/**
 * Column classes for the two card rows whose LENGTH is a tenant setting.
 *
 * Both rows are one card per engine: the overview's tiles (enabled engines plus
 * the pooled "All engines") and the prompt detail's per-engine cards. Engines
 * are toggled per tenant, so those rows are 2–4 and 1–3 cards long — never a
 * fixed number. Both were hard-coded for a four-engine world that has not
 * existed since Perplexity was cut: `xl:grid-cols-5` held five columns for at
 * most four tiles, `xl:grid-cols-4` four for at most three cards, and every
 * tenant saw a permanent empty column at the end of the row.
 *
 * Sizing for the maximum is the same mistake one column smaller, so the count
 * decides. The classes are written out in full because Tailwind scans for
 * literal strings — a template built from `count` compiles to nothing.
 *
 * Two columns from `sm` up throughout: below `xl` there is no width for three
 * cards that still fit a "Collecting baseline" headline without wrapping, and a
 * single count-2 row of half-width cards is the shape the design already uses
 * for a pair.
 */
const COLUMNS: Record<number, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 xl:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

/**
 * The complete class for a card row of `count` cards, gap included, so the two
 * callers cannot drift on spacing.
 *
 * A count outside 1–4 falls back to the four-column row: engines are capped at
 * three today, and a fifth engine is a change that should widen the row rather
 * than silently collapse it to one column.
 */
export function engineGridClass(count: number): string {
  return cn("grid gap-3", COLUMNS[count] ?? COLUMNS[4]);
}
