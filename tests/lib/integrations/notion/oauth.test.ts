import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  NotionOAuthError,
} from "../../../../src/lib/integrations/notion/oauth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("notion oauth", () => {
  beforeEach(() => {
    process.env.NOTION_CLIENT_ID = "cid";
    process.env.NOTION_CLIENT_SECRET = "csecret";
    process.env.NOTION_OAUTH_REDIRECT_URI = "https://app.example.com/api/notion/callback";
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds an authorize URL with client id, redirect, response_type and state", () => {
    const url = new URL(buildAuthorizeUrl("tenant-1|integrations"));
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/notion/callback");
    expect(url.searchParams.get("state")).toBe("tenant-1|integrations");
  });

  it("exchanges a code with HTTP Basic auth and maps the response", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        access_token: "at",
        refresh_token: "rt",
        workspace_id: "ws",
        bot_id: "bot",
      })
    );
    const result = await exchangeCode("the-code");
    expect(result).toEqual({ accessToken: "at", refreshToken: "rt", workspaceId: "ws", botId: "bot" });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/oauth/token");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: "https://app.example.com/api/notion/callback",
    });
  });

  it("maps a missing refresh_token to null", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at", workspace_id: "ws", bot_id: "bot" })
    );
    const result = await exchangeCode("c");
    expect(result.refreshToken).toBeNull();
  });

  it("refreshes with grant_type refresh_token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ access_token: "at2", refresh_token: "rt2", workspace_id: "ws", bot_id: "bot" })
    );
    const result = await refreshAccessToken("old-rt");
    expect(result.accessToken).toBe("at2");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-rt",
    });
  });

  it("throws NotionOAuthError with the status on a non-OK response", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400));
    await expect(exchangeCode("bad")).rejects.toMatchObject({ status: 400 });
    await expect(exchangeCode("bad")).rejects.toBeInstanceOf(NotionOAuthError);
  });
});
