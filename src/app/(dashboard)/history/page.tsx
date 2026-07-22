import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
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

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">History</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Sent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sentUpdates.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.title}</TableCell>
              <TableCell>{u.publishedAt?.toLocaleDateString()}</TableCell>
            </TableRow>
          ))}
          {sentUpdates.length === 0 && (
            <TableRow>
              <TableCell colSpan={2} className="text-muted-foreground">
                No announcements sent yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
