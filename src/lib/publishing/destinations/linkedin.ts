import { and, eq, isNotNull } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";
import {
  createPost,
  getImageStatus,
  initializeImageUpload,
  uploadImageBytes,
  LinkedinApiError,
} from "@/lib/integrations/linkedin/client";
import { slugify } from "@/lib/publishing/slug";
import { readVariant } from "@/lib/publishing/channel-variants";
import { loadCoverImagePayload, type CoverImagePayload } from "@/lib/publishing/cover-image";
import type { Destination, DeliveryResult, DbClient, ContentPiece } from "./types";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

// How many times to ask LinkedIn whether the uploaded image is AVAILABLE
// before handing the wait to the delivery_attempts retry sweep. Uploads are
// usually ready within a second or two; five polls a second apart bounds a
// single publish action at ~5 s of waiting plus the per-request 10 s timeouts.
const IMAGE_STATUS_POLLS = 5;
function imagePollIntervalMs(): number {
  return Number(process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS ?? 1000);
}
const BLOB_FETCH_TIMEOUT_MS = 10_000;

// NOTE ON WHERE THIS RUNS. `deliver` is called from inside
// `claimAndDeliver`'s transaction, holding `SELECT ... FOR UPDATE` on the
// delivery_attempts row for the whole call (dispatch.ts:88-153, and its
// comment explains why the lock must span the network call). This flow adds a
// blob download, an upload and up to 5 one-second polls to that span — call it
// ~5-10 s of lock, up from ~1 s. That is one row of one table, and the only
// contender is the hourly sweep, so it is acceptable; it is NOT acceptable to
// grow the poll budget without revisiting this. If the wait ever needs to be
// longer, return `retryable` with the URN sooner and let the sweep own the
// wait — which is exactly what the poll budget already does.
//
// No `maxDuration` is exported here (same stance as briefs/actions.ts):
// Plan 4's final review put the worst case — blob download + initialize +
// upload + 5 polls, each with its own timeout — at ~85 s, well inside the
// platform's default function timeout of 300 s, so there's nothing to fix by
// guessing a number.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof LinkedinApiError && (error.status === 401 || error.status === 403);
}

function classify(error: unknown): DeliveryResult {
  if (error instanceof LinkedinApiError) {
    if (error.status === 401 || error.status === 403) {
      return { status: "permanent", error: "LinkedIn rejected the token. Reconnect the integration.", configFault: true };
    }
    if (error.status === 429 || error.status === 408 || error.status >= 500) {
      return { status: "retryable", error: error.message };
    }
    return { status: "permanent", error: `LinkedIn rejected the post: ${error.message}` };
  }
  return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
}

// Best-effort: flip the connection to needs_reauth so the integrations banner
// prompts a reconnect. Never let this turn a clean classification into a throw.
async function recordNeedsReauth(database: DbClient, connectionId: string): Promise<void> {
  try {
    await database.update(linkedinConnections).set({ status: "needs_reauth" }).where(eq(linkedinConnections.id, connectionId));
  } catch (error) {
    console.error(`Failed to mark LinkedIn connection ${connectionId} as needs_reauth:`, error);
  }
}

async function classifyAndRecord(error: unknown, database: DbClient, connectionId: string): Promise<DeliveryResult> {
  if (isAuthFailure(error)) await recordNeedsReauth(database, connectionId);
  return classify(error);
}

// Fetches the cover PNG from Blob. A plain Error (not LinkedinApiError) on any
// failure so classify() treats it as retryable — Blob is a CDN, this is a
// transient network problem, never a content problem.
async function downloadCover(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Could not download the cover image: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Polls one image URN. Returns the terminal status, or "PROCESSING" once the
// poll budget is spent — the caller turns that into `retryable` so the sweep
// picks it up later without re-uploading.
async function pollImage(accessToken: string, imageUrn: string): Promise<"AVAILABLE" | "FAILED" | "PROCESSING"> {
  for (let poll = 0; poll < IMAGE_STATUS_POLLS; poll++) {
    if (poll > 0) await sleep(imagePollIntervalMs());
    const status = await getImageStatus({ accessToken, imageUrn });
    if (status !== "PROCESSING") return status;
  }
  return "PROCESSING";
}

type PreparedCover = { ok: true; imageUrn: string } | { ok: false; result: DeliveryResult };

// Turns the cover into an AVAILABLE LinkedIn image URN, reusing the URN a
// previous attempt stored on the delivery row so a retry never uploads twice.
// Any thrown error is classified exactly like a post error, and — once a URN
// exists — a retryable classification carries it as metadata.
//
// The stored URN is only trusted when it was uploaded from the SAME render
// that is currently the piece's cover (storedRenderId === cover.renderId).
// Regenerating or restoring a different render on an already-published
// piece's cover is a reachable flow, and a URN minted from a since-replaced
// render is a valid LinkedIn asset — just the wrong image. A mismatch (or a
// stored URN with no stored render id to confirm it against) is treated
// exactly like no stored URN at all: skip straight to a fresh upload without
// polling the stale one first.
async function prepareCoverImage(args: {
  accessToken: string;
  ownerUrn: string;
  cover: CoverImagePayload;
  storedImageUrn: string | null;
  storedRenderId: string | null;
  database: DbClient;
  connectionId: string;
}): Promise<PreparedCover> {
  const trustStored = args.storedImageUrn !== null && args.storedRenderId === args.cover.renderId;
  let imageUrn = trustStored ? args.storedImageUrn : null;
  try {
    if (imageUrn) {
      const status = await pollImage(args.accessToken, imageUrn);
      if (status === "AVAILABLE") return { ok: true, imageUrn };
      if (status === "PROCESSING") {
        return {
          ok: false,
          result: {
            status: "retryable",
            error: "LinkedIn is still processing the cover image; will retry.",
            metadata: { linkedinImageUrn: imageUrn, coverRenderId: args.cover.renderId },
          },
        };
      }
      // FAILED: the earlier upload is dead — mint a fresh one below.
      imageUrn = null;
    }

    const bytes = await downloadCover(args.cover.url);
    const init = await initializeImageUpload({ accessToken: args.accessToken, ownerUrn: args.ownerUrn });
    imageUrn = init.imageUrn;
    await uploadImageBytes({ uploadUrl: init.uploadUrl, bytes, accessToken: args.accessToken });

    const status = await pollImage(args.accessToken, imageUrn);
    if (status === "AVAILABLE") return { ok: true, imageUrn };
    if (status === "FAILED") {
      return { ok: false, result: { status: "permanent", error: "LinkedIn could not process the cover image." } };
    }
    return {
      ok: false,
      result: {
        status: "retryable",
        error: "LinkedIn is still processing the cover image; will retry.",
        metadata: { linkedinImageUrn: imageUrn, coverRenderId: args.cover.renderId },
      },
    };
  } catch (error) {
    const result = await classifyAndRecord(error, args.database, args.connectionId);
    return { ok: false, result: withImageUrn(result, imageUrn, args.cover.renderId) };
  }
}

// Attach the URN (and the render it came from) to a retryable result so the
// next attempt skips the upload — but only when it can validate the reuse
// against the same render on its next pass. ok/permanent results are
// returned unchanged (ok gets its metadata at the post step; permanent rows
// are done).
function withImageUrn(result: DeliveryResult, imageUrn: string | null, coverRenderId: string): DeliveryResult {
  if (imageUrn && result.status === "retryable") {
    return { ...result, metadata: { linkedinImageUrn: imageUrn, coverRenderId } };
  }
  return result;
}

export const linkedinDestination: Destination<LinkedinConnection> = {
  id: "linkedin",
  label: "LinkedIn",

  async loadConfig(tenantId, database: DbClient) {
    const [connection] = await database
      .select()
      .from(linkedinConnections)
      .where(
        and(
          eq(linkedinConnections.tenantId, tenantId),
          eq(linkedinConnections.status, "active"),
          isNotNull(linkedinConnections.organizationUrn),
          isNotNull(linkedinConnections.baseUrl)
        )
      )
      .limit(1);
    return connection ?? null;
  },

  async deliver(piece: ContentPiece, connection, externalId, database, metadata): Promise<DeliveryResult> {
    // Post-once: a piece already posted to LinkedIn must never be re-posted
    // (that would duplicate/spam), unlike Webflow which updates in place.
    if (externalId) return { status: "ok", externalId };

    if (!connection.organizationUrn || !connection.baseUrl) {
      return { status: "permanent", error: "LinkedIn connection is missing an organization or base URL.", configFault: true };
    }
    // Company-only guarantee 2: never post as a personal member. The author
    // must be an organization URN; anything else is a config fault, not a post.
    if (!connection.organizationUrn.startsWith("urn:li:organization:")) {
      return { status: "permanent", error: "LinkedIn author must be an organization page.", configFault: true };
    }
    const variant = await readVariant(database, piece.id, "linkedin");
    if (!variant || !variant.body.trim()) {
      return { status: "permanent", error: "Generate a LinkedIn post before publishing." };
    }

    const link = new URL(slugify(piece.title), connection.baseUrl).toString();
    const commentary = `${variant.body.trim()}\n\n${link}`;

    // Acquire the token BEFORE the network try-block. getValidAccessToken can
    // fail two ways that must NOT be lumped in with a retryable network error:
    //   - LinkedinApiError 401/403: token dead / refresh impossible -> permanent
    //     + configFault, and mark the connection needs_reauth.
    //   - a plain Error from decryptSecret (rotated/misconfigured
    //     CREDENTIALS_ENCRYPTION_KEY): retrying can never help -> permanent +
    //     configFault. Falling through to the network classifier would retry a
    //     decrypt failure forever. Mirrors webflow.ts's decrypt guard.
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(connection, database);
    } catch (error) {
      if (isAuthFailure(error)) {
        await recordNeedsReauth(database, connection.id);
        return classify(error);
      }
      return {
        status: "permanent",
        error: "Could not obtain a LinkedIn access token. Check the connection and CREDENTIALS_ENCRYPTION_KEY.",
        configFault: true,
      };
    }

    // The cover rides along as the post's own image (spec §8): larger in the
    // feed than a link card and independent of the blog page's og:image. No
    // ready cover → text + link, exactly as before.
    const cover = await loadCoverImagePayload(piece.tenantId, piece.id, database);
    let media: { imageUrn: string; altText: string; renderId: string } | undefined;
    if (cover) {
      const prepared = await prepareCoverImage({
        accessToken,
        ownerUrn: connection.organizationUrn,
        cover,
        storedImageUrn: metadata?.linkedinImageUrn ?? null,
        storedRenderId: metadata?.coverRenderId ?? null,
        database,
        connectionId: connection.id,
      });
      if (!prepared.ok) return prepared.result;
      media = { imageUrn: prepared.imageUrn, altText: cover.alt, renderId: cover.renderId };
    }

    try {
      const { postUrn } = await createPost({
        accessToken,
        authorUrn: connection.organizationUrn,
        commentary,
        media: media ? { imageUrn: media.imageUrn, altText: media.altText } : undefined,
      });
      if (!postUrn) {
        return {
          status: "permanent",
          error: "LinkedIn accepted the post but returned no post id; not retrying to avoid duplicating it.",
        };
      }
      return media
        ? { status: "ok", externalId: postUrn, metadata: { linkedinImageUrn: media.imageUrn, coverRenderId: media.renderId } }
        : { status: "ok", externalId: postUrn };
    } catch (error) {
      const result = await classifyAndRecord(error, database, connection.id);
      return withImageUrn(result, media?.imageUrn ?? null, media?.renderId ?? "");
    }
  },
};
