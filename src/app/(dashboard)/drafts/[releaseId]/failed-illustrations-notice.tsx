import { listImages } from "@/lib/images/store";
import { DismissIllustrationsButton, RetryIllustrationButton } from "./retry-illustration-button";

/**
 * "1 image failed to generate — Retry" (spec §4). Lists the piece's generated
 * cover/body rows still at `status: "failed"`; each row's concept is what the
 * agent meant to draw, so the human knows what they are retrying. Renders
 * nothing when there is nothing to retry — the row disappears from this list
 * the moment `addRender` flips it to `ready`, and the X discards the failed
 * rows for anyone who is happy with the draft as it is.
 *
 * `listImages` has no status filter in the store contract, so the filter is
 * here. It is one tenant-scoped query per page load; the page already runs
 * several.
 */
export async function FailedIllustrationsNotice({ tenantId, contentPieceId }: { tenantId: string; contentPieceId: string }) {
  const images = await listImages(tenantId, { contentPieceId });
  const failed = images.filter(
    (image) => image.status === "failed" && image.sourceKind === "generated" && (image.role === "cover" || image.role === "body")
  );
  if (failed.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">
          {failed.length === 1 ? "1 image failed to generate" : `${failed.length} images failed to generate`}
        </p>
        <DismissIllustrationsButton contentPieceId={contentPieceId} />
      </div>
      <p className="text-muted-foreground">
        The draft is complete without them. Save any edits first, then retry — a retried image is placed under
        the section it was planned for.
      </p>
      <ul className="space-y-1.5">
        {failed.map((image) => (
          <li key={image.id} className="flex items-center justify-between gap-3">
            <span>
              <span className="text-muted-foreground">{image.role === "cover" ? "Cover: " : `Under "${image.anchorHeading ?? "?"}": `}</span>
              {image.concept}
            </span>
            <RetryIllustrationButton contentPieceId={contentPieceId} imageId={image.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}
