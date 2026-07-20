import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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

  const statusLabel = reviewStatusLabel(update.reviewStatus);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <Link
          href="/drafts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Drafts
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Edit draft</h1>
      </div>

      {statusLabel && (
        <div className="rounded-lg bg-muted/50 p-4">
          <p className="text-sm font-medium">{statusLabel}</p>
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {update.reviewIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <form action={saveDraft} className="space-y-6">
        <input type="hidden" name="updateId" value={update.id} />
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" defaultValue={update.title} />
        </div>
        <div className="space-y-2">
          <Label>Body</Label>
          <DraftBodyEditor defaultValue={update.body} />
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-border/60 pt-6">
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

      <form
        action={rejectDraft}
        className="flex items-center justify-between gap-4 border-t border-border/60 pt-6"
      >
        <input type="hidden" name="updateId" value={update.id} />
        <p className="text-sm text-muted-foreground">Not right? Reject it to take it out of the queue.</p>
        <Button type="submit" variant="ghost" className="text-muted-foreground hover:text-destructive">
          Reject
        </Button>
      </form>
    </div>
  );
}
