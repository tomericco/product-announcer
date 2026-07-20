import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reviewStatusLabel } from "@/lib/ai/review-status";
import { saveDraft, approveDraft, rejectDraft } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DraftBodyEditor } from "./draft-body-editor";

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
      {reviewStatusLabel(update.reviewStatus) && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-medium">{reviewStatusLabel(update.reviewStatus)}</p>
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {update.reviewIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form action={saveDraft} className="space-y-4">
        <input type="hidden" name="updateId" value={update.id} />
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" defaultValue={update.title} />
        </div>
        <div className="space-y-2">
          <Label>Body</Label>
          <DraftBodyEditor defaultValue={update.body} />
        </div>
        <div className="flex items-center gap-4">
          <Button type="submit" variant="outline">
            Save changes
          </Button>
          {/* formAction overrides the form's default action (saveDraft) for this
              button only, so approving submits the same title/body the user is
              currently looking at instead of whatever was last saved to the DB. */}
          <Button type="submit" formAction={approveDraft}>
            Approve &amp; publish
          </Button>
        </div>
      </form>

      <div className="flex items-center gap-4">
        <form action={rejectDraft}>
          <input type="hidden" name="updateId" value={update.id} />
          <Button type="submit" variant="ghost" className="text-muted-foreground">
            Reject
          </Button>
        </form>
      </div>
    </div>
  );
}
