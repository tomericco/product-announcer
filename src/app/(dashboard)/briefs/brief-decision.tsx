"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { acceptBrief, dismissBrief, type DismissReason } from "./actions";

// Mirrors `briefDismissReasonEnum` in src/db/schema.ts. Kept as a local
// `as const` array (the pattern `KIND_VALUES` in src/lib/signals/params.ts
// already uses) rather than importing the enum object as a runtime value:
// this is a client component, and `@/db/schema` is a ~900-line module of
// table/enum definitions — every other client component in this codebase
// imports `type`-only from it, and pulling the real module in risks shipping
// table/column names and business-rationale comments into the browser
// bundle. Changing one of these five values means changing the enum too.
const DISMISS_REASON_VALUES = ["off_topic", "wrong_angle", "already_covered", "not_our_voice", "other"] as const;

export const DISMISS_REASON_LABEL: Record<DismissReason, string> = {
  off_topic: "Off topic",
  wrong_angle: "Wrong angle",
  already_covered: "Already covered",
  not_our_voice: "Not our voice",
  other: "Other",
};

const DISMISS_REASON_OPTIONS = DISMISS_REASON_VALUES.map((value) => ({
  value,
  label: DISMISS_REASON_LABEL[value],
}));

/**
 * Accept/Dismiss, used by the brief editor's header (`brief-header.tsx`).
 *
 * A hook plus a picker component rather than one all-in-one control. This
 * used to be shared with the inbox card's own Accept/Dismiss — the card put
 * the two buttons in its `CardAction` slot and the reason picker in its
 * `CardFooter`, while the editor puts the buttons in its sticky header and
 * the picker in a panel below it. The card is gone (row-level decisions were
 * removed along with the `/briefs` list itself), but the hook
 * stayed split out this way rather than folded back into the editor, so
 * there remains exactly one implementation of "what dismissing a brief asks
 * for and what accepting it does next" if another caller ever needs it.
 */
export function useBriefDecision(
  briefId: string,
  /**
   * Run before either decision goes to the server; a false return aborts it.
   * The brief editor passes `saveIfDirty` here, because BOTH decisions leave
   * unsaved edits unrecoverable and neither goes through the unsaved-changes
   * guard:
   *
   *   - Accept never goes through the unsaved-changes guard: it used to
   *     navigate with `router.push` rather than a `GuardedLink` (so
   *     `requestLeave` never fired, and `beforeunload` only covers full page
   *     loads — see the comment on `GuardedLink` in `unsaved-changes.tsx`),
   *     and it now does not navigate at all, so there is nothing for a guard
   *     to intercept. Either way `acceptBrief` scaffolds and generates the
   *     draft from the STORED row, so an unsaved edit means the model
   *     receives the commission the human did not write.
   *   - Dismiss refreshes the page into its read-only branch, which drops the
   *     editor and its state on the floor just as quietly.
   *
   * In both cases the brief lands on a status that this page and
   * `saveBriefBody` treat as read-only, so there is no recovering the edits
   * afterwards.
   */
  { beforeDecide }: { beforeDecide?: () => Promise<boolean> } = {}
) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  // The piece a successful accept created, while its generation is being
  // watched in `GenerationModal`. Non-null IS "the modal is open".
  const [generatingPieceId, setGeneratingPieceId] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<DismissReason | "">("");
  const [note, setNote] = useState("");

  async function handleAccept() {
    setAccepting(true);
    try {
      // Commit first, decide second. A refusal (a blank body, say) is already
      // toasted by the save — accepting anyway would generate the draft from
      // the stored body and destroy the edits the save just rejected.
      if (beforeDecide && !(await beforeDecide())) return;

      const result = await acceptBrief(briefId);
      if (result.ok) {
        // Watch the generation here instead of navigating to `/drafts/[id]`.
        // The redirect this replaces threw the author off the brief they had
        // just read — onto a page showing the accept-time scaffold, for as
        // long as generation took, with nothing on it saying so.
        setGeneratingPieceId(result.contentPieceId);
      } else {
        toast.error(result.error);
      }
    } finally {
      setAccepting(false);
    }
  }

  /**
   * Dismisses the generation modal. The refresh is the point: the brief is
   * `accepted` now, so re-reading swaps this page into its read-only branch —
   * which is why it waits until here rather than firing on acceptance or on
   * completion. That branch unmounts this hook's owner, and with it the modal.
   *
   * Closing does NOT stop the generation. It runs in an `after()` callback
   * with no abort seam, and the piece is on the board either way.
   */
  function closeGeneration() {
    setGeneratingPieceId(null);
    router.refresh();
  }

  async function handleDismiss() {
    if (!reason) return;
    setDismissing(true);
    try {
      if (beforeDecide && !(await beforeDecide())) return;

      const result = await dismissBrief(briefId, reason, note);
      if (result.ok) {
        toast.success("Brief dismissed");
        setDismissOpen(false);
        setReason("");
        setNote("");
        // `dismissBrief` revalidates /board, which invalidates the cache but
        // does not push anything to the page the user is standing on. On the
        // editor route that page must go read-only the moment the brief is
        // dismissed, so ask for the re-render explicitly.
        router.refresh();
      } else {
        toast.error(result.error);
      }
    } finally {
      setDismissing(false);
    }
  }

  return {
    accepting,
    generatingPieceId,
    closeGeneration,
    dismissing,
    dismissOpen,
    setDismissOpen,
    reason,
    setReason,
    note,
    setNote,
    handleAccept,
    handleDismiss,
    busy: accepting || dismissing,
  };
}

export type BriefDecision = ReturnType<typeof useBriefDecision>;

/** The two buttons. `briefId` only feeds the picker's element ids, not these. */
export function DecisionButtons({ decision }: { decision: BriefDecision }) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={decision.busy}
        onClick={() => decision.setDismissOpen((v) => !v)}
      >
        Dismiss
      </Button>
      <Button size="sm" disabled={decision.busy} onClick={decision.handleAccept}>
        {decision.accepting ? "Accepting…" : "Accept"}
      </Button>
    </div>
  );
}

/**
 * The dismiss-reason picker. Rendered by the caller only while
 * `decision.dismissOpen` — the two callers put it in different containers, so
 * the open/closed branch stays theirs.
 */
export function DismissReasonPicker({ briefId, decision }: { briefId: string; decision: BriefDecision }) {
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`dismiss-reason-${briefId}`}>Reason</Label>
        <Select
          value={decision.reason}
          onValueChange={(value) => decision.setReason(value as DismissReason)}
        >
          <SelectTrigger id={`dismiss-reason-${briefId}`} className="w-full">
            <SelectValue placeholder="Choose a reason" />
          </SelectTrigger>
          <SelectContent>
            {DISMISS_REASON_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`dismiss-note-${briefId}`}>Note (optional)</Label>
        <Textarea
          id={`dismiss-note-${briefId}`}
          value={decision.note}
          onChange={(e) => decision.setNote(e.target.value)}
          placeholder="Anything worth telling the agent next time"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={decision.dismissing}
          onClick={() => decision.setDismissOpen(false)}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!decision.reason || decision.dismissing}
          onClick={decision.handleDismiss}
        >
          {decision.dismissing ? "Dismissing…" : "Confirm dismiss"}
        </Button>
      </div>
    </>
  );
}
