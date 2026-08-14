import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { Brief } from "@/db/schema";

const CONTENT_TYPE_LABEL: Record<Brief["contentType"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

const STATUS_LABEL: Record<Brief["status"], string> = {
  new: "New",
  accepted: "Accepted",
  dismissed: "Dismissed",
  expired: "Expired",
};

/**
 * The inbox's list of rows — mirrors `/drafts/page.tsx`'s row shape rather
 * than the card grid this replaces: title, content type, status, score and
 * the `suggestedChannel` badge, with the whole row linking into the editor
 * at `/briefs/[briefId]`. `rows` already arrives ordered by score then
 * recency from `listBriefs` — this never reorders them, matching the card
 * grid's contract with the same query.
 *
 * No server component here needs `"use client"`: unlike the card grid this
 * replaces, nothing on the row is interactive. Accept and Dismiss now live
 * only in the editor (`brief-decision.tsx`'s header) — a row-level decision
 * let you accept a brief you never opened, which is exactly what this list
 * is meant to stop.
 */
export function BriefsList({ briefs }: { briefs: Brief[] }) {
  return (
    <div className="-mx-3">
      {briefs.map((brief) => (
        <div
          key={brief.id}
          className="group relative rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/60"
        >
          <Link
            href={`/briefs/${brief.id}`}
            className="absolute inset-0 rounded-lg"
            aria-label={brief.title}
          />
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate font-medium">{brief.title}</span>
            <Badge variant="secondary">{CONTENT_TYPE_LABEL[brief.contentType]}</Badge>
            <Badge variant="outline">{brief.suggestedChannel}</Badge>
            <Badge variant="outline">{brief.score.toFixed(2)}</Badge>
            <Badge variant="outline">{STATUS_LABEL[brief.status]}</Badge>
          </div>
        </div>
      ))}
    </div>
  );
}
