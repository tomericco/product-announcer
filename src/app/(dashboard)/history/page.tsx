import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";

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
      <p className="text-sm text-gray-600">Announcements that have actually been sent to your users.</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            <th className="py-2">Title</th>
            <th>Category</th>
            <th>Sent</th>
          </tr>
        </thead>
        <tbody>
          {sentUpdates.map((u) => (
            <tr key={u.id} className="border-b">
              <td className="py-2">{u.title}</td>
              <td>{u.category}</td>
              <td>{u.publishedAt?.toLocaleDateString()}</td>
            </tr>
          ))}
          {sentUpdates.length === 0 && (
            <tr>
              <td colSpan={3} className="py-4 text-gray-500">
                No announcements sent yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
