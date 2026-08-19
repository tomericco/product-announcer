import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { contentPieces, type ImageRole, type ImageSourceKind } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listLibraryImages } from "@/lib/images/store";
import { Badge } from "@/components/ui/badge";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { ImageFilters } from "./image-filters";
import { ImageGrid, type LibraryImage } from "./image-card";
import { GenerateDialog } from "./generate-dialog";

const ROLES: readonly ImageRole[] = ["cover", "body", "library"];
const SOURCES: readonly ImageSourceKind[] = ["generated", "uploaded"];

export default async function ImagesPage({
  searchParams,
}: {
  searchParams: Promise<{ pieceId?: string; role?: string; source?: string }>;
}) {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const sp = await searchParams;
  const role = ROLES.find((r) => r === sp.role);
  const source = SOURCES.find((s) => s === sp.source);
  const pieceId = sp.pieceId && sp.pieceId !== "all" ? sp.pieceId : undefined;

  const [rows, pieces, publishedRows] = await Promise.all([
    // The library shows images of pieces past drafting, plus standalone
    // library images (product owner decision 4, spec §5b). A draft you are
    // still writing keeps its images in its own editor.
    listLibraryImages(tenantId, { contentPieceId: pieceId, role, sourceKind: source }),
    db
      .select({ id: contentPieces.id, title: contentPieces.title })
      .from(contentPieces)
      .where(eq(contentPieces.tenantId, tenantId))
      .orderBy(desc(contentPieces.createdAt))
      .limit(200),
    // Which pieces are published decides which images can't be deleted (spec
    // §5b, Webflow hotlink safety) — computed here so the button can explain
    // before a click rather than after a refusal.
    db
      .select({ id: contentPieces.id })
      .from(contentPieces)
      .where(and(eq(contentPieces.tenantId, tenantId), isNotNull(contentPieces.publishedAt))),
  ]);
  const published = new Set(publishedRows.map((p) => p.id));

  const images: LibraryImage[] = rows.map((r) => ({
    id: r.id,
    role: r.role as ImageRole,
    sourceKind: r.sourceKind as ImageSourceKind,
    status: r.status,
    concept: r.concept,
    altText: r.altText,
    contentPieceId: r.contentPieceId,
    pieceTitle: r.pieceTitle,
    piecePublished: r.contentPieceId ? published.has(r.contentPieceId) : false,
    createdAt: r.createdAt.toISOString(),
    url: r.current?.blobUrl ?? null,
    prompt: r.current?.prompt ?? "",
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Images</h1>
        <Badge variant="secondary">{images.length}</Badge>
        <div className="ml-auto">
          <GenerateDialog />
        </div>
      </div>
      <p className="text-sm text-muted-foreground">Every generated and uploaded image across your content, newest first.</p>
      <ImageFilters state={{ pieceId: pieceId ?? "all", role: role ?? "all", source: source ?? "all" }} pieces={pieces} />
      {images.length === 0 ? (
        // The page-level EmptyState primitive, as /signals and /history use it
        // (read empty-state.tsx for the exact subcomponent names before use).
        <EmptyState>
          <EmptyStateTitle>No images yet</EmptyStateTitle>
          <EmptyStateDescription>
            Generate one here, or from a draft&apos;s editor — every generated and uploaded image lands in this
            library.
          </EmptyStateDescription>
        </EmptyState>
      ) : (
        <ImageGrid images={images} />
      )}
    </div>
  );
}
