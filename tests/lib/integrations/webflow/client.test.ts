import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listSites,
  listCollections,
  getCollection,
  createItem,
  WebflowApiError,
} from "../../../../src/lib/integrations/webflow/client";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("webflow client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("lists sites with a bearer token", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ sites: [{ id: "s1", displayName: "Acme" }] }));
    const sites = await listSites("tok");
    expect(sites).toEqual([{ id: "s1", displayName: "Acme" }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.webflow.com/v2/sites");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("lists collections for a site", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ collections: [{ id: "c1", displayName: "Blog", slug: "blog" }] })
    );
    const collections = await listCollections("tok", "s1");
    expect(collections[0].id).toBe("c1");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/sites/s1/collections");
  });

  it("returns the collection field schema", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        id: "c1",
        displayName: "Blog",
        slug: "blog",
        fields: [
          { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
          { id: "f2", slug: "post-body", displayName: "Body", type: "RichText", isRequired: false },
        ],
      })
    );
    const collection = await getCollection("tok", "c1");
    expect(collection.fields).toHaveLength(2);
    expect(collection.fields[0].isRequired).toBe(true);
  });

  it("posts to the staged endpoint when live is false", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: "item1" }, { status: 202 }));
    const result = await createItem("tok", "c1", { isDraft: true, fieldData: { name: "T", slug: "t" } }, false);
    expect(result.id).toBe("item1");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1/items");
  });

  it("posts to the live endpoint when live is true", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ id: "item1" }, { status: 202 }));
    await createItem("tok", "c1", { isDraft: false, fieldData: { name: "T", slug: "t" } }, true);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1/items/live");
  });

  it("throws WebflowApiError with validation details on 400", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(
        {
          message: "Validation Error",
          code: "validation_error",
          details: [{ param: "slug", description: "Unique value is already in database: 'my-slug'" }],
        },
        { status: 400 }
      )
    );
    await expect(createItem("tok", "c1", { isDraft: true, fieldData: {} }, false)).rejects.toMatchObject({
      status: 400,
      validationDetails: ["Unique value is already in database: 'my-slug'"],
    });
  });

  it("surfaces Retry-After on 429", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "Too Many Requests" }, { status: 429, headers: { "retry-after": "60" } })
    );
    const error = await listSites("tok").catch((e) => e as WebflowApiError);
    expect(error).toBeInstanceOf(WebflowApiError);
    expect((error as WebflowApiError).retryAfterMs).toBe(60_000);
  });

  it("throws on 401", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "Unauthorized" }, { status: 401 }));
    await expect(listSites("bad")).rejects.toMatchObject({ status: 401 });
  });
});
