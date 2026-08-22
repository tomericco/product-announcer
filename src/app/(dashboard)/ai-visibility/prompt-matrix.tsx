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
 * A failed engine and an under-sampled cell both read "–". They are not the
 * same thing, and the tooltip distinguishes them; what matters at a glance is
 * that neither is a zero.
 */
export function cellReading(cell: MatrixCell): {
  text: string;
  tone: "full" | "partial" | "absent" | "unavailable";
} {
  if (cell.failed || cell.named === null || cell.samples < MIN_CELL_SAMPLES) {
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
                // label carries all three. The failure wording stays at ENGINE
                // scope — `failed` is set from `runEngineHealth`, which counts
                // errored prompts per engine, and claiming THIS prompt failed
                // is a fact the data does not contain.
                const description = reading.tone !== "unavailable"
                  ? `named in ${cell.named} of ${cell.samples} answers`
                  : cell.failed
                    ? "no usable answers; this engine failed during the last run"
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
                          {reading.tone === "unavailable"
                            ? cell.failed
                              ? `${ENGINE_LABEL[engine]} failed during the last run — its cells are excluded from every rate.`
                              : `Fewer than ${MIN_CELL_SAMPLES} usable answers yet.`
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
