import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { releases, deliveryAttempts } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { destinationLabel } from "@/lib/publishing/dispatch";
import { HistoryList, type HistoryRow } from "./history-list";

export default async function HistoryPage() {
  const session = await requireSession();
  const sent = await db
    .select({ id: releases.id, title: releases.title, publishedAt: releases.publishedAt })
    .from(releases)
    .where(and(eq(releases.tenantId, session.user.tenantId), eq(releases.status, "published")))
    .orderBy(desc(releases.publishedAt));

  // Successful destinations per release for the row summary (one grouped query).
  const deliveredByRelease = new Map<string, string[]>();
  if (sent.length > 0) {
    const delivered = await db
      .select({ releaseId: deliveryAttempts.releaseId, destination: deliveryAttempts.destination })
      .from(deliveryAttempts)
      .where(
        and(
          inArray(
            deliveryAttempts.releaseId,
            sent.map((u) => u.id)
          ),
          eq(deliveryAttempts.status, "success")
        )
      );
    for (const { releaseId, destination } of delivered) {
      const list = deliveredByRelease.get(releaseId) ?? [];
      list.push(destinationLabel(destination));
      deliveredByRelease.set(releaseId, list);
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
      <h1 className="text-xl font-semibold">Release history</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <HistoryList rows={rows} />
    </div>
  );
}
