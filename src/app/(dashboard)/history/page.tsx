import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
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
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "published")))
    .orderBy(desc(updates.publishedAt));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">History</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Sent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sentUpdates.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.title}</TableCell>
              <TableCell>
                <Badge variant="secondary">{u.category}</Badge>
              </TableCell>
              <TableCell>{u.publishedAt?.toLocaleDateString()}</TableCell>
            </TableRow>
          ))}
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
