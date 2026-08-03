import { describe, it, expect, vi, beforeEach } from "vitest";
import { linkedinDestination } from "../../../src/lib/publishing/destinations/linkedin";
import type { ContentPiece, DbClient } from "../../../src/lib/publishing/destinations/types";

vi.mock("../../../src/lib/integrations/linkedin/token", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return { ...actual, createPost: vi.fn() };
});
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";
import { createPost, LinkedinApiError } from "../../../src/lib/integrations/linkedin/client";

const release = (over: Partial<ContentPiece> = {}): ContentPiece =>
  ({ id: "r1", tenantId: "t1", title: "New Dashboard", body: "b", linkedinBody: "Hook.\n\nDetails.", ...over } as ContentPiece);

const connection = (over: Record<string, unknown> = {}) =>
  ({ id: "c1", status: "active", organizationUrn: "urn:li:organization:1", baseUrl: "https://acme.com/changelog/", ...over } as never);

// A DbClient stub that records update().set() payloads.
function dbStub() {
  const sets: Record<string, unknown>[] = [];
  const database = {
    update: () => ({ set: (v: Record<string, unknown>) => { sets.push(v); return { where: () => Promise.resolve() }; } }),
  } as unknown as DbClient;
  return { database, sets };
}

describe("linkedin destination", () => {
  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
  });

  it("is a no-op success when already posted (externalId set)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release(), connection(), "urn:li:share:existing", database);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:existing" });
    expect(createPost).not.toHaveBeenCalled();
  });

  it("permanently fails when linkedinBody is empty", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release({ linkedinBody: "  " }), connection(), null, database);
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
