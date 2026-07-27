import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  listDatabases,
  getDatabaseProperties,
  getPage,
  getPageBodyText,
  resolveDataSourceId,
  listDoneTasks,
  NotionApiError,
} from "../../../../src/lib/integrations/notion/client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("notion client", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("lists databases via search with a bearer token and version header", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ results: [{ id: "db1", title: [{ plain_text: "Tasks" }] }] })
    );
    const dbs = await listDatabases("tok");
    expect(dbs).toEqual([{ id: "db1", title: "Tasks" }]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/search");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(init?.body as string)).toMatchObject({ filter: { value: "database", property: "object" } });
  });

  it("returns only status/select properties from a database schema", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        properties: {
          Status: { id: "s1", type: "status", status: { options: [{ id: "o1", name: "Done" }] } },
          Priority: { id: "p1", type: "select", select: { options: [{ id: "o2", name: "High" }] } },
          Name: { id: "t1", type: "title", title: {} },
        },
      })
    );
    const props = await getDatabaseProperties("tok", "db1");
    expect(props).toEqual([
      { id: "s1", name: "Status", type: "status", options: [{ id: "o1", name: "Done" }] },
      { id: "p1", name: "Priority", type: "select", options: [{ id: "o2", name: "High" }] },
    ]);
  });

  it("reads a page's title, description text and status keyed by property id", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        url: "https://notion.so/page-123",
        properties: {
          Name: { id: "t1", type: "title", title: [{ plain_text: "Add dark mode" }] },
          Notes: { id: "n1", type: "rich_text", rich_text: [{ plain_text: "Toggle in settings." }] },
          Status: { id: "s1", type: "status", status: { name: "Done" } },
        },
      })
    );
    const page = await getPage("tok", "page-123");
    expect(page.url).toBe("https://notion.so/page-123");
    expect(page.title).toBe("Add dark mode");
    expect(page.description).toContain("Toggle in settings.");
    expect(page.statusByPropertyId["s1"]).toBe("Done");
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.notion.com/v1/pages/page-123");
  });

  it("throws NotionApiError carrying the status on a non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ message: "unauthorized" }, 401));
    await expect(getPage("tok", "p")).rejects.toMatchObject({ status: 401 });
    await expect(getPage("tok", "p")).rejects.toBeInstanceOf(NotionApiError);
  });

  it("reads the page body text from its blocks (bearer + version + endpoint)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        results: [
          { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Summary" }] } },
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Users can now export." }] } },
          { type: "divider", divider: {} },
        ],
        has_more: false,
      })
    );
    const text = await getPageBodyText("tok", "page-1");
    expect(text).toBe("Summary\nUsers can now export.");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/v1/blocks/page-1/children");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Notion-Version"]).toBe("2022-06-28");
  });

  it("follows pagination when the page body has more blocks", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "one" }] } }],
          has_more: true,
          next_cursor: "cur-2",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "two" }] } }],
          has_more: false,
        })
      );
    expect(await getPageBodyText("tok", "page-1")).toBe("one\ntwo");
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
    expect(String(vi.mocked(fetch).mock.calls[1][0])).toContain("start_cursor=cur-2");
  });

  it("resolves the data source id from a database (2025-09-03)", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data_sources: [{ id: "ds-1", name: "Tasks" }] }));
    const id = await resolveDataSourceId("tok", "db-1");
    expect(id).toBe("ds-1");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/databases/db-1");
    expect((init?.headers as Record<string, string>)["Notion-Version"]).toBe("2025-09-03");
  });

  it("throws NotionApiError when a database has no data sources", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ data_sources: [] }));
    await expect(resolveDataSourceId("tok", "db-1")).rejects.toBeInstanceOf(NotionApiError);
  });

  it("lists Done tasks via the data-source query, filtered by doneValues", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        results: [
          {
            id: "page-1",
            url: "https://notion.so/page-1",
            last_edited_time: "2026-07-25T18:03:00.000Z",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Fix SSO 502" }] },
              Status: { type: "status", status: { name: "Done" } },
            },
          },
        ],
      })
    );
    const tasks = await listDoneTasks("tok", "ds-1", "Status", ["Done", "Shipped"]);
    expect(tasks).toEqual([
      {
        pageId: "page-1",
        title: "Fix SSO 502",
        url: "https://notion.so/page-1",
        status: "Done",
        lastEditedTime: "2026-07-25T18:03:00.000Z",
      },
    ]);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
    expect((init?.headers as Record<string, string>)["Notion-Version"]).toBe("2025-09-03");
    const body = JSON.parse(init?.body as string);
    expect(body.filter).toEqual({
      or: [
        { property: "Status", status: { equals: "Done" } },
        { property: "Status", status: { equals: "Shipped" } },
      ],
    });
    expect(body.sorts).toEqual([{ timestamp: "last_edited_time", direction: "descending" }]);
  });

  it("returns [] for empty doneValues without calling fetch", async () => {
    expect(await listDoneTasks("tok", "ds-1", "Status", [])).toEqual([]);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
