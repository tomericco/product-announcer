const BASE_URL = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const REQUEST_TIMEOUT_MS = 10_000;

export type NotionDatabase = { id: string; title: string };
export type NotionPropertyOption = { id: string; name: string };
export type NotionProperty = { id: string; name: string; type: string; options: NotionPropertyOption[] };
export type NotionPageContent = {
  url: string;
  title: string;
  description: string;
  statusByPropertyId: Record<string, string>;
};

export class NotionApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "Notion-Version": NOTION_VERSION,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // Plain Error, NOT NotionApiError: a timeout is not a 401 and must not be
      // misrouted into needs_reauth handling.
      throw new Error(`Notion ${init.method ?? "GET"} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new NotionApiError(response.status, body.message ?? `Notion returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function plainText(rich: { plain_text?: string }[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? "").join("");
}

export async function listDatabases(token: string): Promise<NotionDatabase[]> {
  const data = await request<{ results: { id: string; title?: { plain_text?: string }[] }[] }>(
    token,
    "/v1/search",
    { method: "POST", body: JSON.stringify({ filter: { value: "database", property: "object" }, page_size: 100 }) }
  );
  return data.results.map((r) => ({ id: r.id, title: plainText(r.title) || "Untitled" }));
}

type RawProperty = {
  id: string;
  type: string;
  status?: { options?: NotionPropertyOption[]; name?: string };
  select?: { options?: NotionPropertyOption[]; name?: string };
  title?: { plain_text?: string }[];
  rich_text?: { plain_text?: string }[];
};

export async function getDatabaseProperties(token: string, databaseId: string): Promise<NotionProperty[]> {
  const data = await request<{ properties: Record<string, RawProperty> }>(token, `/v1/databases/${databaseId}`);
  const out: NotionProperty[] = [];
  for (const [name, prop] of Object.entries(data.properties)) {
    if (prop.type === "status" || prop.type === "select") {
      const options = (prop.type === "status" ? prop.status?.options : prop.select?.options) ?? [];
      out.push({ id: prop.id, name, type: prop.type, options });
    }
  }
  return out;
}

export async function getPage(token: string, pageId: string): Promise<NotionPageContent> {
  const data = await request<{ url: string; properties: Record<string, RawProperty> }>(token, `/v1/pages/${pageId}`);
  let title = "";
  const descriptionParts: string[] = [];
  const statusByPropertyId: Record<string, string> = {};

  for (const prop of Object.values(data.properties)) {
    if (prop.type === "title") {
      title = plainText(prop.title);
    } else if (prop.type === "rich_text") {
      // "Ingesting page content" is out of scope; the description is assembled
      // from the task's own text properties only (an underspecified point in
      // the spec — resolved here as: rich_text property values, joined).
      const text = plainText(prop.rich_text);
      if (text) descriptionParts.push(text);
    } else if (prop.type === "status" && prop.status?.name) {
      statusByPropertyId[prop.id] = prop.status.name;
    } else if (prop.type === "select" && prop.select?.name) {
      statusByPropertyId[prop.id] = prop.select.name;
    }
  }

  return { url: data.url, title, description: descriptionParts.join("\n"), statusByPropertyId };
}
