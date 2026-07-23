import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { releases, deliveryAttempts } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { destinationLabel } from "@/lib/publishing/dispatch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function HistoryPage() {
  const session = await requireSession();
  const sentUpdates = await db
    .select()
    .from(releases)
    .where(and(eq(releases.tenantId, session.user.tenantId), eq(releases.status, "published")))
    .orderBy(desc(releases.publishedAt));

  // Which destinations each release actually reached. Only SUCCESSFUL
  // deliveries count as "delivered" — a failed/pending attempt must not be
  // shown as a destination the release went to. One grouped query over every
  // release on the page rather than a per-row lookup.
  const deliveredByRelease = new Map<string, string[]>();
  if (sentUpdates.length > 0) {
    const delivered = await db
      .select({ releaseId: deliveryAttempts.releaseId, destination: deliveryAttempts.destination })
      .from(deliveryAttempts)
      .where(
        and(
          inArray(
            deliveryAttempts.releaseId,
            sentUpdates.map((u) => u.id)
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

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Release history</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Delivered to</TableHead>
            <TableHead>Sent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sentUpdates.map((u) => {
            const destinations = deliveredByRelease.get(u.id);
            return (
              <TableRow key={u.id}>
                <TableCell>{u.title}</TableCell>
                <TableCell className="text-muted-foreground">
                  {destinations && destinations.length > 0 ? destinations.slice().sort().join(", ") : "—"}
                </TableCell>
                <TableCell>{u.publishedAt?.toLocaleDateString()}</TableCell>
              </TableRow>
            );
          })}
          {sentUpdates.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                No announcements sent yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
