import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";
import { db } from "@/db";
import { contentPieces, atomicUpdates } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { reviewStatusLabel } from "@/lib/ai/review-status";
import { formatShortDate } from "@/lib/utils";
import { DraftRowMenu } from "./draft-row-menu";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
  EmptyStateActions,
} from "@/components/ui/empty-state";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.tenantId, session.user.tenantId), eq(contentPieces.status, "draft")))
    // Newest first — the list shows creation times, so an unordered result
    // would read as broken.
    .orderBy(desc(contentPieces.createdAt));

  // The composition link for a draft's constituent changes is
  // `atomicUpdates.contentPieceId` — content pieces carry no column of their
  // own for this — so the per-draft count is a small side query rather than a
  // plain field read.
  const atomicUpdateCounts = new Map<string, number>();
  if (drafts.length > 0) {
    const linked = await db
      .select({ contentPieceId: atomicUpdates.contentPieceId })
      .from(atomicUpdates)
      .where(
        inArray(
          atomicUpdates.contentPieceId,
          drafts.map((d) => d.id)
        )
      );
    for (const { contentPieceId } of linked) {
      if (contentPieceId) atomicUpdateCounts.set(contentPieceId, (atomicUpdateCounts.get(contentPieceId) ?? 0) + 1);
    }
  }

  if (drafts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState>
          <EmptyStateIcon>
            <FileText />
          </EmptyStateIcon>
          <EmptyStateTitle>No drafts to review</EmptyStateTitle>
          <EmptyStateDescription>
            Drafts appear here once an update is generated from your pending changes — on the next
            scheduled run, or as soon as you generate one yourself.
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button render={<Link href="/atomic-updates" />}>
              Review atomic updates
              <ArrowRight />
            </Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Drafts</h1>
        <Badge variant="secondary">{drafts.length}</Badge>
      </div>
      {/* Negative margin lets the hover highlight breathe past the text column
          without indenting the rows themselves. */}
      <div className="-mx-3">
        {drafts.map((d) => (
          // The menu button can't nest inside the anchor, so the link is
          // stretched over the row and the menu sits above it as a sibling.
          <div
            key={d.id}
            className="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/60"
          >
            <Link href={`/drafts/${d.id}`} className="absolute inset-0 rounded-lg" aria-label={d.title} />
            <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
            {reviewStatusLabel(d.reviewStatus) && (
              <Badge variant={d.reviewStatus === "failed" ? "destructive" : "outline"}>
                {reviewStatusLabel(d.reviewStatus)}
              </Badge>
            )}
            <span
              className="shrink-0 text-sm text-muted-foreground"
              title={d.createdAt.toLocaleString()}
            >
              {formatShortDate(d.createdAt)}
            </span>
            <div className="relative shrink-0">
              <DraftRowMenu
                contentPieceId={d.id}
                title={d.title}
                atomicUpdateCount={atomicUpdateCounts.get(d.id) ?? 0}
                publishedAt={d.publishedAt ? d.publishedAt.toISOString() : null}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
