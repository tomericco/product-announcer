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
 * Accept/Dismiss, shared by the inbox card and the brief editor's header.
 *
 * A hook plus a picker component rather than one all-in-one control, because
 * the two callers lay the same pieces out differently: the card puts the two
 * buttons in its `CardAction` slot and the reason picker in its `CardFooter`,
 * while the editor puts the buttons in its sticky header and the picker in a
 * panel below it. Extracted here — rather than copied into the editor — so
 * there is exactly one implementation of "what dismissing a brief asks for and
 * what accepting it does next".
 */
export function useBriefDecision(briefId: string) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<DismissReason | "">("");
  const [note, setNote] = useState("");

  async function handleAccept() {
    setAccepting(true);
    try {
      const result = await acceptBrief(briefId);
      if (result.ok) {
        router.push(`/drafts/${result.contentPieceId}`);
      } else {
        toast.error(result.error);
      }
    } finally {
      setAccepting(false);
    }
  }

  async function handleDismiss() {
    if (!reason) return;
    setDismissing(true);
    try {
      const result = await dismissBrief(briefId, reason, note);
      if (result.ok) {
        toast.success("Brief dismissed");
        setDismissOpen(false);
        setReason("");
        setNote("");
        // `dismissBrief` revalidates /briefs, which invalidates the cache but
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
        onClick={() => decision.setDismissOpen(!decision.dismissOpen)}
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
