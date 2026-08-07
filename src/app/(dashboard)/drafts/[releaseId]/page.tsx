import { and, eq } from "drizzle-orm";
import { GuardedLink } from "../../unsaved-changes";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { contentPieces, webflowConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reviewStatusLabel } from "@/lib/ai/review-status";
import { Badge } from "@/components/ui/badge";
import { GenerateDraftButton } from "./generate-draft-button";
import { containsCodeBlock } from "@/lib/publishing/markdown-to-html";
import { computeReleaseDelta } from "@/lib/change-events/release-deltas";
import { saveDraft } from "../actions";
import { ToastForm } from "../../settings/toast-form";
import { DraftBodyEditor } from "./draft-body-editor";
import { DraftTitleField } from "./draft-title-field";
import { DraftEditorProvider, SourceToggleButton } from "./draft-editor-context";
import { AgentEditProvider } from "./agent-edit-context";
import { AgentEditDialog } from "./agent-edit-dialog";
import { ExtractDialog } from "./extract-dialog";
import { AskAiButton } from "./ask-ai-button";
import { SaveChangesButton, RejectButton } from "./draft-submit-buttons";
import { PublishDialog } from "./publish-dialog";
import { CatchUpBanner } from "./catch-up-banner";
import { WebflowCodeWarning } from "./webflow-code-warning";
import { listPublishTargets } from "@/lib/publishing/dispatch";
import { linkedinDestination } from "@/lib/publishing/destinations/linkedin";
import { readVariant } from "@/lib/publishing/channel-variants";
import { slugify } from "@/lib/publishing/slug";
import { LinkedinPanel } from "./linkedin-panel";

export default async function DraftDetailPage({ params }: { params: Promise<{ releaseId: string }> }) {
  const session = await requireSession();
  const { releaseId } = await params;

  const [update] = await db
    .select()
    .from(contentPieces)
    .where(and(eq(contentPieces.id, releaseId), eq(contentPieces.tenantId, session.user.tenantId)));

  if (!update) notFound();

  // A "brief"-status piece is an accepted brief whose draft hasn't been
  // generated yet — its body is still `scaffoldBody`'s deterministic outline,
  // not real copy. None of the editor/publish machinery below applies to it
  // (assertDraftEditable refuses all of it), and none of its supporting
  // queries — Webflow connection, release delta, publish targets, LinkedIn
  // config — are meaningful for a piece that has never been drafted, so this
  // returns before any of them run.
  if (update.status === "brief") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between bg-background px-4 py-3">
          <GuardedLink
            href="/drafts"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Drafts
          </GuardedLink>
        </div>

        <div className="space-y-2">
          <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">
            {update.title || "Untitled draft"}
          </h1>
          <Badge variant={update.generationError ? "destructive" : "outline"}>
            {update.generationError ? "Generation failed" : "Awaiting generation"}
          </Badge>
        </div>

        {update.generationError ? (
          <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">The last generation attempt failed.</p>
            <p>{update.generationError}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This brief was accepted, but its draft hasn&apos;t been generated yet. The outline below
            is the scaffold it was accepted with, not the finished copy.
          </p>
        )}

        <pre className="rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap">{update.body}</pre>

        <GenerateDraftButton contentPieceId={update.id} isRetry={Boolean(update.generationError)} />
      </div>
    );
  }

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

  // Read-only — how stale this draft has gone against its `composedAt`
  // baseline (new atomic updates since compose, or evidence changes on ones
  // already linked). Computed server-side so the client banner only ever
  // receives a plain number, never queries the db itself.
  const delta = await computeReleaseDelta(update.id);

  const publishTargets = await listPublishTargets(session.user.tenantId);

  // Reuse the destination's own `loadConfig` for the gate (rather than a
  // separate "is LinkedIn set up" check) so this panel can never drift out
  // of sync with what `deliver()` actually requires at publish time.
  const linkedinConfig = await linkedinDestination.loadConfig(session.user.tenantId, db);
  const linkedinVariant = linkedinConfig ? await readVariant(db, update.id, "linkedin") : null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <DraftEditorProvider>
        <AgentEditProvider>
          <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between bg-background px-4 py-3">
            <GuardedLink
              href="/drafts"
              className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Drafts
            </GuardedLink>
            <SourceToggleButton />
          </div>

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

          {/* status here is always "draft" (the "brief" branch returns
              above), so a set generationError means the post-generation
              competitor-name scan matched something — not a failure. The
              draft is real and the editor below is fully usable; this is a
              warning to look at, not a reason to distrust the body. */}
          {update.generationError && (
            <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">Worth a look before you publish</p>
              <p>{update.generationError}</p>
            </div>
          )}

          {showCodeWarning && <WebflowCodeWarning contentPieceId={update.id} />}

          {delta.count > 0 && <CatchUpBanner count={delta.count} contentPieceId={update.id} />}

          {/* ToastForm, not a plain <form>: saveDraft stays a Server Action but
              the confirmation toast fires client-side once it resolves. Only the
              form's default action is wrapped — Reject overrides it with
              formAction, and Publish reads the form via a ref instead of
              submitting, so neither reports "Changes saved". */}
          <ToastForm action={saveDraft} successMessage="Changes saved" className="space-y-4">
            <input type="hidden" name="contentPieceId" value={update.id} />
            {/* The value published_at had when this page was rendered. Approve
                submits it back so the action can detect a double-submit of this
                same form (published_at unchanged) versus an intentional
                re-publish (a fresh page load first, carrying the current
                value). Empty string, not "null", so a never-published draft's
                hidden field is unambiguous on the wire. */}
            <input
              type="hidden"
              name="publishedAt"
              value={update.publishedAt ? update.publishedAt.toISOString() : ""}
            />
            {/* The visible title is an input, so the document outline would
                otherwise have no heading at all — give screen readers a real h1. */}
            <h1 className="sr-only">{update.title || "Untitled draft"}</h1>
            <DraftTitleField defaultValue={update.title} />
            <DraftBodyEditor defaultValue={update.body} />
            <div className="flex items-center gap-3 pt-4">
              <RejectButton />
              <SaveChangesButton />
              <AskAiButton />
              <div className="ml-auto">
                <PublishDialog contentPieceId={update.id} targets={publishTargets} />
              </div>
            </div>
          </ToastForm>

          {/* Own <form>s, so rendered as a sibling of the saveDraft form
              rather than nested inside it (nested <form>s are invalid HTML). */}
          {linkedinConfig && (
            <LinkedinPanel
              contentPieceId={update.id}
              initialBody={linkedinVariant?.body ?? ""}
              baseUrl={linkedinConfig.baseUrl!}
              slug={slugify(update.title)}
            />
          )}

          <AgentEditDialog contentPieceId={update.id} />
          <ExtractDialog contentPieceId={update.id} />
        </AgentEditProvider>
      </DraftEditorProvider>
    </div>
  );
}
