import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await db
    .select()
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "draft")));

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
              <Badge variant="secondary">{d.category}</Badge>
            </CardContent>
          </Card>
        ))}
        {drafts.length === 0 && <p className="text-sm text-muted-foreground">No drafts waiting for review.</p>}
      </div>
    </div>
  );
}
