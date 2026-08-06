"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardHeader, CardTitle, CardContent, CardFooter, CardAction } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { briefDismissReasonEnum, type Brief, type Signal } from "@/db/schema";
import type { BriefWithSignals } from "@/lib/briefs/query";
import { acceptBrief, dismissBrief, type DismissReason } from "./actions";

const CONTENT_TYPE_LABEL: Record<Brief["contentType"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

const SIGNAL_KIND_LABEL: Record<Signal["kind"], string> = {
  shipped_work: "Shipped work",
  competitor_move: "Competitor move",
  market_news: "Market news",
  manual: "Manual",
};

// Human labels for the five reasons, keyed off the schema's own enum values
// (imported below) rather than a hand-retyped list of strings.
const DISMISS_REASON_LABEL: Record<DismissReason, string> = {
  off_topic: "Off topic",
  wrong_angle: "Wrong angle",
  already_covered: "Already covered",
  not_our_voice: "Not our voice",
  other: "Other",
};

const DISMISS_REASON_OPTIONS = briefDismissReasonEnum.enumValues.map((value) => ({
  value,
  label: DISMISS_REASON_LABEL[value],
}));

const DECIDED_LABEL: Record<Exclude<Brief["status"], "new">, string> = {
  accepted: "Accepted",
  dismissed: "Dismissed",
  expired: "Expired",
};

/**
 * One brief in the inbox. A client component because it owns the
 * accept/dismiss interaction (`SignalRow` on `/signals` stays server-rendered
 * for the same reason it has no actions).
 *
 * Only offers Accept/Dismiss when `brief.status === "new"` — `acceptBrief`
 * and `dismissBrief` both refuse anything else, so showing the buttons for a
 * decided brief would just be a guaranteed `{ ok: false }` round-trip.
 */
export function BriefCard({ brief }: { brief: BriefWithSignals }) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<DismissReason | "">("");
  const [note, setNote] = useState("");

  async function handleAccept() {
    setAccepting(true);
    try {
      const result = await acceptBrief(brief.id);
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
      const result = await dismissBrief(brief.id, reason, note);
      if (result.ok) {
        toast.success("Brief dismissed");
        setDismissOpen(false);
        setReason("");
        setNote("");
      } else {
        toast.error(result.error);
      }
    } finally {
      setDismissing(false);
    }
  }

  const busy = accepting || dismissing;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{CONTENT_TYPE_LABEL[brief.contentType]}</Badge>
          <Badge variant="outline">{brief.suggestedChannel}</Badge>
          <Badge variant="outline">{brief.score.toFixed(2)}</Badge>
          {brief.status !== "new" && <Badge variant="outline">{DECIDED_LABEL[brief.status]}</Badge>}
        </div>
        <CardTitle className="text-lg">{brief.title}</CardTitle>
        {brief.status === "new" && (
          <CardAction>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setDismissOpen((v) => !v)}>
                Dismiss
              </Button>
              <Button size="sm" disabled={busy} onClick={handleAccept}>
                {accepting ? "Accepting…" : "Accept"}
              </Button>
            </div>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-sm">{brief.angle}</p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Why now: </span>
          {brief.whyNow}
        </p>

        {brief.keyPoints.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {brief.keyPoints.map((point, i) => (
              <li key={i}>{point}</li>
            ))}
          </ul>
        )}

        {brief.signals.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-muted-foreground">Evidence:</span>
            {brief.signals.map((signal) => (
              <Badge key={signal.id} variant="outline" className="max-w-64">
                {signal.url ? (
                  <a
                    href={signal.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:underline"
                    title={signal.title}
                  >
                    {signal.title}
                  </a>
                ) : (
                  <span className="truncate" title={signal.title}>
                    {signal.title}
                  </span>
                )}
                <span className="text-muted-foreground">· {SIGNAL_KIND_LABEL[signal.kind]}</span>
              </Badge>
            ))}
          </div>
        )}

        {brief.status === "dismissed" && brief.dismissReason && (
          <p className="text-xs text-muted-foreground">
            Dismissed as {DISMISS_REASON_LABEL[brief.dismissReason]}
            {brief.dismissNote ? `: ${brief.dismissNote}` : ""}
          </p>
        )}
      </CardContent>

      {dismissOpen && brief.status === "new" && (
        <CardFooter className="flex-col items-stretch gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`dismiss-reason-${brief.id}`}>Reason</Label>
            <Select value={reason} onValueChange={(value) => setReason(value as DismissReason)}>
              <SelectTrigger id={`dismiss-reason-${brief.id}`} className="w-full">
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
            <Label htmlFor={`dismiss-note-${brief.id}`}>Note (optional)</Label>
            <Textarea
              id={`dismiss-note-${brief.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth telling the agent next time"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={dismissing} onClick={() => setDismissOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={!reason || dismissing} onClick={handleDismiss}>
              {dismissing ? "Dismissing…" : "Confirm dismiss"}
            </Button>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
