import { getCoverImage } from "@/lib/images/store";
import type { DbClient } from "./destinations/types";

// The cover as every destination sees it. Naming follows JSON Feed 1.1's
// `image` shape (spec §8, webhook): a public, stable, hotlinkable URL plus the
// alt and the dimensions so receivers can render a card without fetching.
export type CoverImagePayload = { url: string; alt: string; width: number; height: number };

// The one place delivery reads the cover row. A cover only travels when its
// row is `ready` AND has a current render — a `pending` (mid-regeneration)
// or `failed` cover must publish as "no cover", never as a dangling URL.
export async function loadCoverImagePayload(
  tenantId: string,
  contentPieceId: string,
  database: DbClient
): Promise<CoverImagePayload | null> {
  const cover = await getCoverImage(tenantId, contentPieceId, database);
  if (!cover || cover.status !== "ready" || !cover.current) return null;
  return {
    url: cover.current.blobUrl,
    alt: cover.altText,
    width: cover.current.width,
    height: cover.current.height,
  };
}
