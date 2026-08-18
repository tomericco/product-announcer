import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contentPieces, deliveryAttempts } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { Badge } from "@/components/ui/badge";
import { destinationLabel } from "@/lib/publishing/dispatch";
import { HistoryList, type HistoryRow } from "./history-list";

export default async function HistoryPage() {
  const session = await requireSession();
  const sent = await db
    .select({ id: contentPieces.id, title: contentPieces.title, publishedAt: contentPieces.publishedAt })
    .from(contentPieces)
    .where(and(eq(contentPieces.tenantId, session.user.tenantId), eq(contentPieces.status, "published")))
    .orderBy(desc(contentPieces.publishedAt));

  // Successful destinations per content piece for the row summary (one grouped query).
  const deliveredByRelease = new Map<string, string[]>();
  if (sent.length > 0) {
    const delivered = await db
      .select({ contentPieceId: deliveryAttempts.contentPieceId, destination: deliveryAttempts.destination })
      .from(deliveryAttempts)
      .where(
        and(
          inArray(
            deliveryAttempts.contentPieceId,
            sent.map((u) => u.id)
          ),
          eq(deliveryAttempts.status, "success")
        )
      );
    for (const { contentPieceId, destination } of delivered) {
      const list = deliveredByRelease.get(contentPieceId) ?? [];
      list.push(destinationLabel(destination));
      deliveredByRelease.set(contentPieceId, list);
    }
  }

  const rows: HistoryRow[] = sent.map((u) => ({
    id: u.id,
    title: u.title,
    publishedAt: u.publishedAt ? u.publishedAt.toISOString() : null,
    delivered: deliveredByRelease.get(u.id) ?? [],
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Release history</h1>
        <Badge variant="secondary">{rows.length}</Badge>
      </div>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <HistoryList rows={rows} />
    </div>
  );
}
