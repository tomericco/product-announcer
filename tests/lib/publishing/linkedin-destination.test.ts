import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { linkedinDestination } from "../../../src/lib/publishing/destinations/linkedin";
import type { ContentPiece, DbClient } from "../../../src/lib/publishing/destinations/types";

vi.mock("../../../src/lib/integrations/linkedin/token", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return {
    ...actual,
    createPost: vi.fn(),
    initializeImageUpload: vi.fn(),
    uploadImageBytes: vi.fn(),
    getImageStatus: vi.fn(),
  };
});
vi.mock("../../../src/lib/publishing/cover-image", () => ({ loadCoverImagePayload: vi.fn() }));
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";
import {
  createPost,
  initializeImageUpload,
  uploadImageBytes,
  getImageStatus,
  LinkedinApiError,
} from "../../../src/lib/integrations/linkedin/client";
import { loadCoverImagePayload } from "../../../src/lib/publishing/cover-image";

const release = (over: Partial<ContentPiece> = {}): ContentPiece =>
  ({ id: "r1", tenantId: "t1", title: "New Dashboard", body: "b", ...over } as ContentPiece);

const connection = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", status: "active", organizationUrn: "urn:li:organization:1", baseUrl: "https://acme.com/changelog/", ...over } as never);

// A DbClient stub that records update().set() payloads and serves a fixed
// channel_variants row (or none) for the readVariant() lookup inside deliver().
function dbStub(linkedinBody: string | undefined = "Hook.\n\nDetails.") {
  const sets: Record<string, unknown>[] = [];
  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(linkedinBody === undefined ? [] : [{ body: linkedinBody, editedAt: null }]),
        }),
      }),
    }),
    update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => Promise.resolve() }; } }),
  } as unknown as DbClient;
  return { database, sets };
}

describe("linkedin destination", () => {
  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
    vi.mocked(initializeImageUpload).mockReset();
    vi.mocked(uploadImageBytes).mockReset();
    vi.mocked(getImageStatus).mockReset();
    vi.mocked(loadCoverImagePayload).mockReset();
    // Default: no cover. The image tests below opt in.
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);
  });

  it("is a no-op success when already posted (externalId set)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release(), connection(), "urn:li:share:existing", database);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:existing" });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("permanently fails when the linkedin channel variant is empty", async () => {
    const { database } = dbStub("  ");
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result.status).toBe("permanent");
  });

  it("refuses to post when the author is not an organization urn (company-only)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(
      release(),
      connection({ organizationUrn: "urn:li:person:123" }),
      null,
      database
    );
    expect(result).toMatchObject({ status: "permanent", configFault: true });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("posts commentary with the appended slug link and stores the urn", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(createPost).mockResolvedValue({ postUrn: "urn:li:share:1" });
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1" });
    const arg = vi.mocked(createPost).mock.calls[0][0];
    expect(arg.commentary).toBe("Hook.\n\nDetails.\n\nhttps://acme.com/changelog/new-dashboard");
    expect(arg.authorUrn).toBe("urn:li:organization:1");
    expect(arg.media).toBeUndefined();
    expect(initializeImageUpload).not.toHaveBeenCalled();
  });

  it("classifies 401 as permanent configFault and marks needs_reauth", async () => {
    const { database, sets } = dbStub();
    vi.mocked(getValidAccessToken).mockRejectedValue(new LinkedinApiError(401, "expired"));
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result).toMatchObject({ status: "permanent", configFault: true });
    expect(sets).toContainEqual(expect.objectContaining({ status: "needs_reauth" }));
  });

  it("classifies a plain decrypt error from token acquisition as permanent configFault, not retryable", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error("decrypt failed"));
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result).toMatchObject({ status: "permanent", configFault: true });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("does not record success when LinkedIn returns an id-less 2xx (post-once guard)", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(createPost).mockResolvedValue({ postUrn: "" });
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result.status).toBe("permanent");
    expect(result.status).not.toBe("ok");
    expect(result.status).not.toBe("retryable");
  });

  it("classifies 5xx as retryable", async () => {
    const { database } = dbStub();
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(createPost).mockRejectedValue(new LinkedinApiError(503, "down"));
    const result = await linkedinDestination.deliver(release(), connection(), null, database);
    expect(result.status).toBe("retryable");
  });
});

describe("linkedin destination — native image post", () => {
  const COVER = {
    url: "https://blob.example/cover.png",
    alt: "Lighthouse over a grid",
    width: 1200,
    height: 630,
    renderId: "render-new",
  };
  const PNG = new Uint8Array([137, 80, 78, 71]);

  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
    vi.mocked(initializeImageUpload).mockReset();
    vi.mocked(uploadImageBytes).mockReset();
    vi.mocked(getImageStatus).mockReset();
    vi.mocked(loadCoverImagePayload).mockReset();
    vi.mocked(loadCoverImagePayload).mockResolvedValue(COVER);
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(initializeImageUpload).mockResolvedValue({ uploadUrl: "https://media.example/up/1", imageUrn: "urn:li:image:new" });
    vi.mocked(uploadImageBytes).mockResolvedValue(undefined);
    vi.mocked(createPost).mockResolvedValue({ postUrn: "urn:li:share:1" });
    // The only raw fetch deliver() makes itself is the blob download.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }))
    );
    // Don't actually wait between status polls.
    process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS = "0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS;
  });

  it("downloads the cover, initializes, uploads, polls to AVAILABLE, then posts with media and returns the urn as metadata", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({
      status: "ok",
      externalId: "urn:li:share:1",
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
    expect(loadCoverImagePayload).toHaveBeenCalledWith("t1", "r1", database);
    expect(fetch).toHaveBeenCalledWith("https://blob.example/cover.png", expect.anything());
    expect(initializeImageUpload).toHaveBeenCalledWith({ accessToken: "at", ownerUrn: "urn:li:organization:1" });
    const upload = vi.mocked(uploadImageBytes).mock.calls[0][0];
    expect(upload.uploadUrl).toBe("https://media.example/up/1");
    expect(Array.from(upload.bytes)).toEqual(Array.from(PNG));
    expect(getImageStatus).toHaveBeenCalledWith({ accessToken: "at", imageUrn: "urn:li:image:new" });
    const post = vi.mocked(createPost).mock.calls[0][0];
    expect(post.media).toEqual({ imageUrn: "urn:li:image:new", altText: "Lighthouse over a grid" });
    expect(post.commentary).toBe("Hook.\n\nDetails.\n\nhttps://acme.com/changelog/new-dashboard");
  });

  it("returns retryable WITH the image urn when LinkedIn is still processing after the poll budget, and never posts", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("PROCESSING");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({
      status: "retryable",
      error: expect.stringMatching(/still processing/i),
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
    expect(getImageStatus).toHaveBeenCalledTimes(5);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("on a retry with a stored urn, skips download/initialize/upload and posts once the image is AVAILABLE", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stored",
      // Same render the cover is currently on (COVER.renderId) — this is the
      // "reuse a still-valid urn" case, not the stale-render one.
      coverRenderId: "render-new",
    });

    expect(result).toEqual({
      status: "ok",
      externalId: "urn:li:share:1",
      metadata: { linkedinImageUrn: "urn:li:image:stored", coverRenderId: "render-new" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(uploadImageBytes).not.toHaveBeenCalled();
    expect(vi.mocked(createPost).mock.calls[0][0].media).toEqual({ imageUrn: "urn:li:image:stored", altText: "Lighthouse over a grid" });
  });

  it("when the stored urn's render id does not match the cover's current render id, ignores the stale urn and mints a fresh upload, never polling the stale one", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stale",
      coverRenderId: "render-old",
    });

    expect(result).toEqual({
      status: "ok",
      externalId: "urn:li:share:1",
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
    expect(getImageStatus).not.toHaveBeenCalledWith({ accessToken: "at", imageUrn: "urn:li:image:stale" });
    expect(initializeImageUpload).toHaveBeenCalledTimes(1);
    expect(uploadImageBytes).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createPost).mock.calls[0][0].media).toEqual({ imageUrn: "urn:li:image:new", altText: "Lighthouse over a grid" });
  });

  it("uploads fresh when the stored urn reports FAILED", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus)
      .mockResolvedValueOnce("FAILED") // the stored urn
      .mockResolvedValue("AVAILABLE"); // the fresh one

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stored",
      coverRenderId: "render-new",
    });

    expect(result).toEqual({
      status: "ok",
      externalId: "urn:li:share:1",
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
    expect(initializeImageUpload).toHaveBeenCalledTimes(1);
    expect(uploadImageBytes).toHaveBeenCalledTimes(1);
  });

  it("returns permanent when a fresh upload reports FAILED, without posting", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("FAILED");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result.status).toBe("permanent");
    expect(createPost).not.toHaveBeenCalled();
  });

  it("carries the urn as metadata when the post step itself fails retryably (5xx), so the retry won't re-upload", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");
    vi.mocked(createPost).mockRejectedValue(new LinkedinApiError(503, "down"));

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({
      status: "retryable",
      error: "down",
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
  });

  it("classifies a failed blob download as retryable and never touches the Images API", async () => {
    const { database } = dbStub();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result.status).toBe("retryable");
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("posts an empty altText rather than omitting media when the cover has no alt", async () => {
    // Uploaded covers carry `altText: ""` (spec §2). Dropping the image because
    // the alt is blank would silently downgrade the post to a link card.
    const { database } = dbStub();
    vi.mocked(loadCoverImagePayload).mockResolvedValue({ ...COVER, alt: "" });
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result.status).toBe("ok");
    expect(vi.mocked(createPost).mock.calls[0][0].media).toEqual({ imageUrn: "urn:li:image:new", altText: "" });
  });

  it("does not attach media when the cover row is not ready — the reader returned null", async () => {
    // The seam that enforces this is `loadCoverImagePayload` (Task 2); this
    // pins that the destination has no second opinion about it.
    const { database } = dbStub();
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1" });
    expect(vi.mocked(createPost).mock.calls[0][0].media).toBeUndefined();
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does NOT re-upload when a stored urn is still PROCESSING — it polls the stored one and gives up again", async () => {
    // The whole point of the metadata column: a sweep that runs while LinkedIn
    // is slow must not mint a second image on every tick.
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("PROCESSING");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stored",
      coverRenderId: "render-new",
    });

    expect(result).toEqual({
      status: "retryable",
      error: expect.stringMatching(/still processing/i),
      metadata: { linkedinImageUrn: "urn:li:image:stored", coverRenderId: "render-new" },
    });
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(uploadImageBytes).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("carries the urn when the POLL call itself throws a 5xx, so the retry reuses the upload", async () => {
    // `prepareCoverImage`'s catch runs `withImageUrn(result, imageUrn)`; this
    // is the case where `imageUrn` was assigned but the flow never reached a
    // terminal status. Without it the retry uploads a second image and the
    // first is orphaned on LinkedIn's side.
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockRejectedValue(new LinkedinApiError(503, "down"));

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({
      status: "retryable",
      error: "down",
      metadata: { linkedinImageUrn: "urn:li:image:new", coverRenderId: "render-new" },
    });
  });

  it("still short-circuits on an existing externalId before touching the cover (post-once guard)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release(), connection(), "urn:li:share:existing", database, null);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:existing" });
    expect(loadCoverImagePayload).not.toHaveBeenCalled();
  });
});
