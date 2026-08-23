"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_LABEL, ENGINE_ORDER, ENGINE_SHORT } from "./engine-labels";

export type MatrixCell = { named: number | null; samples: number; failed: boolean };

export type MatrixRow = {
  promptId: string;
  text: string;
  branded: boolean;
  cells: Record<EngineId, MatrixCell>;
};

/** The design's floor: below three samples a cell says nothing worth saying. */
const MIN_CELL_SAMPLES = 3;

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
 */
export function cellReading(cell: MatrixCell): {
  text: string;
  tone: "full" | "partial" | "absent" | "unavailable";
} {
  if (cell.named === null || cell.samples < MIN_CELL_SAMPLES) {
    return { text: "–", tone: "unavailable" };
  }
  const text = `${cell.named}/${cell.samples}`;
  if (cell.named === cell.samples) return { text, tone: "full" };
  if (cell.named === 0) return { text, tone: "absent" };
  return { text, tone: "partial" };
}

// brand-subtle is state here (named on every sample), which is exactly what
// the accent is for. Absent is an outline, not a destructive tone: being
// unnamed on one prompt is a gap to work on, not an error.
const TONE_CLASS: Record<ReturnType<typeof cellReading>["tone"], string> = {
  full: "bg-brand-subtle text-brand-subtle-foreground",
  partial: "bg-muted text-foreground",
  absent: "border-border text-muted-foreground",
  unavailable: "border-dashed border-border text-muted-foreground",
};

/**
 * Row 4 of the overview: one row per active prompt, one cell per engine.
 *
 * Capped at 20 rows with the rest revealed IN PLACE rather than paginated —
 * the gap you are hunting for is as likely to be prompt 24 as prompt 3, and
 * a second page is a place people do not go.
 */
export function PromptMatrix({ rows }: { rows: MatrixRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, MATRIX_INITIAL_ROWS);

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Prompt</TableHead>
            {ENGINE_ORDER.map((engine) => (
              <TableHead key={engine} className="text-center">
                {ENGINE_SHORT[engine]}
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
              {ENGINE_ORDER.map((engine) => {
                const cell = row.cells[engine];
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
                const description =
                  reading.tone !== "unavailable"
                    ? `named in ${cell.named} of ${cell.samples} answers${staleNote}`
                    : cell.failed
                      ? "no usable answers; the last run errored on this prompt"
                      : `fewer than ${MIN_CELL_SAMPLES} usable answers yet`;
                return (
                  <TableCell key={engine} className="text-center">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger render={<span className="inline-flex" />}>
                          <Link
                            href={`/ai-visibility/prompts/${row.promptId}?engine=${engine}`}
                            aria-label={`${row.text} — ${ENGINE_LABEL[engine]}: ${description}`}
                            className={cn(
                              "inline-flex h-5 min-w-10 items-center justify-center rounded-md border border-transparent px-2 text-xs font-medium tabular-nums",
                              TONE_CLASS[reading.tone]
                            )}
                          >
                            {reading.text}
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
                              ? `${ENGINE_LABEL[engine]} errored on this prompt in the last run and has fewer than ${MIN_CELL_SAMPLES} answers in the window to read instead.`
                              : `Fewer than ${MIN_CELL_SAMPLES} usable answers yet.`
                            : cell.failed
                              ? `Named in ${cell.named} of ${cell.samples} answers on ${ENGINE_LABEL[engine]}. The last run errored on this prompt, so this is the earlier answers in the window.`
                              : `Named in ${cell.named} of ${cell.samples} answers on ${ENGINE_LABEL[engine]}.`}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {!expanded && rows.length > MATRIX_INITIAL_ROWS && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
          Show all {rows.length}
        </Button>
      )}
    </div>
  );
}
