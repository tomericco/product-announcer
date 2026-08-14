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
import { GenerationChecklist } from "@/components/generation-checklist";
import { containsCodeBlock } from "@/lib/publishing/markdown-to-html";
import { computeReleaseDelta } from "@/lib/change-events/release-deltas";
import { saveDraft } from "../actions";
import { ToastForm } from "../../settings/toast-form";
import { DraftBodyEditor } from "./draft-body-editor";
import { DraftTitleField } from "./draft-title-field";
import { EditorProvider, SourceToggleButton } from "@/components/markdown/editor-context";
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
  // generated yet — its body is still the brief's own document, copied through
  // `briefBody` at accept time, not real copy. None of the editor/publish machinery below applies to it
  // (assertDraftEditable refuses all of it), and none of its supporting
  // queries — Webflow connection, release delta, publish targets, LinkedIn
  // config — are meaningful for a piece that has never been drafted, so this
  // returns before any of them run.
  if (update.status === "brief") {
    // A step in flight means this piece is generating RIGHT NOW, which
    // changes how everything below reads. `generationError` is non-null for
    // the whole run — `generateDraftForPiece` writes the
    // interrupted-generation marker BEFORE calling the model, deliberately, so
    // a process that dies mid-callback still leaves a visible error rather
    // than nothing. That marker describes a *previous* attempt's worst case,
    // not the current one, so presenting it as a landed failure while the run
    // is under way is simply wrong. The checklist replaces it, and it comes
    // back — honestly this time — the moment the step clears with the error
    // still set.
    const generating = update.generationStep !== null;

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
          <Badge variant={!generating && update.generationError ? "destructive" : "outline"}>
            {generating
              ? "Generating…"
              : update.generationError
                ? "Generation failed"
                : "Awaiting generation"}
          </Badge>
        </div>

        {/* Same gate as the board card (card.tsx) and the drafts list
            (drafts/page.tsx), and the same shared component — a generation is
            actually in flight, not merely un-run. This page needs it MORE than
            either of them: accepting a brief redirects straight here
            (briefs/[briefId]/brief-workspace.tsx, via brief-decision.tsx), so
            this is the page the author is sitting on during the one flow that
            reliably kicks off a background generation. Without it they
            watched a static "Awaiting generation" badge for the whole run.
            The row already selects every column, so `generationStep` is
            present and tenant-scoped by the query above. */}
        {generating ? (
          <GenerationChecklist contentPieceId={update.id} />
        ) : update.generationError ? (
          <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">The last generation attempt failed.</p>
            <p>{update.generationError}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This brief was accepted, but its draft hasn&apos;t been generated yet. What you see below
            is the brief it was accepted with, not the finished copy.
          </p>
        )}

        <pre className="rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap">{update.body}</pre>

        {/* isRetry reads the error only when it is a REAL landed failure —
            mid-run the marker is always set, and "Retry generation" on a
            first attempt that is still running would be nonsense. The button
            renders nothing at all while `generating`. */}
        <GenerateDraftButton
          contentPieceId={update.id}
          isRetry={!generating && Boolean(update.generationError)}
          inFlight={generating}
        />
      </div>
    );
  }

  // A `published` piece is not editable content anymore — it's a record of
  // what already shipped. `approveDraft`/`publishDraft` still ALLOW an
  // intentional re-publish of a `published` piece (see the allowlist and
  // comments in `drafts/actions.ts` and `assertDraftEditable`'s docstring in
  // `@/lib/draft-editable` — that flow is deliberate and
  // `tests/app/drafts/publish-idempotency.test.ts` locks it in), so this is
  // NOT a change to those actions. It closes a different hole: `/calendar`
  // (spec 8) is the first and only place that links a `published` piece into
  // THIS page. Before it existed, nothing reachable by clicking around ever
  // opened this editor for an already-published piece — `/drafts` filters to
  // `brief`/`draft`, and the board's `published` column is read-only. A fresh
  // load of this page for a published piece carries the CURRENT
  // `publishedAt` into the hidden field the double-submit guard checks, so an
  // accidental Publish click here would pass that guard and re-dispatch for
  // real (a duplicate LinkedIn post, a Webflow republish) while also
  // resetting the piece's date to today on the very calendar the click came
  // from. Gating the controls here — rather than refusing in the actions —
  // is what keeps the deliberate re-publish flow intact for whatever
  // legitimate caller needs it, while removing the accidental one-click path
  // to it.
  if (update.status === "published") {
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
          {/* Server-rendered once, never re-executed client-side (this is a
              plain Server Component, not hydrated JS) — so unlike the
              calendar's cards there is no server-vs-browser zone mismatch to
              gate behind hydration here; whatever renders is what stays on
              screen. */}
          <Badge variant="secondary">
            {update.publishedAt ? `Published ${update.publishedAt.toLocaleString()}` : "Published"}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          This piece has already been published. It is shown here for reference only —
          publishing, rejecting, and editing are only available before a piece goes out.
        </p>

        <pre className="rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap">{update.body}</pre>
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
      <EditorProvider>
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

          {/* status here is "draft", "review", "scheduled" or "published"
              (the "brief" branch returns above) — generationError is only
              ever set while a piece is "draft" or has moved on from it
              without being cleared, and in every one of those cases it means
              the post-generation competitor-name scan matched something, not
              a failure. The draft is real and the editor below is fully
              usable; this is a warning to look at, not a reason to distrust
              the body. The message itself (generationError, written in
              generateDraftForPiece) already spells out that this is a check
              against the tenant's saved competitors list, not a guarantee
              that no other company is named — a clean pass (no banner at
              all) is not that guarantee either. */}
          {update.generationError && (
            <div className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">Possible competitor mention</p>
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
      </EditorProvider>
    </div>
  );
}
