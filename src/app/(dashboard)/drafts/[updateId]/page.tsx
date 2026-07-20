import { and, eq } from "drizzle-orm";
import { GuardedLink } from "../../unsaved-changes";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { updates, webflowConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reviewStatusLabel } from "@/lib/ai/review-status";
import { containsCodeBlock } from "@/lib/publishing/markdown-to-html";
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

  // Only warn once Webflow is actually usable as a publish target — a
  // connection row exists as soon as a token validates, but nothing can be
  // published until a collection is picked, so warning earlier would flag a
  // destination that can't receive anything yet.
  const [webflow] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);
  const showCodeWarning = Boolean(webflow?.collectionId) && containsCodeBlock(update.body);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <GuardedLink
        href="/drafts"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Drafts
      </GuardedLink>

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

      {showCodeWarning && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
          This draft contains a code block. Webflow&apos;s rich text field doesn&apos;t support code
          blocks, so it will be published as plain formatted text.
        </p>
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
