"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { DomainClass } from "@/lib/ai-visibility/domains";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_NAME } from "./engine-labels";
import { ratePct } from "./format";

export type CitedDomainRow = {
  domain: string;
  citations: number;
  answerSharePct: number;
  engines: EngineId[];
  domainClass: DomainClass;
  signalId: string | null;
  /**
   * Whether a `new_cited_domain` signal for this domain has ever existed,
   * inside the 60-day window or long outside it (`everSignalledDomains`).
   *
   * Separate from `signalId` because the absence of an id has two causes and
   * only one of them is an expiry — see `evidenceNote`.
   *
   * `null` is a third thing: this table was never joined to signals at all, as
   * on the per-prompt sources table, where every row's `signalId` is null by
   * construction. Such a row knows nothing about signals and says nothing —
   * neither "aged out" nor "no signal yet" would be a claim it could support.
   */
  everSignalled: boolean | null;
};

/**
 * Seven storage classes, three readings. The row only has to answer "is this
 * us, them, or somewhere we could be" — the finer classification exists for
 * the signal rules, not for a glance.
 */
export function domainClassLabel(row: CitedDomainRow): {
  label: string;
  variant: "default" | "secondary" | "outline";
} {
  if (row.domainClass === "own") return { label: "Ours", variant: "default" };
  if (row.domainClass === "competitor") return { label: "Competitor", variant: "secondary" };
  return { label: "Third-party", variant: "outline" };
}

/**
 * What to say in place of "Propose brief", and why.
 *
 * The two cases are not variants of one another. `new_cited_domain` fires on
 * ENTRY — a domain new to the top ten, or newly cited on three prompts where we
 * are absent — and never again while it keeps being cited, so the leaderboard's
 * steadiest rows are precisely the ones that never raised a signal. Telling
 * that reader "Evidence aged out" asserts an expiry that never happened, and
 * sends them looking for a signal on a page where none was ever written.
 */
export function evidenceNote(row: CitedDomainRow): { label: string; hint: string } | null {
  if (row.everSignalled === null) return null;
  return row.everSignalled
    ? {
        label: "Evidence aged out",
        hint: "This domain's signal is older than the 60-day window. Propose a brief from the Signals page, or wait for the next run to raise a new one.",
      }
    : {
        label: "No signal yet",
        hint: "A signal fires when a domain first reaches the top 10 or first appears on 3 prompts where you are absent — a source cited steadily for months may never raise one. Propose a brief from the Signals page.",
      };
}

/**
 * The note, and the reason it is a `Tooltip` on a real button rather than the
 * `title` attribute it used to be.
 *
 * `title` is mouse-only in practice: it never opens on keyboard focus, and
 * screen readers announce it inconsistently — so the sentence that explains why
 * a whole column of actions is missing was reachable only by hovering. This is
 * the `Badge` trigger pattern from the page header, for the same reason it was
 * chosen there. `DisabledHint` is deliberately not reused: it exists to wrap a
 * DISABLED control, and its span trigger plus `pointer-events-none` is
 * focusable by nothing at all — there is no control here to disable.
 */
function EvidenceNote({ row }: { row: CitedDomainRow }) {
  const note = evidenceNote(row);
  if (note === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" className="inline-flex text-left" />}>
        <span className="text-xs text-muted-foreground">{note.label}</span>
      </TooltipTrigger>
      <TooltipContent>{note.hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Where the engines actually get their answers.
 *
 * "Propose brief" is offered only on a third-party row that already has a
 * `new_cited_domain` signal behind it — `/briefs/new?signals=` resolves the
 * id through `listSignals`, so linking without one lands on an empty form
 * with the evidence silently dropped. Our own domain gets no such action:
 * being cited on our own page is the outcome, not a gap.
 *
 * ONE `TooltipProvider`, wrapping the whole table rather than one per row. The
 * provider is a context and a shared open/close timer, not a per-tooltip
 * requirement: a provider per row means fifteen contexts, fifteen timers, and
 * no grouping — the delay never carries from one row to the next, so a reader
 * scanning the column waits out the full delay on every hover.
 */
export function CitedDomainsTable({ rows }: { rows: CitedDomainRow[] }) {
  return (
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-full">Domain</TableHead>
            <TableHead>Citations</TableHead>
            <TableHead>Engines</TableHead>
            <TableHead>Class</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const classification = domainClassLabel(row);
            const proposable = classification.label === "Third-party" && row.signalId !== null;
            return (
              <TableRow key={row.domain}>
                <TableCell className="max-w-0 truncate">{row.domain}</TableCell>
                <TableCell className="tabular-nums">
                  {/* "searched", not "answers": the denominator is grounded
                      answers only, since an engine that answered from memory
                      cited nothing and cannot be part of a share of citations. */}
                  {row.citations} ({ratePct(row.answerSharePct)} of searched answers)
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.engines.map((engine) => ENGINE_NAME[engine]).join(" · ")}
                </TableCell>
                <TableCell>
                  <Badge variant={classification.variant}>{classification.label}</Badge>
                </TableCell>
                <TableCell>
                  {proposable ? (
                    // A styled Link rather than `Button render={<Link/>}`: Base
                    // UI's Button stamps `role="button"` onto whatever it
                    // renders, and this control does nothing but navigate — a
                    // link that announces itself as a button loses the one cue
                    // that says a new page is coming.
                    <Link
                      href={`/briefs/new?signals=${row.signalId}`}
                      className={buttonVariants({ variant: "ghost", size: "sm" })}
                    >
                      Propose brief
                    </Link>
                  ) : (
                    // A third-party row with no signal is the one case where the
                    // action's ABSENCE needs explaining: without a note, a row
                    // that offers nothing where its neighbours offer a brief
                    // looks broken. Our own domain gets no note — it is not a gap.
                    classification.label === "Third-party" && <EvidenceNote row={row} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TooltipProvider>
  );
}
