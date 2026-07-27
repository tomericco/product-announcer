# Clickable history with a release-detail modal

Align the history page's design with the drafts page, and make every release
clickable: clicking opens a modal showing the release content plus its
properties — released at, destinations (with per-destination status), and who
published it. When the release has LinkedIn-specific copy, show that too.

## Problem

`src/app/(dashboard)/history/page.tsx` renders published releases as a static,
three-column `<Table>` (Title / Delivered to / Sent). Rows are not clickable;
there is no way to see a release's content, its full delivery outcome, or who
published it. The design also diverges from the drafts page's cleaner row-list
look.

## Goal

1. Redesign the history list to match the drafts page's row list.
2. Make each release row open a modal with: the rendered content, released-at,
   who published it, per-destination delivery status, and the LinkedIn copy
   when present.
3. Start tracking who published a release (not currently stored).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Publisher | Add a `publishedBy` column; set it on both publish paths | Not tracked today; `editedBy` (last editor) is unreliable and unset on quick-publish |
| Detail loading | Lazy-load on row click via a `getReleaseDetail` server action | Keeps the list query lean; avoids shipping every release body to the client |
| Destinations in modal | Show ALL delivery attempts with status + error | A detail view should surface failed/pending deliveries, not just successes |
| Body rendering | Add a small server-side `renderMarkdown` (marked + sanitize) → `.mdx-content` HTML | No read-only renderer exists; lighter than mounting the WYSIWYG editor read-only |
| LinkedIn copy | Show `linkedinBody` as a separate section when non-empty, whitespace-preserved | It is plain text (not Markdown); only relevant when present |

## Data model changes

### `releases.publishedBy` (new column)

`src/db/schema.ts`, `releases` table: add

```ts
publishedBy: uuid("published_by").references(() => users.id),
```

Nullable — releases published before this migration have no publisher recorded
and render as "Unknown". Migration is additive (`db:generate` + `db:migrate` +
`db:migrate:test`).

Set `publishedBy: session.user.id` in both publish paths in
`src/app/(dashboard)/drafts/actions.ts`:
- `approveDraft` (approve-and-publish on the detail page) — in the same UPDATE
  that sets `status: "published"`.
- `publishDraft` (quick-publish from the drafts list) — currently sets
  `status: "published"` + `publishedAt` without touching the publisher; add
  `publishedBy`.

No other release column changes. `body`, `publishedAt`, `linkedinBody`, and the
`delivery_attempts` table already hold everything else the modal needs.

## Components

### 1. `renderMarkdown` — new file `src/lib/markdown/render.ts`

A generic read-only Markdown → sanitized HTML renderer, distinct from the
existing Webflow-targeted `markdownToWebflowHtml` (which transforms/strips for
Webflow). Signature:

```ts
export function renderMarkdown(markdown: string): string; // returns sanitized HTML
```

Uses the already-present `marked` for parsing and sanitizes the output (strip
`<script>`/event handlers/`javascript:` URLs) so the HTML is safe for
`dangerouslySetInnerHTML`. The bodies are authored by the tenant's own users, so
this is defense-in-depth. Output is styled by the existing `.mdx-content` CSS
(`globals.css`), so no new styles are needed.

### 2. `getReleaseDetail` — server action in `src/app/(dashboard)/history/actions.ts` (new file)

```ts
export type ReleaseDestinationStatus = {
  destination: "webhook" | "webflow" | "linkedin";
  label: string;                    // destinationLabel(destination)
  status: "pending" | "success" | "failed";
  error: string | null;             // deliveryAttempts.lastError
};
export type ReleaseDetail = {
  id: string;
  title: string;
  bodyHtml: string;                 // renderMarkdown(release.body)
  linkedinBody: string | null;      // raw text, shown whitespace-preserved when non-empty
  publishedAt: string | null;       // ISO
  publisherName: string | null;     // users.name ?? users.email, else null ("Unknown")
  destinations: ReleaseDestinationStatus[];  // ALL attempts for the release, ordered
};

export async function getReleaseDetail(releaseId: string): Promise<ReleaseDetail | null>;
```

Tenant-scoped (`requireSession`, `eq(releases.tenantId, session.user.tenantId)`):
returns `null` if the release is not the caller's (IDOR guard). Joins `users` on
`publishedBy` for the name; loads all `delivery_attempts` for the release mapped
to `ReleaseDestinationStatus[]`. Renders `bodyHtml` server-side via
`renderMarkdown`.

### 3. History list — `src/app/(dashboard)/history/page.tsx` (server component, rewritten body)

Fetch only what the list needs (drop the full-body select; keep title,
`publishedAt`, id, and the success-only delivered-destinations summary the page
already computes). Render the drafts-style list:

- Container `-mx-3`; heading `Change history` (keep current copy/title).
- Empty state via `EmptyState`/`EmptyStateIcon`/… (mirror drafts) when there are
  no published releases.
- Each release rendered by a new client row component (below).

### 4. `HistoryList` + release modal — `src/app/(dashboard)/history/history-list.tsx` (new client component)

A single client wrapper that owns `selectedReleaseId` state and renders **one**
shared `Dialog` (not one per row). It receives the list rows (id, title,
`publishedAt`, delivered-destinations summary) as props from the server page and
renders each as a clickable `button` row. Row markup mirrors the drafts row's
classes (`group relative flex items-center gap-3 rounded-lg px-3 py-2.5
hover:bg-muted/60`) but is a `button` (not an `<a>`), showing title (left),
delivered-destinations summary + date (right, muted). Clicking a row sets
`selectedReleaseId` and opens the shared dialog.

On click: open the `Dialog` (base-ui, controlled `open`/`onOpenChange`, per
`drafts/[releaseId]/publish-dialog.tsx`), call `getReleaseDetail(id)`, show a
loading state until it resolves, then render:

- `DialogTitle` = release title.
- **Properties block** (compact, muted labels): *Released* — full `publishedAt`
  timestamp; *Published by* — `publisherName` or "Unknown"; *Destinations* — one
  `Badge` per attempt, variant by status (`secondary`/green-ish for success,
  `destructive` for failed, `outline` for pending), with the `error` shown
  beneath failed ones.
- Divider, then **content**: `<div className="mdx-content" dangerouslySetInnerHTML={{ __html: bodyHtml }} />`.
- If `linkedinBody` is non-empty: a labeled **"LinkedIn copy"** section rendered
  `whitespace-pre-wrap` (plain text, not Markdown).

`DialogContent` uses `max-h-[85dvh] flex flex-col gap-4 p-6 sm:max-w-2xl` with
the content area scrollable (`overflow-y-auto`) so long releases scroll inside
the modal.

## Error handling

- `getReleaseDetail` for a release not owned by the tenant → returns `null`; the
  modal shows a "Couldn't load this release." message (never another tenant's
  data).
- A Notion/network-independent action; the only failure is a DB error, surfaced
  as the same load-error message.
- `renderMarkdown` on malformed Markdown degrades to escaped text rather than
  throwing.

## Testing

- `renderMarkdown` (unit): headings/lists/links/paragraphs → expected HTML; a
  `<script>`/`onerror`/`javascript:` payload is stripped.
- `getReleaseDetail` (real `_test` DB): returns body HTML + publisher name +
  all destination statuses (incl. a failed attempt with its error) for the
  tenant's release; returns `null` for another tenant's release (IDOR); maps a
  null `publishedBy` to `publisherName: null`.
- `approveDraft` / `publishDraft` (extend existing action tests): both set
  `publishedBy` to the session user on publish.
- The history list + modal UI is presentational — verified by typecheck + lint +
  full suite (this codebase's convention for UI-only changes).

## Out of scope / accepted gaps

- **No publisher backfill.** Historical releases show "Unknown"; only releases
  published after the migration record a publisher.
- **No re-publish / retry from the modal.** It is read-only. Retrying failed
  deliveries stays in the existing cron sweep.
- **LinkedIn copy is shown verbatim** (whitespace-preserved), not re-rendered as
  rich text — it is plain LinkedIn post text.
- **No pagination** on the history list beyond what exists today.
