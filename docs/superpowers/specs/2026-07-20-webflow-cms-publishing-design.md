# Webflow CMS Publishing

Let workspaces publish an approved update directly into their Webflow CMS as a
collection item.

Webflow is currently an inert `COMING_SOON` badge on the integrations page. This
spec makes it real, and in doing so introduces the destination abstraction and
the encrypted-credential storage that the codebase does not yet have.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Auth, v1 | Site Token pasted by the user | A registered Webflow app is installable only by users in our own Workspace until it passes Marketplace review. Site tokens unblock customers now. |
| Auth, later | OAuth, after Marketplace listing | Same API surface. An `authType` column absorbs the change. |
| Field mapping | User-configured, heuristic pre-fill | Customer collections are arbitrary. Required fields we cannot guess would otherwise produce an unactionable 400 at publish time. |
| Publish behavior | Per-workspace setting, default `draft` | Conservative default for a production marketing site, one toggle to full automation. |
| Going live | Per-item endpoints only | `POST /v2/sites/{id}/publish` ships the customer's unrelated staged Designer changes. We never call it. |
| Re-publish | Update the existing item | A corrected announcement should not appear twice on the customer's site. |
| Code blocks | Convert to formatted text, warn | Webflow silently turns them into empty strings. |

## Webflow API facts this design depends on

Verified against `developers.webflow.com` (Data API v2), 2026-07-20.

- **No refresh token.** The OAuth token response contains none, and
  `access_type=offline` is a no-op. Both auth types are therefore "opaque
  long-lived token; 401 means the connection is dead". Do not build a refresh
  loop.
- **Staged vs live is orthogonal to `isDraft`.** `POST /items` defaults
  `isDraft: true`; `POST /items/live` defaults `isDraft: false`. An item is
  visible only when `isDraft: false`, `isArchived: false`, and published.
- **Per-item publishing does not require a site publish.** `/items/live` and
  `POST /items/publish` affect only the named items. The "publish the whole
  site" requirement applies to collection *structure* changes, not item content.
- **Rich Text takes an HTML string** and sanitizes to what the Rich Text element
  supports. Unsupported tags vanish silently. Code blocks yield an empty string.
  External `<img>` URLs are not rehosted and arrive without Webflow's
  `w-richtext-figure` wrapper, so they render unstyled.
- **Slugs are required and unique per collection.** No API-side auto-generation.
  A deleted item's slug stays reserved until the site republishes, so
  check-then-insert is not safe — retry on the collision error instead.
- **Rate limits:** 60 req/min on Starter/Basic site plans, 120 on
  CMS/Business/eCommerce, per token. `X-RateLimit-Remaining` on every response,
  `Retry-After` on 429.

Scopes for the eventual OAuth app: `sites:read`, `cms:read`, `cms:write`.
(`sites:write` is deliberately not requested — we never publish a site.)

## Architecture

### Destination abstraction

`dispatchWebhookForUpdate(updateId, db)` is today called from three places:
`approveDraft` and `publishDraft` in `src/app/(dashboard)/drafts/actions.ts`,
`src/lib/scheduling/run-schedule.ts`, and the retry sweep in
`src/app/api/cron/scheduler/route.ts`.

Introduce `src/lib/publishing/destinations/`:

```ts
type DeliveryResult =
  | { status: "ok"; externalId?: string }
  | { status: "retryable"; error: string; retryAfterMs?: number }
  | { status: "permanent"; error: string };

interface Destination<TConfig> {
  id: "webhook" | "webflow";
  loadConfig(tenantId: string, db: Db): Promise<TConfig | null>;
  deliver(update: Update, config: TConfig): Promise<DeliveryResult>;
}
```

- `destinations/webhook.ts` — existing logic moved verbatim.
- `destinations/webflow.ts` — new.
- `dispatchAllDestinations(updateId, db)` replaces the three call sites and fans
  out over whichever destinations the tenant has configured.

Two invariants carried over from the current implementation:

1. **Delivery never throws into the publish path.** Publishing an update must
   not fail because a destination is down. Errors are recorded, not raised.
2. **No queue.** Retries stay in the existing hourly Vercel cron sweep.

`webhook_deliveries` generalizes to `delivery_attempts` with a `destination`
column so one sweep serves both. `MAX_ATTEMPTS = 3` is unchanged.

### Credentials

Nothing in the repo encrypts a secret today. New `src/lib/credentials/` module,
AES-256-GCM via Node's built-in `crypto`, keyed by `CREDENTIALS_ENCRYPTION_KEY`.
No new dependency. It is the only module that touches ciphertext.

`webhook_configs.secret` migrates to the same storage in this change — same
module, same migration. The integrations form stops rendering it back as
`type="text"`; it becomes write-only with a "replace secret" affordance.

### Schema

```
webflow_connections
  tenantId          uuid  unique, fk tenants, cascade
  authType          enum  site_token | oauth
  encryptedToken    text
  tokenIv           text
  tokenAuthTag      text
  siteId            text
  siteName          text
  collectionId      text
  fieldMapping      jsonb
  publishMode       enum  draft | live   default draft
  status            enum  active | needs_reauth | misconfigured
  lastValidatedAt   timestamptz
```

`fieldMapping` shape — keyed by Webflow field *slug*, not ID, so a renamed
display name does not break the mapping:

```jsonc
{
  "name":      { "source": "title" },
  "post-body": { "source": "body" },
  "slug":      { "source": "slug" },
  "published": { "source": "publishedAt" },
  "author":    { "source": "static", "value": "65f1..." },
  "category":  { "source": "empty" }
}
```

`updates` gains `webflowItemId text` so a re-publish PATCHes rather than
duplicates.

`webhook_configs.tenantId` keeps its `.unique()` constraint. Webflow gets its own
table rather than a polymorphic config blob so mapping columns stay typed.

## Connect and mapping flow

Four steps on the integrations page, each persisted so the user can resume.

1. **Paste token.** Validated immediately with `GET /v2/sites`. A bad token
   discovered at publish time is a far worse failure than one caught on save.
2. **Pick a site** from that response.
3. **Pick a collection** — `GET /v2/sites/{siteId}/collections`.
4. **Map fields** — `GET /v2/collections/{collectionId}` returns `fields[]` with
   `slug`, `type`, `isRequired`. One row per Webflow field, each with a dropdown
   selecting a source: update title, update body, published date, slug, static
   value, or leave empty.

Heuristics pre-select `name` → title and the first `RichText` field → body. The
user confirms or changes them.

**Gate: every `isRequired` field must have a non-`empty` mapping before the
config saves.** This is what prevents the unactionable 400 at publish time.
Static value covers required fields we have no source for — an author reference,
a category option.

On revisiting settings we re-fetch the schema and flag any mapped field that no
longer exists, setting `status = misconfigured`.

Field type handling on write: `PlainText` and `RichText` take strings, `DateTime`
ISO-8601, `Option` the option ID string, `Reference` an item ID,
`MultiReference` an array. Static values for `Option` and `Reference` are chosen
from a dropdown populated by the schema, never free text.

## Content conversion

New `src/lib/publishing/markdown-to-html.ts`. Target only the tags Webflow
retains: `h1`–`h6`, `p`, `strong`, `em`, `u`, `s`, `a`, `ul`/`ol`/`li`,
`blockquote`, `br`, `img`.

- **Code blocks** are converted to paragraph text with line breaks preserved,
  rather than emitted as `<pre>` (which Webflow blanks). The draft page shows a
  warning when a body contains fenced code and Webflow is a configured
  destination, so the approximation is never a surprise.
- **Images** pass through as external URLs in v1. They will render unstyled
  because Webflow does not add its figure wrapper. Assets API upload is a
  follow-up.
- **Empty body.** `resolveBody` in `src/app/(dashboard)/drafts/actions.ts:28`
  exists because MDXEditor can submit a blank body on a parse failure. The
  Webflow path inherits that risk: an empty body is a `permanent` failure with a
  clear message, never a blank CMS item.

**Slugs.** Slugify the title — lowercase, non-alphanumerics to `-`, collapse
repeats, trim, cap length. On the collision response
(`400`, `details[].param === "slug"`), append `-2`, `-3`, up to 5 attempts.
Retry-on-collision rather than check-then-insert, because a deleted item's slug
remains reserved until the site republishes.

## Publishing

| `publishMode` | Endpoint | Body |
| --- | --- | --- |
| `draft` | `POST /v2/collections/{id}/items` | `isDraft: true` |
| `live` | `POST /v2/collections/{id}/items/live` | `isDraft: false` |

Re-publish, when `updates.webflowItemId` is set: `PATCH` the corresponding
staged or `/live` item path. A `404` means the customer deleted it in Webflow —
clear `webflowItemId` and fall back to create.

`POST /v2/sites/{id}/publish` is never called.

### Error mapping

| Response | Disposition | Side effect |
| --- | --- | --- |
| `401` | `permanent` | `status = needs_reauth`, surfaced on the integrations page |
| `400 validation_error` | `permanent` | `details[].description` shown verbatim to the user |
| `400` slug collision | retry inline (see above) | — |
| `404` on re-publish | fall back to create | clear `webflowItemId` |
| `409` | `retryable` | live-item update race |
| `429` | `retryable` | honor `Retry-After` |
| `5xx` / network | `retryable` | 5s `AbortSignal.timeout`, as the webhook path uses |

Retryable failures are picked up by the existing hourly cron sweep, capped at
`MAX_ATTEMPTS = 3`.

## Testing

Mirrors `tests/lib/publishing/webhook-delivery.test.ts`; Webflow mocked at
`fetch`.

- Mapping → `fieldData` construction, including every field type and static
  values.
- Required-field gate rejects an incomplete mapping.
- Markdown → HTML: each supported tag, code block downgrade, empty body.
- Slug generation and collision retry, including exhaustion after 5 attempts.
- Each error class produces the correct `DeliveryResult`.
- Re-publish: PATCH when `webflowItemId` is set, create-fallback on 404.
- Credentials round-trip encrypt/decrypt; decrypt failure is not silent.
- Existing webhook tests must pass unchanged after the move into
  `destinations/webhook.ts`.

## Out of scope for v1

- OAuth flow and the Marketplace listing (the `authType` column reserves room).
- Webflow webhooks back to us — detecting a customer editing or deleting our
  item. `collection_item_changed` / `collection_item_deleted` would be the hooks.
- Assets API upload for images embedded in rich text.
- More than one site or collection per workspace.
- Multi-locale CMS collections.

## Open risk

Marketplace approval is on the critical path for OAuth. If the listing is
rejected or slow, site tokens remain the only path for external customers
indefinitely — acceptable, but it means the token-paste UI is long-lived rather
than temporary and should be built to that standard.
