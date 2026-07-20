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
import { DraftTitleField } from "./draft-title-field";
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
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{statusLabel}</p>
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {update.reviewIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <DraftEditorProvider>
        <form action={saveDraft} className="space-y-4">
          <input type="hidden" name="updateId" value={update.id} />
          {/* The visible title is an input, so the document outline would
              otherwise have no heading at all — give screen readers a real h1. */}
          <h1 className="sr-only">{update.title || "Untitled draft"}</h1>
          <DraftTitleField defaultValue={update.title} />
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
