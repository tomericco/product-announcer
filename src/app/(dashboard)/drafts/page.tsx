import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "draft")));

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
      <div className="space-y-2">
        {drafts.map((d) => (
          <Card key={d.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <Link href={`/drafts/${d.id}`} className="font-medium hover:underline">
                {d.title}
              </Link>
              <div className="flex items-center gap-2">
                {reviewStatusLabel(d.reviewStatus) && (
                  <Badge variant={d.reviewStatus === "failed" ? "destructive" : "outline"}>
                    {reviewStatusLabel(d.reviewStatus)}
                  </Badge>
                )}
                <Badge variant="secondary">{d.category}</Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
