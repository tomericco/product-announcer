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
import { DraftBodyEditor } from "./draft-body-editor";
import { DraftEditorProvider, SourceToggleButton } from "./draft-editor-context";

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
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <Link
        href="/drafts"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Drafts
      </Link>

      {statusLabel && (
        <p className="text-sm text-muted-foreground">
          {statusLabel}
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <span className="mt-1 block space-y-0.5">
              {update.reviewIssues.map((issue, i) => (
                <span key={i} className="block">
                  &middot; {issue}
                </span>
              ))}
            </span>
          )}
        </p>
      )}

      <DraftEditorProvider>
        <form action={saveDraft} className="space-y-4">
          <input type="hidden" name="updateId" value={update.id} />
          <input
            id="title"
            name="title"
            defaultValue={update.title}
            placeholder="Untitled"
            aria-label="Title"
            className="w-full border-0 bg-transparent p-0 text-4xl font-bold tracking-tight outline-none placeholder:text-muted-foreground/40 focus:outline-none"
          />
          <DraftBodyEditor defaultValue={update.body} />
          <div className="flex items-center gap-4 pt-4">
            <SourceToggleButton />
            <Button type="submit" variant="ghost">
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
      </DraftEditorProvider>

      <form action={rejectDraft} className="flex items-center gap-3 pt-2">
        <input type="hidden" name="updateId" value={update.id} />
        <p className="text-sm text-muted-foreground">Not right?</p>
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-sm text-muted-foreground hover:bg-transparent hover:text-destructive hover:underline"
        >
          Reject this draft
        </Button>
      </form>
    </div>
  );
}
