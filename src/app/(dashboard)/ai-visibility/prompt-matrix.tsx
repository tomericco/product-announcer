"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
// The floor the metrics layer actually applies, not a copy of the number.
// `@/lib/ai-visibility/thresholds` exists so a `"use client"` file can import
// it without dragging `@/db` — where `metrics.ts` re-exports it from — into the
// browser bundle.
import { MIN_N_PROMPT } from "@/lib/ai-visibility/thresholds";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_LABEL, ENGINE_NAME } from "./engine-labels";

export type MatrixCell = {
  named: number | null;
  samples: number;
  failed: boolean;
  /**
   * Distinct tracked competitors named on this prompt/engine over the window.
   *
   * The cell's second fact, and the one that makes a `0/3` readable: with
   * rivals named it is a gap worth writing against, without them it is a
   * question the engine answers naming nobody at all.
   */
  competitors: number;
};

export type MatrixRow = {
  promptId: string;
  text: string;
  branded: boolean;
  /**
   * Keyed by engine, and PARTIAL: the page cuts these to the engines the
   * tenant actually runs, the same list it passes as `engines`.
   */
  cells: Partial<Record<EngineId, MatrixCell>>;
};

/** An engine with no cut at all — never asked, so never a zero. */
const NO_CUT: MatrixCell = { named: null, samples: 0, failed: false, competitors: 0 };

export const MATRIX_INITIAL_ROWS = 20;

/**
 * "2 of 3", rendered as "2/3" for a cell this narrow — never a tick or a
 * cross. A boolean cell would erase the difference between an engine that
 * names us every time and one that names us on a coin flip, which is the
 * difference the whole three-sample design is paying for.
 *
 * `failed` does NOT dash a cell on its own. It says the last run errored on
 * this prompt for this engine; the window is four runs deep, so a cell can
 * carry three earlier runs' answers and still be worth reading. Only the
 * sample floor decides the dash — a failure that left nothing behind fails the
 * floor by itself, and one that did not has no business hiding real readings.
 * The tooltip is where `failed` earns its keep, naming WHICH of the two
 * reasons a dash has.
 *
 * The `gap` tone is the addition: named nowhere, rivals named here. It is a
 * separate tone from `absent` because they are opposite findings that used to
 * render identically — one is a page to write, the other is an engine that
 * answers this question without naming anybody, where no comparison page will
 * help. Both stay off `--destructive`, which this system reserves for real
 * errors: being unnamed on one prompt is work to do, not a fault.
 */
export function cellReading(cell: MatrixCell): {
  text: string;
  tone: "full" | "partial" | "gap" | "absent" | "unavailable";
} {
  if (cell.named === null || cell.samples < MIN_N_PROMPT) {
    return { text: "–", tone: "unavailable" };
  }
  const text = `${cell.named}/${cell.samples}`;
  if (cell.named === cell.samples) return { text, tone: "full" };
  if (cell.named === 0) return { text, tone: cell.competitors > 0 ? "gap" : "absent" };
  return { text, tone: "partial" };
}

/**
 * How many of a row's cells are outright gaps, and how many rivals show up
 * across the row — the two keys "gaps first" sorts on.
 *
 * Read through `cellReading` rather than off the raw counts, so a cell too thin
 * to display cannot contribute to a rank the reader is unable to see. Withheld
 * data must not reorder the table.
 */
export function rowGapScore(row: MatrixRow, engines: readonly EngineId[]): { gaps: number; competitors: number } {
  let gaps = 0;
  let competitors = 0;
  for (const engine of engines) {
    const cell = row.cells[engine] ?? NO_CUT;
    const reading = cellReading(cell);
    if (reading.tone === "unavailable") continue;
    if (reading.tone === "gap") gaps += 1;
    competitors = Math.max(competitors, cell.competitors);
  }
  return { gaps, competitors };
}

export type MatrixSort = "gaps" | "prompt";

/**
 * Rows ordered for the job the matrix exists to do.
 *
 * Default is "gaps first", and that is a deliberate change from creation order:
 * only the first 20 rows render before "Show all", the prompt set is a single
 * batched insert whose order carries no meaning to a reader, and the row worth
 * finding — rivals named, us absent — was as likely to be row 24 as row 3.
 * Creation order stays one click away, because it is the order the prompts page
 * lists them in and a reader cross-referencing the two needs it.
 *
 * Ties break on the widest rival count and then on the original position, so
 * the sort is stable and the same data always renders in the same order.
 */
export function sortRows(
  rows: MatrixRow[],
  engines: readonly EngineId[],
  sort: MatrixSort
): MatrixRow[] {
  if (sort === "prompt") return rows;
  const scored = rows.map((row, index) => ({ row, index, ...rowGapScore(row, engines) }));
  scored.sort((a, b) => {
    if (a.gaps !== b.gaps) return b.gaps - a.gaps;
    if (a.competitors !== b.competitors) return b.competitors - a.competitors;
    return a.index - b.index;
  });
  return scored.map((entry) => entry.row);
}

// brand-subtle is state here (named on every sample), which is exactly what
// the accent is for. Absent is an outline, not a destructive tone: being
// unnamed on one prompt is a gap to work on, not an error. The gap tone keeps
// that outline and makes it --brand-ink, the token the brand guide reserves for
// any accent-coloured glyph, label or border, so the row a marketer is hunting
// for is findable by shape as well as by number.
const TONE_CLASS: Record<ReturnType<typeof cellReading>["tone"], string> = {
  full: "bg-brand-subtle text-brand-subtle-foreground",
  partial: "bg-muted text-foreground",
  gap: "border-brand-ink text-foreground",
  absent: "border-border text-muted-foreground",
  unavailable: "border-dashed border-border text-muted-foreground",
};

/**
 * "2 competitors named" / "1 competitor named", or "" when none were.
 *
 * One wording, used by both the tooltip and the accessible name, because the
 * count is the half of the cell that colour alone carries and colour is exactly
 * what a screen reader does not get.
 */
export function competitorPhrase(competitors: number): string {
  if (competitors <= 0) return "";
  return `${competitors} ${competitors === 1 ? "competitor" : "competitors"} named`;
}

/**
 * Row 4 of the overview: one row per active prompt, one cell per engine.
 *
 * Capped at 20 rows with the rest revealed IN PLACE rather than paginated —
 * the gap you are hunting for is as likely to be prompt 24 as prompt 3, and
 * a second page is a place people do not go.
 *
 * The columns are the caller's `engines`, not every engine that exists: a
 * switched-off engine has no tile for the same reason it gets no column here,
 * and a permanent column of dashes for something nobody is paying for reads as
 * a broken engine rather than an unused one.
 *
 * ONE `TooltipProvider`, at the top. Every cell is a tooltip trigger, so a
 * provider per cell was one context and one hover timer per cell inside a 20×3
 * loop — sixty of them, none of which group with each other, so the open delay
 * restarts on every cell a reader drags across the grid.
 */
export function PromptMatrix({ rows, engines }: { rows: MatrixRow[]; engines: readonly EngineId[] }) {
  const [expanded, setExpanded] = useState(false);
  const [sort, setSort] = useState<MatrixSort>("gaps");
  const sorted = sortRows(rows, engines, sort);
  const visible = expanded ? sorted : sorted.slice(0, MATRIX_INITIAL_ROWS);

  return (
    <TooltipProvider>
      <div className="space-y-2">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>Sort</span>
          {(
            [
              ["gaps", "Gaps first"],
              ["prompt", "Prompt order"],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              aria-pressed={sort === value}
              onClick={() => setSort(value)}
              className={cn("text-xs", sort === value && "text-foreground underline underline-offset-4")}
            >
              {label}
            </Button>
          ))}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-full">Prompt</TableHead>
              {engines.map((engine) => (
                <TableHead key={engine} className="text-center">
                  {ENGINE_NAME[engine]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.promptId}>
                <TableCell className="max-w-0 truncate whitespace-nowrap">
                  <Link href={`/ai-visibility/prompts/${row.promptId}`} className="hover:underline">
                    {row.text}
                  </Link>
                  {row.branded && (
                    <Badge variant="outline" className="ml-2">
                      Brand check
                    </Badge>
                  )}
                </TableCell>
                {engines.map((engine) => {
                  const cell = row.cells[engine] ?? NO_CUT;
                  const reading = cellReading(cell);
                  // "GPT –" is the whole accessible name a screen reader gets
                  // from the visible text, and it says nothing: not which
                  // question, not which engine, not why there is a dash. The
                  // label carries all three. The failure wording is now at CELL
                  // scope, because `erroredPromptIds` says exactly which prompts
                  // an engine errored on rather than only how many.
                  const staleNote = cell.failed
                    ? "; the last run errored here, so this reads the earlier answers in the window"
                    : "";
                  const rivals = competitorPhrase(cell.competitors);
                  // The competitor half of the cell is carried visually by a
                  // small count and a border colour, neither of which reaches a
                  // screen reader. It goes in the name in words.
                  const rivalNote =
                    reading.tone === "unavailable" ? "" : rivals ? `; ${rivals}` : "; no competitor named";
                  const description =
                    reading.tone !== "unavailable"
                      ? `named in ${cell.named} of ${cell.samples} answers${rivalNote}${staleNote}`
                      : cell.failed
                        ? "no usable answers; the last run errored on this prompt"
                        : `fewer than ${MIN_N_PROMPT} usable answers yet`;
                  return (
                    <TableCell key={engine} className="text-center">
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex" />}>
                          <Link
                            href={`/ai-visibility/prompts/${row.promptId}?engine=${engine}`}
                            aria-label={`${row.text} — ${ENGINE_LABEL[engine]}: ${description}`}
                            className={cn(
                              "inline-flex h-5 min-w-10 items-center justify-center gap-0.5 rounded-md border border-transparent px-2 text-xs font-medium tabular-nums",
                              TONE_CLASS[reading.tone]
                            )}
                          >
                            {reading.text}
                            {/* aria-hidden: the link's own name already says
                                this in words. Kept in the cell because the
                                whole point is that "0/3 with rivals" and
                                "0/3 with nobody" must not look the same at a
                                glance. */}
                            {reading.tone !== "unavailable" && cell.competitors > 0 && (
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "font-normal",
                                  reading.tone === "gap" ? "text-brand-ink" : "text-muted-foreground"
                                )}
                              >
                                ·{cell.competitors}
                              </span>
                            )}
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>
                          {/* Never "excluded from every rate": the rates are
                              computed from the answers that DID come back, and
                              an errored call contributes nothing to exclude.
                              The old wording told the reader the tile beside
                              this cell was computed some other way. */}
                          {reading.tone === "unavailable"
                            ? cell.failed
                              ? `${ENGINE_LABEL[engine]} errored on this prompt in the last run and has fewer than ${MIN_N_PROMPT} answers in the window to read instead.`
                              : `Fewer than ${MIN_N_PROMPT} usable answers yet.`
                            : `Named in ${cell.named} of ${cell.samples} answers on ${ENGINE_LABEL[engine]}. ${
                                rivals
                                  ? `${rivals} in those answers.`
                                  : "No tracked competitor was named in them either."
                              }${
                                cell.failed
                                  ? " The last run errored on this prompt, so this is the earlier answers in the window."
                                  : ""
                              }`}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {/* The key, because the second number in a cell is not self-explanatory
            and the tooltip only reaches a reader who already wondered. The click
            affordance moved here from the card description, which the third
            sentence of was mostly restating this line. */}
        <p className="text-xs text-muted-foreground">
          A cell reads answers naming you out of answers collected, and opens that prompt on that engine. ·2
          means two tracked competitors were named in them.
        </p>

        {!expanded && sorted.length > MATRIX_INITIAL_ROWS && (
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show all {sorted.length}
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}
