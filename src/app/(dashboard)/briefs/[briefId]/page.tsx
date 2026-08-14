import { and, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { briefs, type Brief } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { briefBody } from "@/lib/briefs/body";
import { Badge } from "@/components/ui/badge";
import { EditorProvider } from "@/components/markdown/editor-context";
import { BriefHeader } from "./brief-header";
import { BriefEditor } from "./brief-editor";

const CONTENT_TYPE_LABEL: Record<Brief["contentType"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

const DECIDED_LABEL: Record<Exclude<Brief["status"], "new">, string> = {
  accepted: "Accepted",
  dismissed: "Dismissed",
  expired: "Expired",
};

function BriefBadges({ brief }: { brief: Brief }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{CONTENT_TYPE_LABEL[brief.contentType]}</Badge>
      <Badge variant="outline">{brief.suggestedChannel}</Badge>
      <Badge variant="outline">{brief.score.toFixed(2)}</Badge>
      {brief.status !== "new" && <Badge variant="outline">{DECIDED_LABEL[brief.status]}</Badge>}
    </div>
  );
}

/**
 * The brief as a document you write. Same shape as `/drafts/[releaseId]`, and
 * reusing its parts rather than restating them: the shared `MdxEditor`, the
 * editor-bridge context and Source toggle that used to live in the drafts
 * folder, and the same baseline/dirty pattern.
 *
 * An async Server Component — in this Next.js `params` is a `Promise` and must
 * be awaited (see `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`).
 * `briefId` arrives from the URL and is untrusted, so the read is scoped by
 * tenant and a miss is a 404, not a "not yours" — which would confirm that
 * another tenant's brief exists.
 */
export default async function BriefDetailPage({ params }: { params: Promise<{ briefId: string }> }) {
  const session = await requireSession();
  const { briefId } = await params;

  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.id, briefId), eq(briefs.tenantId, session.user.tenantId)));

  if (!brief) notFound();

  // Every read of a brief's document body goes through this one accessor: a
  // row created before `briefs.body` existed has a null body and renders from
  // its structured fields on demand, byte-identical to what it would have been
  // seeded with at creation.
  const body = briefBody(brief);

  // Accepted or dismissed opens read-only. Editing a brief whose draft has
  // already been generated would silently diverge the two, and the draft is
  // the live document at that point. `saveBriefBody` refuses the same two
  // statuses — this branch is the UI half of a rule the server enforces.
  if (brief.status === "accepted" || brief.status === "dismissed") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between bg-background px-4 py-3">
          <Link
            href="/briefs"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Briefs
          </Link>
        </div>

        <div className="space-y-2">
          <BriefBadges brief={brief} />
          <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">
            {brief.title || "Untitled brief"}
          </h1>
        </div>

        <p className="text-sm text-muted-foreground">
          {brief.status === "accepted"
            ? "This brief was accepted, so it's shown here for reference only — the draft it produced is the live document now."
            : "This brief was dismissed, so it's shown here for reference only."}
        </p>

        {brief.status === "accepted" && brief.contentPieceId && (
          <Link href={`/drafts/${brief.contentPieceId}`} className="text-sm underline">
            Open the draft
          </Link>
        )}

        <pre className="rounded-md border bg-muted/30 p-4 text-sm whitespace-pre-wrap">{body}</pre>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <EditorProvider>
        <BriefHeader briefId={brief.id} canDecide={brief.status === "new"} />
        <BriefBadges brief={brief} />
        <BriefEditor briefId={brief.id} initialTitle={brief.title} initialBody={body} />
      </EditorProvider>
    </div>
  );
}
