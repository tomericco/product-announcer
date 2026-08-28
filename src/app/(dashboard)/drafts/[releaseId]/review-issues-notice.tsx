"use client";

import { AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentEdit } from "./agent-edit-context";

/**
 * The instruction the "Fix these issues" button starts from.
 *
 * Exported and pure so the wording is testable without a DOM — it is a prompt
 * the agent acts on, not decoration. The issues are quoted as a list and
 * introduced as the reviewer's, so the model treats them as the brief for
 * this pass rather than as prose to work into the body.
 */
export function reviewFixInstruction(issues: string[]): string {
  return [
    "A brand-guidelines review flagged the following issues with this update.",
    "Revise the update to address each of them, and change nothing else:",
    "",
    ...issues.map((issue) => `- ${issue}`),
  ].join("\n");
}

/**
 * What a draft's failed brand-guidelines review looks like on the page.
 *
 * It used to be a line of muted grey text under the header — the same
 * treatment as an ordinary status label, for the one state on this page that
 * is neither ordinary nor merely informational, and with nothing to do about
 * it. This is a warning box alongside the page's other notices, and it
 * carries the action: "Fix these issues" opens the whole-update agent edit
 * pre-filled with the reviewer's own feedback, so another iteration is one
 * click rather than a retype.
 *
 * The dialog is prefilled, not auto-submitted, on purpose — the reviewer's
 * issues are the starting point for the instruction and the user can add to
 * or cut them before the pass runs.
 *
 * A client component only because the button needs the agent-edit context;
 * the issues themselves come from the server-rendered page.
 */
export function ReviewIssuesNotice({ issues }: { issues: string[] }) {
  const { openWholeEdit } = useAgentEdit();

  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4 shrink-0" />
        This draft didn&apos;t pass the brand-guidelines review
      </p>
      <p className="text-muted-foreground">
        It was saved anyway so you can work on it — here is what the reviewer flagged.
      </p>
      {issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openWholeEdit(reviewFixInstruction(issues))}
      >
        <Sparkles className="size-4" /> Fix these issues
      </Button>
    </div>
  );
}
