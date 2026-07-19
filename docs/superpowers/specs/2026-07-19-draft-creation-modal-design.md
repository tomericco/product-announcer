# Draft-creation modal with streamed progress

## Problem

Today "Draft update now" on the Pending page calls the `runNow` server action,
which synchronously runs the whole batch (generate → review → save) with no
visibility, then redirects to a `/pending/schedule-choice` page. Users get no
preview of what's being drafted, no progress, and errors are invisible.

## Goal

Replace that flow with a modal that (1) previews the draft, (2) creates it on
demand while showing **real** step-by-step progress streamed from the server,
(3) surfaces errors inline, and (4) ends in a success state linking to the draft.
Drop the post-run schedule skip/replace choice entirely.

## Design

### Flow (client state machine)

A `DraftUpdateDialog` replaces the footer "Draft update now" button, with states:

- **preview** — "N changes from *earliest* → *latest*" (count + date range of the
  batchable items) + **Create draft** / **Cancel**. Create disabled when N = 0.
- **progress** — an ordered step list, each step pending → active → done, updated
  from the streamed events; active step may show a sub-detail line.
- **error** — the streamed error message printed inline + **Try again** / **Close**.
- **success** — "Draft created" + **Review it** (→ `/drafts/{updateId}`) / **Close**.

No schedule choice.

### Progress events (shared contract)

New module `src/lib/scheduling/draft-progress.ts`:

```ts
export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "saving";

export type DraftProgressEvent =
  | { type: "step"; key: DraftStepKey; status: "start" | "done" }
  | { type: "detail"; text: string }          // sub-text under the active step
  | { type: "done"; updateId: string }
  | { type: "error"; message: string };

export type OnDraftProgress = (event: DraftProgressEvent) => void;

// Ordered step metadata the modal renders (key + human label).
export const DRAFT_STEPS: { key: DraftStepKey; label: string }[] = [
  { key: "collecting", label: "Collecting pending changes" },
  { key: "preparing", label: "Preparing brand profile & examples" },
  { key: "generating", label: "Generating the draft" },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the draft" },
];
```

### Backend: emit progress

`runBatchForWorkspace(tenantId, pending, database?, onProgress?)` — add an optional
`onProgress: OnDraftProgress`. It still returns `boolean` (so `runSchedulerTick`
and its tests are untouched — the scheduled path just doesn't pass `onProgress`).
It emits, in order:

- `{step, key:"preparing", status:"start"}` … load brand profile / personas /
  examples … `{step, key:"preparing", status:"done"}`
- `{step, key:"generating", status:"start"}` … `generateUpdateDraft` (the existing
  two-attempt retry) … `{step, key:"generating", status:"done"}`.
  If both attempts fail: `{error, message}` (the caught error's message) and
  return `false` — do NOT also emit a done.
- `{step, key:"reviewing", status:"start"}` … `reviewAndReconcile(..., onProgress)`
  … `{step, key:"reviewing", status:"done"}`
- `{step, key:"saving", status:"start"}` … `claimBatchAndCreateUpdate` … if it
  returns null: `{error, message:"No changes were available to draft."}` + return
  false; else `{step, key:"saving", status:"done"}` then
  `{done, updateId: update.id}`.

The `collecting` step is emitted by the **route** (it fetches the batchable
items), not by `runBatchForWorkspace`.

`reviewAndReconcile(draft, brandProfile, onProgress?)` — add optional `onProgress`.
Emit `{detail, text}` per round: `"Reviewing (round 1)"`, on non-compliance
`"Revising"`, then `"Reviewing (round 2)"`, etc. Behavior otherwise unchanged.

### Backend: streaming route

New `POST /api/pending/draft` route handler (`src/app/api/pending/draft/route.ts`):

1. `const session = await getServerSession(authOptions); if (!hasValidSession(session)) return 401`.
   (Use `getServerSession` directly, not `requireSession`, which redirects.)
2. Emit `{step, key:"collecting", status:"start"}`; `getBatchableChangeItems(tenantId)`;
   if empty emit `{error, message:"No pending changes to draft."}` and close;
   else `{step, key:"collecting", status:"done"}`.
3. Call `runBatchForWorkspace(tenantId, pending, db, onProgress)` where `onProgress`
   enqueues `JSON.stringify(event) + "\n"` into the stream.
4. Wrap in try/catch; on unexpected throw emit `{error, message: String(err)}`.
5. Return `new Response(stream, { headers: { "content-type": "application/x-ndjson" } })`.

Response body is a `ReadableStream`; events are newline-delimited JSON (NDJSON).

### Frontend: the modal

`src/app/(dashboard)/pending/draft-update-dialog.tsx` (client). Props:
`{ preview: { count: number; earliest: string | null; latest: string | null } }`
(dates as ISO strings). Follows the existing Dialog pattern in
`import-commits-dialog.tsx`. On **Create draft**: `fetch("/api/pending/draft",
{ method: "POST" })`, read `res.body` with a reader, split on `\n`, `JSON.parse`
each line, and drive the step list / detail / success / error from the events.
Maps each `DRAFT_STEPS` entry to a status derived from received `step` events.

### Frontend: preview data

`src/app/(dashboard)/pending/page.tsx` — compute the preview server-side from
`getBatchableChangeItems`: `count`, and `earliest`/`latest` from each item's
`committedAt` (commit) or `mergedAt` (PR), as ISO strings (or null). Replace the
footer `<form action={runNow}>…</form>` with `<DraftUpdateDialog preview={…} />`.
Remove the `runNow` import.

### Cleanup (dead code removed once the modal lands)

- `runNow` (`pending/actions.ts`) — replaced by the route.
- `/pending/schedule-choice/page.tsx` (and the empty directory).
- `chooseSchedule` (`pending/actions.ts`) — only the schedule-choice page used it.
- `applyPostRunScheduleChoice` (`run-schedule.ts`) + its test in
  `run-schedule.test.ts` — only `chooseSchedule` used it.

## Out of scope (YAGNI)

- No auto-publish behavior change.
- No cancel-mid-generation (Cancel only applies in the preview state).
- No progress persistence across reloads.
- No new schedule behavior (the schedule is simply untouched by a manual draft).

## Constraints

- This is a patched Next.js: verify route-handler streaming (`ReadableStream`
  response) and `getServerSession` usage in a route against
  `node_modules/next/dist/docs` before writing.
- `runBatchForWorkspace` must keep returning `boolean` and behave identically when
  `onProgress` is omitted (the scheduled path).
- Every request ends in exactly one terminal event: `{done}` or `{error}`.
