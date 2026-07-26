const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 10_000;

export type NotionTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  workspaceId: string;
  botId: string | null;
};

export class NotionOAuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionOAuthError";
    this.status = status;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", required("NOTION_CLIENT_ID"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", required("NOTION_OAUTH_REDIRECT_URI"));
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<NotionTokenResponse> {
  const basic = Buffer.from(`${required("NOTION_CLIENT_ID")}:${required("NOTION_CLIENT_SECRET")}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
    throw new NotionOAuthError(
      response.status,
      detail.error_description ?? detail.error ?? `Notion token endpoint returned HTTP ${response.status}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string | null;
    workspace_id: string;
    bot_id?: string | null;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    workspaceId: data.workspace_id,
    botId: data.bot_id ?? null,
  };
}

export function exchangeCode(code: string): Promise<NotionTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: required("NOTION_OAUTH_REDIRECT_URI"),
  });
}

export function refreshAccessToken(refreshToken: string): Promise<NotionTokenResponse> {
  return postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}
