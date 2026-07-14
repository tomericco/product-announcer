import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveDraft, approveDraft, rejectDraft } from "../actions";
import { PreviewDialog } from "./preview-dialog";

export default async function DraftDetailPage({ params }: { params: Promise<{ updateId: string }> }) {
  const session = await requireSession();
  const { updateId } = await params;

  const [update] = await db
    .select()
    .from(updates)
    .where(and(eq(updates.id, updateId), eq(updates.tenantId, session.user.tenantId)));

  if (!update) notFound();

  return (
    <div className="space-y-8">
      <form action={saveDraft} className="max-w-lg space-y-3">
        <input type="hidden" name="updateId" value={update.id} />
        <label className="block">
          Title
          <input type="text" name="title" defaultValue={update.title} className="block w-full border p-2" />
        </label>
        <label className="block">
          Body
          <textarea name="body" defaultValue={update.body} rows={8} className="block w-full border p-2" />
        </label>
        <label className="block">
          Category
          <select name="category" defaultValue={update.category} className="block border p-2">
            <option value="new">New</option>
            <option value="improved">Improved</option>
            <option value="fixed">Fixed</option>
          </select>
        </label>
        <button type="submit" className="border px-4 py-2">
          Save changes
        </button>
      </form>

      <div className="flex items-center gap-4">
        <PreviewDialog
          updateId={update.id}
          title={update.title}
          body={update.body}
          category={update.category}
          onApprove={approveDraft}
        />
        <form action={rejectDraft}>
          <input type="hidden" name="updateId" value={update.id} />
          <button type="submit" className="text-sm text-gray-500 underline">
            Reject
          </button>
        </form>
      </div>
    </div>
  );
}
