"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PromptIntent } from "@/lib/ai-visibility/types";
import { DisabledHint } from "../../_components/disabled-hint";
import { GeneratePromptSetButton } from "../generate-prompt-set-button";
import { approveProposalsAction } from "../actions";
import { INTENT_LABEL } from "./prompts-editor";

export type ProposalRow = {
  id: string;
  text: string;
  intent: PromptIntent;
  persona: string | null;
  competitorName: string | null;
  flagReason: string | null;
};

/** A batch this small is the monthly top-up strip, not the initial set. */
const COLLAPSE_AT_OR_BELOW = 10;

/**
 * "Approve 28 of 30" — the count is the whole affordance.
 *
 * Zero checked is a real, committable decision: it rejects the batch, and
 * every rejection is a negative the next generation reads. Labelling it
 * "Approve none" described the button as doing nothing, which is the opposite
 * of what it does.
 */
export function approveLabel(checkedCount: number, total: number): string {
  return checkedCount === 0 ? `Reject all ${total}` : `Approve ${checkedCount} of ${total}`;
}

/**
 * The batch review: rows checked by default and text editable inline, with a
 * footer that commits with exclusions.
 *
 * There is deliberately no per-row Approve. Thirty individual accepts is the
 * complaint this design is answering, and review here is EXCLUSION, not
 * selection — which is why every row arrives checked and an unchecked one is
 * stored as a rejected negative the next generation reads.
 */
export function SuggestionsSection({
  proposals,
  profileChangedNote,
  canSuggestMore,
  suggestMoreReason,
}: {
  proposals: ProposalRow[];
  profileChangedNote: string | null;
  canSuggestMore: boolean;
  suggestMoreReason: string | null;
}) {
  // EXCLUSIONS, not selections. A `useState` initialised from `proposals`
  // never re-runs, and "Suggest more" pushes to the same URL — so the
  // component stays mounted holding the previous batch's ids, and a checked
  // set built that way arrives EMPTY for the new proposals. Every untouched
  // row would then commit as a `rejected` negative: the batch silently
  // rejects itself. Absence means approved, which is also exactly what
  // "review is exclusion, not selection" says.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [texts, setTexts] = useState<Record<string, string>>(
    Object.fromEntries(proposals.map((p) => [p.id, p.text]))
  );
  const [collapsed, setCollapsed] = useState(
    proposals.length > 0 && proposals.length <= COLLAPSE_AT_OR_BELOW
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const checkedCount = proposals.filter((proposal) => !excluded.has(proposal.id)).length;

  function commit() {
    const form = new FormData();
    for (const proposal of proposals) {
      if (!excluded.has(proposal.id)) {
        form.append("approve", proposal.id);
        const edited = texts[proposal.id]?.trim();
        // Only send an edit when the wording actually changed — an
        // unchanged text is not an edit, and sending it would make every
        // approval look like one in the audit trail.
        if (edited && edited !== proposal.text) form.set(`text:${proposal.id}`, edited);
      } else {
        form.append("reject", proposal.id);
      }
    }
    startTransition(async () => {
      const result = await approveProposalsAction(form);
      if (result.ok) {
        toast.success(
          result.approved > 0 ? `${result.approved} prompts approved` : `${result.rejected} suggestions rejected`
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const suggestMore = (
    <div className="flex flex-col items-start gap-1">
      {canSuggestMore ? (
        <GeneratePromptSetButton disabledReason={null} label="Suggest more" variant="outline" />
      ) : (
        <>
          <DisabledHint hint={suggestMoreReason ?? "Not available right now."}>
            <Button disabled>Suggest more</Button>
          </DisabledHint>
          {suggestMoreReason && <p className="text-xs text-muted-foreground">{suggestMoreReason}</p>}
        </>
      )}
    </div>
  );

  if (proposals.length === 0) {
    if (!profileChangedNote) return suggestMore;
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <p className="text-sm">{profileChangedNote}</p>
        {suggestMore}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3">
        <p className="text-sm">
          {proposals.length} new suggestion{proposals.length === 1 ? "" : "s"} — none of them run until you
          approve them.
        </p>
        <Button variant="outline" size="sm" onClick={() => setCollapsed(false)}>
          Review
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{proposals.length} suggested prompts</p>
          <p className="text-sm text-muted-foreground">
            Review, edit, then approve. Unchecked prompts are remembered so the next batch does not suggest them
            again.
          </p>
        </div>
        {profileChangedNote && <p className="text-sm text-muted-foreground">{profileChangedNote}</p>}
      </div>

      <ul className="space-y-2">
        {proposals.map((proposal) => (
          <li key={proposal.id} className="flex items-start gap-2 rounded-md border p-2">
            <input
              type="checkbox"
              className="mt-2 size-4 shrink-0 rounded border-input"
              checked={!excluded.has(proposal.id)}
              aria-label={`Approve ${proposal.text}`}
              onChange={() =>
                setExcluded((prev) => {
                  const next = new Set(prev);
                  if (next.has(proposal.id)) next.delete(proposal.id);
                  else next.add(proposal.id);
                  return next;
                })
              }
            />
            <div className="min-w-0 flex-1 space-y-1">
              <Input
                value={texts[proposal.id] ?? proposal.text}
                aria-label={`Prompt text for ${proposal.text}`}
                onChange={(e) => setTexts((prev) => ({ ...prev, [proposal.id]: e.target.value }))}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{INTENT_LABEL[proposal.intent]}</Badge>
                {proposal.persona && <Badge variant="outline">{proposal.persona}</Badge>}
                {proposal.competitorName && <Badge variant="outline">{proposal.competitorName}</Badge>}
                {proposal.flagReason && <span className="text-xs text-destructive">{proposal.flagReason}</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {suggestMore}
        {/* Enabled at zero checked: rejecting the whole batch is a decision
            the reviewer is allowed to make, and disabling it there left the
            "reject everything" path with no button at all. */}
        <Button onClick={commit} disabled={pending}>
          {pending ? "Saving…" : approveLabel(checkedCount, proposals.length)}
        </Button>
      </div>
    </div>
  );
}
