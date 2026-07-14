import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await db
    .select()
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "draft")));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Drafts</h1>
      <ul className="space-y-2">
        {drafts.map((d) => (
          <li key={d.id} className="border p-3">
            <Link href={`/drafts/${d.id}`} className="font-medium underline">
              {d.title}
            </Link>
            <p className="text-sm text-gray-500">{d.category}</p>
          </li>
        ))}
        {drafts.length === 0 && <li className="text-gray-500">No drafts waiting for review.</li>}
      </ul>
    </div>
  );
}
