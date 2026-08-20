import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  listAdminOrganizations,
  createPost,
  escapeLittleText,
  initializeImageUpload,
  uploadImageBytes,
  getImageStatus,
  LinkedinApiError,
} from "../../../src/lib/integrations/linkedin/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("linkedin client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("builds an authorize URL with org scopes and state", () => {
    const url = new URL(buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://a/cb", state: "t1|integrations" }));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://a/cb");
    expect(url.searchParams.get("state")).toBe("t1|integrations");
    expect(url.searchParams.get("scope")).toContain("w_organization_social");
  });

  it("exchanges a code for tokens", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 5184000 })
    );
    const tokens = await exchangeCode({ code: "c", clientId: "id", clientSecret: "s", redirectUri: "https://a/cb" });
    expect(tokens).toEqual({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 5184000 });
  });

  it("refreshes an access token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ access_token: "at2", expires_in: 100 }));
    const tokens = await refreshAccessToken({ refreshToken: "rt", clientId: "id", clientSecret: "s" });
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBeNull();
  });

  it("lists only ADMINISTRATOR/APPROVED organizations with resolved names", async () => {
    vi.mocked(fetch)
      // organizationAcls
      .mockResolvedValueOnce(
        jsonResponse({
          elements: [
            { role: "ADMINISTRATOR", state: "APPROVED", organization: "urn:li:organization:1" },
            { role: "ADMINISTRATOR", state: "REQUESTED", organization: "urn:li:organization:2" },
            { role: "VIEWER", state: "APPROVED", organization: "urn:li:organization:3" },
          ],
        })
      )
      // org 1 lookup
      .mockResolvedValueOnce(jsonResponse({ localizedName: "Acme Inc" }));
    const orgs = await listAdminOrganizations("at");
    expect(orgs).toEqual([{ urn: "urn:li:organization:1", name: "Acme Inc" }]);
  });

  it("creates a post and returns the post urn from x-restli-id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } })
    );
    const res = await createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" });
    expect(res.postUrn).toBe("urn:li:share:999");
  });

  it("throws LinkedinApiError on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "nope" }, 401));
    await expect(createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" }))
      .rejects.toMatchObject({ status: 401 });
  });

  describe("escapeLittleText", () => {
    it("escapes parentheses", () => {
      expect(escapeLittleText("We shipped (finally)")).toBe("We shipped \\(finally\\)");
    });

    it("escapes each reserved character with a backslash prefix", () => {
      expect(escapeLittleText("#tag @name *x* _y_ ~z~")).toBe("\\#tag \\@name \\*x\\* \\_y\\_ \\~z\\~");
    });

    it("returns a plain string with no reserved characters unchanged", () => {
      expect(escapeLittleText("just plain text, no special chars")).toBe("just plain text, no special chars");
    });

    it("escapes a lone backslash once, not twice", () => {
      expect(escapeLittleText("a\\b")).toBe("a\\\\b");
    });
  });

  it("sends escaped commentary in the outgoing createPost request body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:999" } }));
    await createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "Ship it (v2) #launch" });
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as { commentary: string };
    expect(body.commentary).toBe("Ship it \\(v2\\) \\#launch");
  });

  describe("images api", () => {
    it("initializeImageUpload posts the owner wrapper and returns uploadUrl + image urn", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ value: { uploadUrl: "https://media.example/upload/1", image: "urn:li:image:abc", uploadUrlExpiresAt: 1 } })
      );
      const res = await initializeImageUpload({ accessToken: "at", ownerUrn: "urn:li:organization:1" });
      expect(res).toEqual({ uploadUrl: "https://media.example/upload/1", imageUrn: "urn:li:image:abc" });
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe("https://api.linkedin.com/rest/images?action=initializeUpload");
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        initializeUploadRequest: { owner: "urn:li:organization:1" },
      });
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["LinkedIn-Version"]).toBeDefined();
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    });

    it("uploadImageBytes PUTs the bytes to the upload url as octet-stream with the bearer token", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 201 }));
      const bytes = new Uint8Array([137, 80, 78, 71]);
      await uploadImageBytes({ uploadUrl: "https://media.example/upload/1", bytes, accessToken: "at" });
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe("https://media.example/upload/1");
      expect((init as RequestInit).method).toBe("PUT");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer at");
      expect(headers["content-type"]).toBe("application/octet-stream");
      expect((init as RequestInit).body).toBe(bytes);
    });

    it("uploadImageBytes throws LinkedinApiError on a non-2xx", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
      await expect(
        uploadImageBytes({ uploadUrl: "https://media.example/upload/1", bytes: new Uint8Array(), accessToken: "at" })
      ).rejects.toMatchObject({ status: 500 });
    });

    it("getImageStatus GETs the url-encoded urn and maps the status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "urn:li:image:abc", status: "AVAILABLE" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("AVAILABLE");
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3Aabc");

      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ status: "FAILED" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("FAILED");

      // WAITING_UPLOAD / PROCESSING / anything unknown → still processing.
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ status: "WAITING_UPLOAD" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("PROCESSING");
    });
  });

  it("createPost with media sends content.media { id, altText } and keeps the commentary", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }));
    const res = await createPost({
      accessToken: "at",
      authorUrn: "urn:li:organization:1",
      commentary: "Look",
      media: { imageUrn: "urn:li:image:abc", altText: "Lighthouse over a grid" },
    });
    expect(res.postUrn).toBe("urn:li:share:7");
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toEqual({ media: { id: "urn:li:image:abc", altText: "Lighthouse over a grid" } });
    expect(body.commentary).toBe("Look");
  });

  it("createPost without media sends no content key (text + link post exactly as before)", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:8" } }));
    await createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" });
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("content");
  });
});
