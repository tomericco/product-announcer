"use client";

import { ArrowLeft } from "lucide-react";
import { GuardedLink } from "../../unsaved-changes";
import { SourceToggleButton } from "@/components/markdown/editor-context";
import { DecisionButtons, DismissReasonPicker, type BriefDecision } from "../brief-decision";

/**
 * The editor's sticky header. Accept and Dismiss live here rather than on the
 * inbox row: they are decisions about a brief you have READ, and reading one
 * now means opening it.
 *
 * `canDecide` is `status === "new"`, matching the card — `acceptBrief` and
 * `dismissBrief` both refuse anything else, so rendering the buttons for a
 * decided brief would be a guaranteed failed round trip. It is not the
 * read-only gate: that is the page's, and the server's.
 *
 * `decision` arrives as a prop rather than from a `useBriefDecision` call
 * here, because it has to be built with the editor's `saveIfDirty` — see
 * `brief-workspace.tsx`.
 */
export function BriefHeader({
  briefId,
  canDecide,
  decision,
}: {
  briefId: string;
  canDecide: boolean;
  decision: BriefDecision;
}) {
  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between gap-3 bg-background px-4 py-3">
        <GuardedLink
          href="/board"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Board
        </GuardedLink>
        <div className="flex items-center gap-4">
          <SourceToggleButton />
          {canDecide && <DecisionButtons decision={decision} />}
        </div>
      </div>

      {canDecide && decision.dismissOpen && (
        <div className="flex flex-col items-stretch gap-3 rounded-md border p-4">
          <DismissReasonPicker briefId={briefId} decision={decision} />
        </div>
      )}
    </>
  );
}
