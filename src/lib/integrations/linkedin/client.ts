const OAUTH_BASE = "https://www.linkedin.com/oauth/v2";
const API_BASE = "https://api.linkedin.com";
const REQUEST_TIMEOUT_MS = 10_000;
// Deliberately NOT w_member_social: this token must never be able to post as
// a person, only on behalf of organizations the member administers.
const SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"];

export type LinkedinTokens = { accessToken: string; refreshToken: string | null; expiresInSeconds: number };
export type LinkedinOrg = { urn: string; name: string };

export class LinkedinApiError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details: string[] = []) {
    super(message);
    this.name = "LinkedinApiError";
    this.status = status;
    this.details = details;
  }
}

function apiVersion(): string {
  return process.env.LINKEDIN_API_VERSION ?? "202506";
}

export function buildAuthorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL(`${OAUTH_BASE}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("scope", SCOPES.join(" "));
  return url.toString();
}

async function tokenRequest(path: string, body: URLSearchParams): Promise<LinkedinTokens> {
  let response: Response;
  try {
    response = await fetch(`${OAUTH_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // Deliberately a plain Error, NOT a LinkedinApiError. A later task
      // classifies failures by `instanceof LinkedinApiError` + status code,
      // treating any other error type as retryable by default. A timeout
      // must be retried, so giving it a synthetic status here would misroute
      // it into the permanent-failure branch. Do not "fix" this into a
      // LinkedinApiError.
      throw new Error(`LinkedIn POST ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    // Any other fetch rejection (DNS failure, connection reset, etc.) keeps
    // its own message and, like the timeout above, stays a plain Error so it
    // also classifies as retryable.
    throw error;
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error_description?: string; message?: string };
    throw new LinkedinApiError(response.status, detail.error_description ?? detail.message ?? `HTTP ${response.status}`);
  }
  const data = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresInSeconds: data.expires_in };
}

export function exchangeCode(args: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<LinkedinTokens> {
  return tokenRequest(
    "/accessToken",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: args.code,
      client_id: args.clientId,
      client_secret: args.clientSecret,
      redirect_uri: args.redirectUri,
    })
  );
}

export function refreshAccessToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinkedinTokens> {
  return tokenRequest(
    "/accessToken",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
      client_secret: args.clientSecret,
    })
  );
}

async function restRequest(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": apiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // Deliberately a plain Error, NOT a LinkedinApiError — see tokenRequest
      // above for why timeouts must stay retryable.
      throw new Error(`LinkedIn ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    throw new LinkedinApiError(response.status, detail.message ?? `HTTP ${response.status}`);
  }
  return response;
}

export async function listAdminOrganizations(accessToken: string): Promise<LinkedinOrg[]> {
  const response = await restRequest(
    accessToken,
    "/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED"
  );
  const data = (await response.json()) as {
    elements?: { role: string; state: string; organization: string }[];
  };
  const urns = (data.elements ?? [])
    .filter((e) => e.role === "ADMINISTRATOR" && e.state === "APPROVED")
    .map((e) => e.organization);

  const orgs: LinkedinOrg[] = [];
  for (const urn of urns) {
    const id = urn.split(":").pop();
    const lookup = await restRequest(accessToken, `/rest/organizations/${id}`);
    const org = (await lookup.json()) as { localizedName?: string };
    orgs.push({ urn, name: org.localizedName ?? urn });
  }
  return orgs;
}

export async function createPost(args: {
  accessToken: string;
  authorUrn: string;
  commentary: string;
}): Promise<{ postUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/posts", {
    method: "POST",
    body: JSON.stringify({
      author: args.authorUrn,
      commentary: args.commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  const postUrn = response.headers.get("x-restli-id") ?? "";
  return { postUrn };
}
