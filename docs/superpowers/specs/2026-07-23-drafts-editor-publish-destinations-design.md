# Drafts Editor Layout + Publish-Destinations Modal — Design

**Date:** 2026-07-23
**Branch:** `feat/atomic-updates` (PR #3)
**Status:** Approved

## Summary

Three changes to the draft (release) detail editor at
`src/app/(dashboard)/drafts/[releaseId]/`:

1. Remove the 0.75rem padding from the content editor's main element.
2. Relayout the editor chrome: move the Source/Rich-text toggle to the top
   row (right-aligned, same line as the "← Drafts" back link); move the
   Reject action into the bottom action row where the toggle used to sit;
   push Approve to the far right.
3. Replace the immediate "Approve & publish" submit with a modal that lists
   all publish destinations — configured and not — and lets the user choose
   which configured destinations this publish delivers to.

Changes 1 and 2 are layout-only. Change 3 is the substantive feature.

## Non-Goals

- The drafts **list** quick-publish (`publishDraft` in
  `src/app/(dashboard)/drafts/actions.ts`) is **unchanged**: it continues to
  dispatch to all configured destinations. Only the editor's Approve &
  publish gains the modal. This matches the request's "changes to the drafts
  editor" scoping.
- No new destination types. The registry stays `webhook` + `webflow`.
- No persistence of the chosen destination set. Selection is per-publish and
  ephemeral; a re-publish opens the modal fresh.

## Change 1: Remove content-editor padding

**Root cause.** MDXEditor's vendor stylesheet
(`@mdxeditor/editor/dist/style.css`) applies `padding: var(--spacing-3)`
(= `0.75rem`) to its content-editable root, class `._contentEditable_f3hmk_379`.
That same element also carries our `contentEditableClassName="mdx-content …"`
(set in `mdx-editor.tsx`), so `.mdx-content` targets it directly.

**Fix.** Add a scoped override in `src/app/globals.css` zeroing the padding:

```css
.mdx-content.mdx-content {
  padding: 0;
}
```

The doubled class selector (`.mdx-content.mdx-content`) is deliberate and
follows the existing precedent in the same file
(`.mdx-toolbar-host.mdx-toolbar-host`, with a comment explaining why): the
vendor rule is single-class specificity on the same element, and its
stylesheet is a lazily-loaded chunk whose cascade position relative to
globals.css is not guaranteed, so equal specificity could lose on load
order. Doubling the class wins deterministically without `!important`.

## Change 2: Relayout the editor chrome

Current structure in `page.tsx`:

- A top `← Drafts` back link (`GuardedLink`).
- `<DraftEditorProvider>` wraps `<form action={saveDraft}>`, which contains
  the title field, body editor, and a bottom action row
  `[SourceToggleButton] [SaveChangesButton] [ApproveButton]`.
- A separate sibling `<form action={rejectDraft}>` below with "Not right?
  Reject this draft".

Target structure:

- **Top row** — a `flex items-center justify-between` container holding the
  `← Drafts` link on the left and the Source/Rich-text toggle
  (`SourceToggleButton`) on the right.
- **Bottom action row** — `[RejectButton] [SaveChangesButton] … [ApproveButton]`:
  Reject in the toggle's former leftmost slot, Save next to it, Approve
  pushed to the far right (e.g. `ml-auto` on Approve, or a left group +
  right group).
- The standalone reject `<form>` is **removed**. Reject becomes a
  `formAction={rejectDraft}` submit button inside the main form — the same
  mechanism `ApproveButton` already uses (`formAction={approveDraft}`).
  `rejectDraft` only needs `releaseId`, which is already a hidden input in
  the form.

**Provider scope.** `SourceToggleButton` reads the editor bridge from
`DraftEditorContext`; the bridge is registered by the editor living inside
the form. With the toggle moving to the top row, `<DraftEditorProvider>` must
now wrap **both** the top row and the form so both sit under the same
provider. `SourceToggleButton` already renders `null` until the bridge
registers, so it simply appears in the header once the editor mounts — no
behavior change beyond position.

Reject button styling: a ghost/destructive-leaning button (it is a
form-submitting control, not the primary action). Keep it visually
subordinate to Approve.

## Change 3: Publish-destinations modal

### Behavior

Clicking **Approve & publish** opens a modal rather than submitting. The
modal lists every publish destination:

- **Configured** destinations render as checkbox rows, **all pre-checked**
  by default (preserves today's "publish to all configured" behavior; the
  user unchecks any to skip).
- **Unconfigured** destinations render muted/disabled with a **"Set up →"**
  link to `/integrations`, opened in a **new tab** (`target="_blank"
  rel="noopener noreferrer"`) so the in-progress draft isn't navigated away
  from.

The modal's **Publish** button is **disabled until at least one destination
is checked**. Consequence: if no destination is configured at all, Publish
stays disabled and the user must configure an integration first before this
release can be published. This is the accepted trade-off of the "require ≥1
destination" decision — publishing (which marks the release
published/frozen and closes out its atomic updates) cannot happen here
without a delivery target selected.

On Publish, the release is published and delivery is dispatched **only to
the selected destinations**, then the user is redirected to `/drafts` —
identical to today's approve flow except for the destination filter.

### Server changes

`src/lib/publishing/destinations/types.ts`
- Add `label: string` to the `Destination<TConfig>` interface (human-readable
  name for the modal, e.g. "Webhook", "Webflow").

`src/lib/publishing/destinations/webhook.ts`, `webflow.ts`
- Add the `label` field to each destination object.

`src/lib/publishing/dispatch.ts`
- Add `listPublishTargets(tenantId, database?)` returning
  `{ id: DestinationId; label: string; configured: boolean }[]`. `configured`
  is `(await destination.loadConfig(tenantId, db)) != null` for each
  destination — the canonical, dispatch-consistent readiness check (webhook
  requires `active`, Webflow requires a picked `collectionId`; a destination
  dispatch would skip must show as unconfigured here).
- Extend `dispatchAllDestinations(releaseId, database?, only?: DestinationId[])`:
  when `only` is provided, filter the `DESTINATIONS` loop to those ids.
  Existing callers (`publishDraft`) pass no `only` and keep delivering to all
  configured destinations. `loadConfig`'s existing null-skip still guards a
  selected-but-now-unconfigured destination (a race between page load and
  publish), so the `only` filter never forces delivery to an unusable target.

`src/app/(dashboard)/drafts/actions.ts` — `approveDraft`
- Read the selected ids: `formData.getAll("destinations")`, keep only values
  that are known `DestinationId`s (validate against the registry; never trust
  the client's list verbatim).
- **Server guard (defense-in-depth):** if the validated set is empty, do not
  publish — throw. The modal already prevents an empty submit; this guards a
  crafted request that bypasses the UI, and enforces the "require ≥1" rule at
  the server layer too.
- Pass the validated ids as `only` to `dispatchAllDestinations`. Everything
  else in `approveDraft` (the `published_at` compare-and-swap double-submit
  guard, `markReleaseAtomicUpdatesReleased`, the transaction boundary, the
  redirect) is unchanged.

### Client changes

`page.tsx`
- Query `listPublishTargets(session.user.tenantId)` server-side and pass the
  result to the new client dialog component. The page never leaks a `db`/pg
  import into the client — the targets arrive as a plain-data prop (same
  discipline as `NewAtomicUpdateDialog` receiving `events`).
- Replace `<ApproveButton />` in the action row with the new dialog
  component (which renders both the "Approve & publish" trigger button and
  the modal).

New `src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx`
(`"use client"`)
- Follows the established dialog pattern from `NewAtomicUpdateDialog`:
  - Selection held in React state (`Set<DestinationId>`), initialized to all
    configured ids.
  - Uses the shadcn `Dialog` primitives, `useTransition`, and `sonner`
    `toast` for error surfaces, consistent with existing dialogs.
- Because the dialog content is portaled outside the `<form>`, it does **not**
  rely on native form serialization. On Publish it reads the current form
  via a ref to an in-form element (`ref.current.form`) —
  `new FormData(formEl)` captures the live title/body/releaseId/publishedAt
  exactly as a normal submit would — then appends each selected id as a
  `destinations` entry and calls `approveDraft(formData)` inside the
  transition. `approveDraft`'s `redirect("/drafts")` performs the navigation.
- Trigger: a "Approve & publish" button (`type="button"`) that opens the
  dialog. It replaces the old `ApproveButton` submit; the pending state
  shows "Publishing…" while the transition runs.
- Rows:
  - Configured → `<label>` with a checkbox bound to the React set.
  - Unconfigured → muted row with the destination label and a "Set up →"
    anchor to `/integrations` (new tab). No checkbox.
- Footer: Cancel (`DialogClose`) + Publish. Publish `disabled` when
  `selected.size === 0 || pending`.

### Data flow

```
page.tsx (server)
  listPublishTargets(tenantId) ─────► [{id, label, configured}]
        │ prop
        ▼
publish-dialog.tsx (client)
  state: Set<DestinationId> (init = configured ids)
        │ on Publish
        ▼
  FormData(form) + append("destinations", id)…
        │
        ▼
approveDraft(formData) (server action)
  validate ids ► guard non-empty ► publish (CAS) ► close atomic updates
        │
        ▼
dispatchAllDestinations(releaseId, db, only=selectedIds)
  for d in DESTINATIONS where d.id in only:
     loadConfig ► claimAndDeliver   (null config ⇒ skip)
        │
        ▼
redirect("/drafts")
```

## Testing

- **`listPublishTargets`** — with each destination configured / not
  configured (webhook active vs inactive/absent; Webflow with vs without a
  `collectionId`), assert the `configured` booleans and `label`s. No live
  network (loadConfig is DB-only).
- **`dispatchAllDestinations` with `only`** — assert it delivers to exactly
  the listed destinations and skips the rest; assert no `only` still delivers
  to all configured (existing behavior preserved). Assert a selected-but-
  unconfigured id is skipped via the `loadConfig` null path.
- **`approveDraft` destination validation** — a valid subset flows to
  dispatch as `only`; an empty/all-unknown `destinations` set throws before
  publishing (release stays a draft, no atomic updates closed). Reuse the
  existing `approveDraft` test scaffolding; stub dispatch to capture its
  `only` argument. No live Anthropic/Webflow calls.
- **Layout (changes 1 & 2)** — no unit tests; verified visually. The reject
  `formAction` move is covered by the existing `rejectDraft` action tests
  (unchanged action).

## Global Constraints

- No test may reach the live Anthropic API (or any live external API).
- Client components must not import `@/db` or pg. Destination target data
  reaches the client only as plain-data props queried server-side.
- Server actions derive tenant/user from the session, never from `formData`.
- Released atomic updates stay frozen; this change doesn't alter the
  publish/freeze/close-out invariants — only which destinations receive
  delivery.
