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

// ---- Images API (native image posts, spec §8) -------------------------------
// Three-step upload: initialize (get an upload URL + image URN), PUT the bytes,
// then poll the URN until LinkedIn has processed it. The URN is what a post
// references. Same versioned-REST headers and same w_organization_social scope
// as createPost — no re-auth.

export type LinkedinImageStatus = "PROCESSING" | "AVAILABLE" | "FAILED";

export async function initializeImageUpload(args: {
  accessToken: string;
  ownerUrn: string;
}): Promise<{ uploadUrl: string; imageUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/images?action=initializeUpload", {
    method: "POST",
    body: JSON.stringify({ initializeUploadRequest: { owner: args.ownerUrn } }),
  });
  const data = (await response.json()) as { value?: { uploadUrl?: string; image?: string } };
  if (!data.value?.uploadUrl || !data.value.image) {
    throw new LinkedinApiError(response.status, "LinkedIn initializeUpload returned no uploadUrl/image.");
  }
  return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
}

// The upload URL is an absolute LinkedIn media-host URL, not an api.linkedin.com
// path, so it does not go through restRequest. Same bearer token; raw bytes.
// Timeouts stay plain Errors (retryable) for the same reason as restRequest.
export async function uploadImageBytes(args: { uploadUrl: string; bytes: Uint8Array; accessToken: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(args.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/octet-stream" },
      // Cast needed because the bare `Uint8Array` param type (as required by
      // the exported interface) widens to Uint8Array<ArrayBufferLike>, which
      // lib.dom.d.ts's BufferSource narrows to Uint8Array<ArrayBuffer> only.
      // Runtime behavior is unaffected — fetch accepts any Uint8Array as body.
      body: args.bytes as BodyInit,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`LinkedIn image upload timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new LinkedinApiError(response.status, `LinkedIn image upload failed: HTTP ${response.status}`);
  }
}

export async function getImageStatus(args: { accessToken: string; imageUrn: string }): Promise<LinkedinImageStatus> {
  const response = await restRequest(args.accessToken, `/rest/images/${encodeURIComponent(args.imageUrn)}`);
  const data = (await response.json()) as { status?: string };
  if (data.status === "AVAILABLE") return "AVAILABLE";
  if (data.status === "FAILED") return "FAILED";
  // PROCESSING, WAITING_UPLOAD, or anything LinkedIn adds later: not ready yet.
  return "PROCESSING";
}

// LinkedIn Posts API "commentary" is little-text format: these characters must
// be backslash-escaped to render literally, else the post 422s or misrenders.
// Backslash MUST be escaped first so we don't re-escape escapes we just added.
const LITTLE_TEXT_RESERVED = /[\\|{}@\[\]()<>#*_~]/g;
export function escapeLittleText(text: string): string {
  return text.replace(LITTLE_TEXT_RESERVED, (ch) => `\\${ch}`);
}

export async function createPost(args: {
  accessToken: string;
  authorUrn: string;
  commentary: string;
  // When set, the post carries this image natively (Posts API `content.media`)
  // — a larger card than a link preview, shown instead of the link's og:image.
  // The URN comes from initializeImageUpload + uploadImageBytes and must be
  // AVAILABLE (getImageStatus) before posting.
  media?: { imageUrn: string; altText: string };
}): Promise<{ postUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/posts", {
    method: "POST",
    body: JSON.stringify({
      author: args.authorUrn,
      commentary: escapeLittleText(args.commentary),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(args.media ? { content: { media: { id: args.media.imageUrn, altText: args.media.altText } } } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  const postUrn = response.headers.get("x-restli-id") ?? "";
  return { postUrn };
}
