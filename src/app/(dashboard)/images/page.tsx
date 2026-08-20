import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { contentPieces, type ImageRole, type ImageSourceKind } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listImageUsages, listLibraryImages } from "@/lib/images/store";
import { Badge } from "@/components/ui/badge";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { ImageFilters } from "./image-filters";
import { ImageGrid, type LibraryImage } from "./image-card";
import { GenerateDialog } from "./generate-dialog";

const ROLES: readonly ImageRole[] = ["cover", "body", "library"];
const SOURCES: readonly ImageSourceKind[] = ["generated", "uploaded"];

/** `listImageUsages` returns one row per matching content_images row, so the
 * same piece can appear twice if it references the same blob more than once
 * (e.g. inserted at two spots in one body) — collapse to one entry per piece. */
function dedupeByPieceId(usages: { pieceId: string; pieceTitle: string }[]): { pieceId: string; pieceTitle: string }[] {
  const seen = new Set<string>();
  return usages.filter((u) => (seen.has(u.pieceId) ? false : (seen.add(u.pieceId), true)));
}

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
    // The library shows images of every piece past "brief" (product owner
    // decision, 2026-08-20 — see LIBRARY_HIDDEN_PIECE_STATUSES's doc
    // comment), plus standalone library images.
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

  // Batched, not per-image: every piece currently showing each image
  // (including reuses via "From library" — see listImageUsages's doc
  // comment). Keyed by blob url, which is what the grid actually renders.
  const urls = [...new Set(rows.map((r) => r.current?.blobUrl).filter((u): u is string => u !== undefined))];
  const usagesByUrl = await listImageUsages(tenantId, urls);

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
    // De-duplicated by piece: two rows in the same piece could in principle
    // reference the same blob (e.g. inserted twice in one body), and that
    // must still show as one usage, not two.
    usages: dedupeByPieceId(r.current?.blobUrl ? (usagesByUrl.get(r.current.blobUrl) ?? []) : []),
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
