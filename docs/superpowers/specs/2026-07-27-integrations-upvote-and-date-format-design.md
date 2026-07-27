# Design: upvote cards, shared short date format, dismissible Webflow warning

Date: 2026-07-27

Three small, independent UI changes.

## Item 1 — Coming-soon integrations as upvote cards

### Current state
On the Integrations page ([src/app/(dashboard)/integrations/page.tsx](../../../src/app/(dashboard)/integrations/page.tsx)), the
"Coming soon" section renders `COMING_SOON = ["Customer.io", "Mailchimp", "HubSpot"]`
as a row of faded outline `Badge`s.

### Target
Replace the badge row with a responsive card grid — one `Card` per coming-soon
integration — each with an **Upvote** button. The button is **not connected to any
backend**; nothing is persisted.

### Components
- New client component `src/app/(dashboard)/integrations/coming-soon-card.tsx`
  (`"use client"`), props: `{ name: string }`. The page is a Server Component, so
  interactivity must live in a child client component.
- Card contents:
  - `CardTitle` — integration name.
  - A muted "Coming soon" caption (`text-sm text-muted-foreground`).
  - An Upvote button (`Button variant="outline"`) with a `ChevronUp` icon from
    `lucide-react`.
- Button behavior: local `useState<boolean>` `upvoted`. Clicking toggles it.
  - Not upvoted → label "Upvote", default outline styling.
  - Upvoted → label "Upvoted", active styling (e.g. `border-primary text-primary`,
    emphasized icon).
  - No count shown (nothing persisted → no fabricated numbers).

### Layout
In `page.tsx`, the "Coming soon" `<section>` keeps its `<h2>Coming soon</h2>` and
swaps the flex badge row for:
`<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">` mapping `COMING_SOON`
to `<ComingSoonCard key={name} name={name} />`.

`COMING_SOON` stays defined in `page.tsx`.

## Item 2 — Shared short date format `27 July, 26`

### Current state
Two call sites render dates with `toLocaleDateString()` (locale-dependent, e.g.
`7/27/2026`):
- [src/app/(dashboard)/drafts/page.tsx:99](../../../src/app/(dashboard)/drafts/page.tsx) — `d.createdAt.toLocaleDateString()`
- [src/app/(dashboard)/history/history-list.tsx:84](../../../src/app/(dashboard)/history/history-list.tsx) — `new Date(r.publishedAt).toLocaleDateString()`

### Target
Format: day + full month name + comma + 2-digit year → `27 July, 26`, built with
**date-fns** (`^4.4.0`, already a dependency).

### Helper
Add to [src/lib/utils.ts](../../../src/lib/utils.ts):

```ts
import { format } from "date-fns";

export function formatShortDate(date: Date): string {
  return format(date, "d MMMM, yy"); // e.g. "27 July, 26"
}
```

date-fns tokens: `d` = day of month (no leading zero), `MMMM` = full month name,
`yy` = 2-digit year.

### Call sites
- drafts/page.tsx:99 → `formatShortDate(d.createdAt)`. Keep the existing
  `title={d.createdAt.toLocaleString()}` tooltip for the full timestamp.
- history-list.tsx:84 → `r.publishedAt ? formatShortDate(new Date(r.publishedAt)) : ""`
  (preserve the empty-string fallback for a missing `publishedAt`).

## Item 3 — Dismissible Webflow code-block warning

### Current state
In the draft editor ([src/app/(dashboard)/drafts/[releaseId]/page.tsx:87](../../../src/app/(dashboard)/drafts/[releaseId]/page.tsx)),
an amber `<p>` warns that a draft with a code block will publish as plain text to
Webflow. It renders (server-side) whenever `showCodeWarning` is true and cannot be
dismissed.

### Target
Let the user dismiss the warning; the dismissal is **remembered per draft** on that
browser via `localStorage` (no backend).

### Component
- New client component
  `src/app/(dashboard)/drafts/[releaseId]/webflow-code-warning.tsx` (`"use client"`),
  props: `{ releaseId: string }`.
- `page.tsx` renders `<WebflowCodeWarning releaseId={update.id} />` in place of the
  inline `<p>`, still gated by the server-side `showCodeWarning` boolean (so the
  Webflow-target + contains-code-block logic is unchanged).
- Behavior:
  - `localStorage` key: `webflow-code-warning-dismissed:${releaseId}`.
  - `const [dismissed, setDismissed] = useState(false)`; a `useEffect` reads the key
    on mount and sets `dismissed` if present. (Standard mount-effect pattern to avoid
    a hydration mismatch — accepts a brief render of the banner before the effect
    hides an already-dismissed one.)
  - When `dismissed`, render `null`.
  - The banner keeps its current amber styling and copy, plus a dismiss control: a
    small ghost icon button (`X` from `lucide-react`, `aria-label="Dismiss"`) that
    writes the localStorage key and calls `setDismissed(true)`.

## Out of scope
- No persistence, API, or DB for upvotes.
- No backend persistence for the warning dismissal (localStorage only).
- No changes to date formats elsewhere in the app.

## Testing / verification
Run the dev server and verify via the browser preview:
- Integrations page renders three coming-soon cards; clicking Upvote toggles the
  button to "Upvoted" and back.
- Drafts and Release history pages show dates as `27 July, 26`.
- A draft that triggers the Webflow warning shows a dismiss (X) control; dismissing
  hides it and it stays hidden after reload; a different draft still shows it.
- Check console/build for errors.
