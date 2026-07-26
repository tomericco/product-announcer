# LinkedIn Publishing — Design

**Date:** 2026-07-24
**Status:** Approved (pending implementation plan)

## 1. Goal & scope

Let users publish a release to a **LinkedIn company page (organization)** using LinkedIn's official API. The post body is AI-generated, human-editable, LinkedIn-native short-form copy stored per-release, with a link back to the tenant's changelog appended at delivery time. Delivery reuses the existing destinations/dispatch machinery.

**Company accounts only.** We post exclusively as an organization the authenticated user administers — never as a personal member. LinkedIn has no "log in as a page" concept: OAuth always authenticates a *person*, who then posts *on behalf of* an organization. Company-only is therefore enforced by three concrete guarantees, all verified in the plan's tests:

1. **Scope excludes personal posting.** We request `w_organization_social` (+ `r_organization_social`, `rw_organization_admin`) and deliberately **not** `w_member_social`. The issued token literally cannot create a member post.
2. **Author is always an organization URN.** Every `/rest/posts` call sets `author: urn:li:organization:{id}`. The destination asserts the stored author URN begins with `urn:li:organization:` before posting; anything else is a permanent config fault.
3. **Only administered pages are selectable.** The setup wizard lists only orgs returned by `organizationAcls` with role `ADMINISTRATOR` and state `APPROVED`, and the save action re-validates the submitted URN's `urn:li:organization:` prefix.

### External prerequisite (non-code)

Posting to an organization requires LinkedIn's **Community Management API** product, which LinkedIn grants only after app review, and each customer's page administrator must authorize our app against their page. This spec assumes that approval and the required OAuth scopes are in place. This is a launch prerequisite, documented here, not something the code can bypass.

## 2. Architecture fit

The app already has a destination-plugin system:

- Each destination implements `Destination<TConfig>` (`loadConfig` + `deliver`) in `src/lib/publishing/destinations/`, registered in `DESTINATIONS` (`src/lib/publishing/dispatch.ts`).
- `deliveryAttempts` (`src/db/schema.ts`) tracks per-release+destination status, attempt count, `lastError`, and an `externalId` for idempotent re-delivery. A cron sweep (`retryFailedDeliveries`) retries `failed` rows under the attempt cap.
- Per-tenant connection tables (e.g. `webflowConnections`) store encrypted OAuth credentials and a status enum.
- OAuth callbacks live under `src/app/api/...` and use a `state` param to carry the tenant id (see `src/app/api/github/setup/route.ts`).
- Secrets are encrypted with `encryptSecret` / `decryptSecret` (`src/lib/credentials/encryption.ts`).

LinkedIn slots in as **a new destination** plus **a new per-tenant connection table** plus **an OAuth callback route** — no changes to the dispatch/retry core beyond registering the destination and extending the destination enum.

## 3. Auth & connection

### `linkedinConnections` table (one row per tenant)

| Column | Notes |
| --- | --- |
| `id` | uuid pk |
| `tenantId` | uuid, unique, FK → tenants (cascade) |
| `accessTokenCiphertext/Iv/AuthTag` | encrypted access token |
| `refreshTokenCiphertext/Iv/AuthTag` | encrypted refresh token (nullable until first exchange) |
| `expiresAt` | access-token expiry timestamp |
| `organizationUrn` | e.g. `urn:li:organization:123` — null until the user picks a page |
| `organizationName` | display name of the selected page |
| `baseUrl` | tenant-configured changelog/release base URL for link-backs — null until set |
| `status` | enum `active` / `needs_reauth` / `misconfigured` (default `active`) |
| `lastValidatedAt` | timestamp |
| `createdAt` | timestamp |

### OAuth flow (`GET /api/linkedin/callback`)

1. Connect button → redirect to LinkedIn authorize URL with scopes `w_organization_social`, `r_organization_social`, `rw_organization_admin`, and `state = tenantId|returnTo`.
2. Callback validates `state` against the session tenant (reject on mismatch, matching the GitHub-setup route), exchanges `code` for access + refresh tokens, encrypts and stores them with `expiresAt`.
3. Redirect back to the integrations page. The connection row now exists but is not yet publish-ready (no org, no base URL).

### Organization selection

- A server action calls LinkedIn's `organizationAcls` endpoint (role = `ADMINISTRATOR`, state = `APPROVED`) to list pages the authenticated user administers, resolving each org's display name.
- User picks one → the save action validates the submitted URN starts with `urn:li:organization:` (rejects anything else) → store `organizationUrn` + `organizationName`.
- Only administered organizations are offered, and the prefix check backstops it — together these enforce "company accounts only" (guarantee 3 above).

### Base URL

Captured in the same setup wizard: the tenant enters their changelog/release base URL (e.g. `https://acme.com/changelog/`). Stored on the connection.

### Token lifecycle

- Access tokens expire (~60 days). Refresh proactively when `expiresAt` is near, and reactively on a 401, using the stored refresh token.
- On successful refresh, re-encrypt and persist the new token(s) + `expiresAt`.
- On refresh failure (revoked/expired refresh token) → set `status = needs_reauth` and surface a reconnect banner on the integrations page (mirrors Webflow's `recordNeedsReauth`). `needs_reauth` is treated as a `configFault` at delivery so the retry sweep stays eligible once the user reconnects.

## 4. Content generation & storage

### New columns on `releases`

- `linkedinBody` (text, nullable) — the stored, editable LinkedIn post copy.
- `linkedinBodyEditedAt` (timestamptz, nullable) — non-null marks a hand-edit, analogous to `bodyEditedAt`, so regeneration can warn before overwriting hand edits.

### Generation

- A server action generates the copy on demand (not eagerly) via the existing Anthropic integration (`@ai-sdk/anthropic`, called directly per the project's LLM-provider decision).
- Prompt turns the release title + body into LinkedIn-native copy: a hook opening line, a concise plain-text summary, no markdown syntax, target ≤ ~2,900 characters to leave room for the appended link within LinkedIn's ~3,000-char commentary limit.
- The tenant's existing brand/competitor-naming guardrails (already applied to release composition) apply to this generation.
- Usage is recorded in `llmUsage` with a distinct `operation` value (e.g. `linkedin_copy`).
- Regenerate replaces `linkedinBody`; if `linkedinBodyEditedAt` is set, the UI warns first.

### Link-back assembly

- The link is **not** baked into `linkedinBody`. It is assembled at delivery time as `baseUrl` + release `slug` (via `slugify(release.title)`), so editing/regenerating the copy can never drop the link, and changing the base URL doesn't require regenerating copy.

## 5. Delivery — `linkedin` destination

- Add `"linkedin"` to `destinationEnum` (`src/db/schema.ts`) and to `DestinationId`.
- New `linkedinDestination: Destination<LinkedinConnection>` in `src/lib/publishing/destinations/linkedin.ts`, registered in `DESTINATIONS`.
- New client module `src/lib/integrations/linkedin/client.ts` (authorize URL, token exchange, token refresh, `organizationAcls`, create post) with a typed `LinkedinApiError` carrying HTTP status, mirroring `WebflowApiError`.

### `loadConfig`

Returns the connection only if all of: `status = active`, `organizationUrn` set, `baseUrl` set. Otherwise the target renders as unconfigured in the publish modal (same gating as Webflow's `collectionId` requirement) and dispatch skips it. This same gate governs whether the drafts-UI LinkedIn panel renders (see §6).

### `deliver`

1. If `release.linkedinBody` is empty/whitespace → `permanent`, "Generate a LinkedIn post before publishing." (Empty body is worse than failing.)
2. **Post-once idempotency:** if `externalId` (the stored post URN) is already set → return `ok` without re-posting. LinkedIn re-posts would duplicate/spam, so re-publishing a release is a no-op for LinkedIn (unlike Webflow, which updates the item in place).
3. Decrypt the access token outside the network try-block (a decrypt failure is `permanent` + `configFault`, never misclassified as retryable — matches Webflow/webhook).
4. Refresh the token if near/at expiry.
5. Assert `organizationUrn` starts with `urn:li:organization:` (company-only guarantee 2) → else `permanent` + `configFault`.
6. `commentary = linkedinBody + "\n\n" + baseUrl + slug`.
7. `POST https://api.linkedin.com/rest/posts` with headers `Authorization: Bearer …`, `LinkedIn-Version: <YYYYMM>`, `X-Restli-Protocol-Version: 2.0.0`; body `{ author: organizationUrn, commentary, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED" }, lifecycleState: "PUBLISHED" }`.
8. On success, store the returned post URN as `externalId` (read from the `x-restli-id` response header).

### Error classification

- 401 / 403 → `permanent`, `configFault: true`, and mark the connection `needs_reauth`.
- 422 / 400 (validation) → `permanent` with the LinkedIn detail.
- 429 / 408 / 5xx / network → `retryable` (the cron sweep retries).
- Other → `permanent`.

## 6. UI surfaces

### Integrations page (`src/app/(dashboard)/integrations/`)

A "LinkedIn" card following the Webflow multi-step wizard pattern:

1. **Connect** → OAuth.
2. **Pick organization** → select from administered pages.
3. **Set changelog base URL**.
4. **Connected state** → shows org name + base URL, a `needs_reauth` banner when applicable, and a Disconnect action.

### Drafts UI (`src/app/(dashboard)/drafts/[releaseId]/`)

A "LinkedIn post" panel — **rendered only when the LinkedIn integration is configured** (connection `active` + org selected + base URL set; the same condition `loadConfig` uses). When not configured, the panel is absent entirely (no dangling "connect LinkedIn" prompt in the draft editor).

When shown, the panel provides:

- Generate / Regenerate button (regenerate warns if `linkedinBodyEditedAt` is set).
- Editable textarea bound to `linkedinBody` with a live character count against the LinkedIn limit.
- A read-only preview of the link that will be appended.
- Delivery status for the LinkedIn destination (posted / last error), sourced from `deliveryAttempts`.

LinkedIn appears as a selectable target in the existing publish flow like other destinations.

## 7. Testing

Following the existing destination + `tests/app/atomic-updates-actions.test.ts` style, with a mocked LinkedIn client:

- `deliver`: error classification (auth → permanent+configFault+needs_reauth; validation → permanent; 429/5xx/network → retryable), post-once short-circuit when `externalId` is set, empty-body guard, and correct `commentary`/link assembly.
- Token refresh: proactive-on-expiry and reactive-on-401 paths; refresh failure → `needs_reauth`.
- Org selection: `organizationAcls` filtering to `ADMINISTRATOR` + `APPROVED` only.
- `loadConfig` gating: null unless active + org + base URL.

## 8. Out of scope (v1)

Personal-profile posting; multiple organizations per tenant; **image/video/media attachments** (deferred — see §9); article-link attachments; scheduling to LinkedIn independently of release publish; editing an already-published LinkedIn post; engagement/analytics read-back.

## 9. Future phase — media attachments (researched, NOT built in v1)

Deferred by decision. Captured here so the API research isn't lost. When picked up, this becomes its own spec. Two hard prerequisites the current app lacks: (a) a place to store the binary (e.g. Vercel Blob) and a way for the user to attach it in the drafts panel; (b) an asset URN must be minted per publish, which turns the single-POST `deliver` into a multi-step, partly-async flow.

All calls use the same versioned headers as posting (`LinkedIn-Version: YYYYMM`, `X-Restli-Protocol-Version: 2.0.0`) and the org as asset `owner`; the member needs ADMIN/DSC rights on the page.

**Single image** (`/rest/images`):
1. `POST /rest/images?action=initializeUpload` body `{ "initializeUploadRequest": { "owner": "urn:li:organization:{id}" } }` → response `value.uploadUrl` + `value.image` (`urn:li:image:…`).
2. Upload the raw bytes to `uploadUrl` (binary, `Content-Type: application/octet-stream`).
3. Poll `GET /rest/images/{urn}` until `status: AVAILABLE` (usually fast).
4. `POST /rest/posts` with `content: { media: { altText, id: "urn:li:image:…" } }`.
   Formats: JPG/PNG/GIF (≤250 frames), < 36,152,320 px.

**Video** (`/rest/videos`) — significantly more involved:
1. `POST /rest/videos?action=initializeUpload` body `{ "initializeUploadRequest": { "owner", "fileSizeBytes", "uploadCaptions": false, "uploadThumbnail": false } }` → response `value.video` (`urn:li:video:…`), `value.uploadInstructions[]` (each with `uploadUrl` + `firstByte`/`lastByte`, 4 MB ranges), `value.uploadToken`.
2. Split the file into 4 MB parts; `PUT` each part to its `uploadUrl` (`application/octet-stream`); capture the **ETag** response header per part.
3. `POST /rest/videos?action=finalizeUpload` body `{ "finalizeUploadRequest": { "video", "uploadToken", "uploadedPartIds": [ETags…] } }`.
4. Poll `GET /rest/videos/{urn}` until `status: AVAILABLE` — this is **async and can take a while**, so it will not fit inside a single synchronous `deliver` attempt; a resumable/poll-across-attempts approach is needed.
5. `POST /rest/posts` with `content: { media: { id: "urn:li:video:…" } }`.
   MP4 only, 75 KB–500 MB, 3 s–30 min.

Permissions for both: `w_organization_social` (already requested) suffices for org-owned uploads by a page admin.
