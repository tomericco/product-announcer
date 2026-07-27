import { and, eq } from "drizzle-orm";
import { GuardedLink } from "../../unsaved-changes";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { releases, webflowConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { reviewStatusLabel } from "@/lib/ai/review-status";
import { containsCodeBlock } from "@/lib/publishing/markdown-to-html";
import { computeReleaseDelta } from "@/lib/change-events/release-deltas";
import { saveDraft } from "../actions";
import { DraftBodyEditor } from "./draft-body-editor";
import { DraftTitleField } from "./draft-title-field";
import { DraftEditorProvider, SourceToggleButton } from "./draft-editor-context";
import { AgentEditProvider } from "./agent-edit-context";
import { AgentEditDialog } from "./agent-edit-dialog";
import { AskAiButton } from "./ask-ai-button";
import { SaveChangesButton, RejectButton } from "./draft-submit-buttons";
import { PublishDialog } from "./publish-dialog";
import { CatchUpBanner } from "./catch-up-banner";
import { WebflowCodeWarning } from "./webflow-code-warning";
import { listPublishTargets } from "@/lib/publishing/dispatch";
import { linkedinDestination } from "@/lib/publishing/destinations/linkedin";
import { slugify } from "@/lib/publishing/slug";
import { LinkedinPanel } from "./linkedin-panel";

export default async function DraftDetailPage({ params }: { params: Promise<{ releaseId: string }> }) {
  const session = await requireSession();
  const { releaseId } = await params;

  const [update] = await db
    .select()
    .from(releases)
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)));

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

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <DraftEditorProvider>
        <AgentEditProvider>
          <div className="flex items-center justify-between">
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

          {showCodeWarning && <WebflowCodeWarning releaseId={update.id} />}

          {delta.count > 0 && <CatchUpBanner count={delta.count} releaseId={update.id} />}

          <form action={saveDraft} className="space-y-4">
            <input type="hidden" name="releaseId" value={update.id} />
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
                <PublishDialog targets={publishTargets} />
              </div>
            </div>
          </form>

          {/* Own <form>s, so rendered as a sibling of the saveDraft form
              rather than nested inside it (nested <form>s are invalid HTML). */}
          {linkedinConfig && (
            <LinkedinPanel
              releaseId={update.id}
              initialBody={update.linkedinBody ?? ""}
              baseUrl={linkedinConfig.baseUrl!}
              slug={slugify(update.title)}
            />
          )}

          <AgentEditDialog releaseId={update.id} />
        </AgentEditProvider>
      </DraftEditorProvider>
    </div>
  );
}
