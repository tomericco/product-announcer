import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { reviewStatusLabel } from "@/lib/ai/review-status";
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
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "draft")))
    // Newest first — the list shows creation times, so an unordered result
    // would read as broken.
    .orderBy(desc(updates.createdAt));

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
            <Button render={<Link href="/pending" />}>
              Review pending changes
              <ArrowRight />
            </Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Drafts</h1>
      {/* Negative margin lets the hover highlight breathe past the text column
          without indenting the rows themselves. */}
      <div className="-mx-3">
        {drafts.map((d) => (
          <Link
            key={d.id}
            href={`/drafts/${d.id}`}
            className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/60"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
            <div className="flex shrink-0 items-center gap-3">
              {reviewStatusLabel(d.reviewStatus) && (
                <Badge variant={d.reviewStatus === "failed" ? "destructive" : "outline"}>
                  {reviewStatusLabel(d.reviewStatus)}
                </Badge>
              )}
              <span className="text-sm text-muted-foreground" title={d.createdAt.toLocaleString()}>
                {d.createdAt.toLocaleDateString()}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
