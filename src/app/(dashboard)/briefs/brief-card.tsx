"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, CardFooter, CardAction } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Brief, Signal } from "@/db/schema";
import type { BriefWithSignals } from "@/lib/briefs/query";
import {
  useBriefDecision,
  DecisionButtons,
  DismissReasonPicker,
  DISMISS_REASON_LABEL,
} from "./brief-decision";

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

const DECIDED_LABEL: Record<Exclude<Brief["status"], "new">, string> = {
  accepted: "Accepted",
  dismissed: "Dismissed",
  expired: "Expired",
};

// The inbox header no longer claims every brief was agent-proposed (some are
// hand-written, per the manual-creation spec), so the card is what
// distinguishes the two. Only "Written by hand" renders — an agent brief is
// the default the header already describes, and a badge on every single card
// saying so would be noise.
const ORIGIN_LABEL: Partial<Record<Brief["origin"], string>> = {
  manual: "Written by hand",
};

/**
 * One brief in the inbox. A client component because it owns the
 * accept/dismiss interaction — unlike `SignalRow` on `/signals`, which is
 * also a client component and now owns a selection checkbox, but no
 * accept/dismiss-style action of its own.
 *
 * Only offers Accept/Dismiss when `brief.status === "new"` — `acceptBrief`
 * and `dismissBrief` both refuse anything else, so showing the buttons for a
 * decided brief would just be a guaranteed `{ ok: false }` round-trip. The
 * handlers and the reason picker themselves live in `./brief-decision`,
 * shared with the brief editor's header.
 */
export function BriefCard({ brief }: { brief: BriefWithSignals }) {
  const decision = useBriefDecision(brief.id);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{CONTENT_TYPE_LABEL[brief.contentType]}</Badge>
          <Badge variant="outline">{brief.suggestedChannel}</Badge>
          <Badge variant="outline">{brief.score.toFixed(2)}</Badge>
          {ORIGIN_LABEL[brief.origin] && <Badge variant="outline">{ORIGIN_LABEL[brief.origin]}</Badge>}
          {brief.status !== "new" && <Badge variant="outline">{DECIDED_LABEL[brief.status]}</Badge>}
        </div>
        <CardTitle className="text-lg">
          {/* The one way into the brief editor until the list rows land. */}
          <Link href={`/briefs/${brief.id}`} className="hover:underline">
            {brief.title}
          </Link>
        </CardTitle>
        {brief.status === "new" && (
          <CardAction>
            <DecisionButtons decision={decision} />
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

      {decision.dismissOpen && brief.status === "new" && (
        <CardFooter className="flex-col items-stretch gap-3">
          <DismissReasonPicker briefId={brief.id} decision={decision} />
        </CardFooter>
      )}
    </Card>
  );
}
