const BASE_URL = "https://api.webflow.com";
const REQUEST_TIMEOUT_MS = 10_000;

export type WebflowField = {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
};

export type WebflowSite = { id: string; displayName: string };
export type WebflowCollection = { id: string; displayName: string; slug: string };
export type WebflowCollectionDetail = WebflowCollection & { fields: WebflowField[] };

export type WebflowItemBody = {
  isDraft: boolean;
  isArchived?: boolean;
  fieldData: Record<string, unknown>;
};

export class WebflowApiError extends Error {
  status: number;
  validationDetails: string[];
  retryAfterMs?: number;

  constructor(status: number, message: string, validationDetails: string[] = [], retryAfterMs?: number) {
    super(message);
    this.name = "WebflowApiError";
    this.status = status;
    this.validationDetails = validationDetails;
    this.retryAfterMs = retryAfterMs;
  }
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Webflow returns {message, code, details:[{param, description}]}; a body
    // that fails to parse must not mask the status code.
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      details?: { param?: string; description?: string }[];
    };
    const retryAfter = response.headers.get("retry-after");
    throw new WebflowApiError(
      response.status,
      body.message ?? `Webflow returned HTTP ${response.status}`,
      (body.details ?? []).map((d) => d.description ?? "").filter(Boolean),
      retryAfter ? Number(retryAfter) * 1000 : undefined
    );
  }

  return (await response.json()) as T;
}

export async function listSites(token: string): Promise<WebflowSite[]> {
  const data = await request<{ sites: WebflowSite[] }>(token, "/v2/sites");
  return data.sites;
}

export async function listCollections(token: string, siteId: string): Promise<WebflowCollection[]> {
  const data = await request<{ collections: WebflowCollection[] }>(token, `/v2/sites/${siteId}/collections`);
  return data.collections;
}

export async function getCollection(token: string, collectionId: string): Promise<WebflowCollectionDetail> {
  return request<WebflowCollectionDetail>(token, `/v2/collections/${collectionId}`);
}

// `live: true` writes staging AND publishes that single item. It does NOT
// publish the site, so the customer's unrelated staged changes stay staged.
export async function createItem(
  token: string,
  collectionId: string,
  body: WebflowItemBody,
  live: boolean
): Promise<{ id: string }> {
  const suffix = live ? "/live" : "";
  return request<{ id: string }>(token, `/v2/collections/${collectionId}/items${suffix}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function updateItem(
  token: string,
  collectionId: string,
  itemId: string,
  body: WebflowItemBody,
  live: boolean
): Promise<{ id: string }> {
  const suffix = live ? "/live" : "";
  return request<{ id: string }>(token, `/v2/collections/${collectionId}/items/${itemId}${suffix}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}
