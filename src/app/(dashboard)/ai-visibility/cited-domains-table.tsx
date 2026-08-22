"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DomainClass } from "@/lib/ai-visibility/domains";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_SHORT } from "./engine-labels";

export type CitedDomainRow = {
  domain: string;
  citations: number;
  answerSharePct: number;
  engines: EngineId[];
  domainClass: DomainClass;
  signalId: string | null;
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
 * Row 3 of the overview: where the engines actually get their answers.
 *
 * "Propose brief" is offered only on a third-party row that already has a
 * `new_cited_domain` signal behind it — `/briefs/new?signals=` resolves the
 * id through `listSignals`, so linking without one lands on an empty form
 * with the evidence silently dropped. Our own domain gets no such action:
 * being cited on our own page is the outcome, not a gap.
 */
export function CitedDomainsTable({ rows }: { rows: CitedDomainRow[] }) {
  return (
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
                {row.citations} ({Math.round(row.answerSharePct)}% of answers)
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.engines.map((engine) => ENGINE_SHORT[engine]).join(" · ")}
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
                  // action's ABSENCE needs explaining: signals age out of the
                  // 60-day window, and a row that offered "Propose brief" last
                  // month and offers nothing now looks broken rather than
                  // expired. Our own domain gets no note — it is not a gap.
                  classification.label === "Third-party" && (
                    <span
                      className="text-xs text-muted-foreground"
                      title="Signals age out after 60 days. Propose a brief from the Signals page, or wait for this domain to be cited again."
                    >
                      Evidence aged out
                    </span>
                  )
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
