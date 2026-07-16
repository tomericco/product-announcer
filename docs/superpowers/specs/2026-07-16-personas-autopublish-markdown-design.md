# Structured Personas + Auto-Publish + Markdown Draft Editor — Design

**Status:** Approved (brainstorm) — 2026-07-16
**Builds on:** the shipped MVP + the shadcn re-skin + workspace-level batching (see `2026-07-13-product-announcer-mvp-design.md` and `2026-07-15-shadcn-and-workspace-batching-design.md`). shadcn is the **Base UI flavor** (`@base-ui/react`, no `asChild`, `render` prop).

## Overview

Three product enhancements, delivered together:

1. **Structured user personas** — replace the flat comma-separated `userPersonas` (`text[]`) in the Brand Profile with a list of structured personas, each with a **name**, a **usage** description (how they should use the product), and a **deliveredValue** description (what they get from it). The richer personas feed the AI generation prompt.
2. **Auto-publish workspace setting** — a toggle that publishes a generated update immediately (fires the webhook) and skips the Drafts review queue. When on but **no active webhook** exists, the update falls back to a normal draft (so nothing publishes with no delivery and no review).
3. **Markdown draft editor** — the draft body is edited with a full markdown editor (toolbar + live preview) instead of a plain textarea; the in-app preview renders markdown; the AI generates markdown-formatted bodies.

## Guiding constraints

- shadcn Base UI flavor throughout (no `asChild`; `render` prop). Neutral/grayscale, light mode.
- Server Components + Server Actions remain the mutation path; new client components are allowed where interactivity requires them (personas editor, markdown editor) and each syncs its state into a hidden form field so the existing Server Actions/parse helpers stay the contract.
- Tenant scoping re-derived from `requireSession()` on every action; every query/mutation tenant-scoped.
- Personas fully replace the old flat `text[]` (no backward-compat retained — dev data is disposable).

---

## Feature 1 — Structured user personas

### Data model

`brandProfiles.userPersonas` changes from `text("user_personas").array()` to:

```typescript
userPersonas: jsonb("user_personas").$type<Persona[]>().notNull().default([]),
```

where the shared type is:

```typescript
export type Persona = { name: string; usage: string; deliveredValue: string };
```

(`Persona` lives in `src/db/schema.ts` and is imported where needed.) `usage` = "how they should use the product"; `deliveredValue` = "what they're getting from the product".

### Parsing helper

A pure `parsePersonas(formData: FormData): Persona[]` in `src/lib/persona-form.ts` reads a single hidden `personas` field (a JSON string) and returns a validated array — each entry trimmed, and entries with an empty `name` dropped (a persona with no name is not meaningful). Non-JSON / missing → `[]`. This mirrors how the repo picker feeds a hidden input, and is unit-tested.

### Settings UI

A client component `PersonasEditor` (`src/app/(dashboard)/settings/personas-editor.tsx`, `"use client"`) inside the Brand Profile card:
- Renders one card per persona: a `name` `Input`, a `usage` `Textarea`, a `deliveredValue` `Textarea`, and a **Remove** button.
- An **Add persona** button appends an empty persona.
- Holds the personas array in local state and serializes it into a hidden `<input name="personas">` (JSON) so `saveBrandProfile` receives it via `parsePersonas`.
- Initialized from the saved `brandProfile.userPersonas`.

`saveBrandProfile` replaces its `userPersonas: splitCsv(...)` with `userPersonas: parsePersonas(formData)`. The old comma-separated `userPersonas` input is removed from the form.

### Prompt

`buildSystemPrompt` renders personas descriptively instead of a bare name join:

```typescript
brandProfile.userPersonas.length > 0
  ? `Audience personas: ${brandProfile.userPersonas
      .map((p) => `${p.name} — uses it to ${p.usage}; values ${p.deliveredValue}`)
      .join(" ")}.`
  : null,
```

(Empty `usage`/`deliveredValue` are tolerated — the line still reads acceptably; the parse helper already dropped nameless personas.)

---

## Feature 2 — Auto-publish workspace setting

### Data model

Add to `tenants`:

```typescript
autoPublish: boolean("auto_publish").notNull().default(false),
```

### Behavior

In `runBatchForWorkspace` (`src/lib/run-schedule.ts`), after `claimBatchAndCreateUpdate` returns a non-null `update`:
- Load the tenant's `autoPublish` flag and check for an **active** webhook config (`webhookConfigs` where `tenantId` matches and `active = true`).
- If `autoPublish && hasActiveWebhook`: set the update `status = "published"`, `publishedAt = new Date()`, then `await dispatchWebhookForUpdate(update.id, database)`. The update skips Drafts and appears in History; delivery is recorded as usual.
- Otherwise: leave the update as a `draft` (current behavior) — including the auto-publish-on-but-no-active-webhook case (falls back to a draft).

This applies to **both** scheduled runs (`runSchedulerTick`) and manual "Run now" (both call `runBatchForWorkspace`). `dispatchWebhookForUpdate` is already non-throwing and publish-safe, so a delivery failure never rolls back the publish. `runBatchForWorkspace` still returns whether an Update was created (unchanged signature).

### Settings UI

A shadcn **Switch** (add the `switch` component) in its own Settings card/section:
- `<Switch name="autoPublish" defaultChecked={tenant.autoPublish} />` inside a form with a Save button (submits like the other Base UI form controls, via the Switch's `name`).
- A helper line under it: *"When on, generated updates are published to your webhook immediately and skip the Drafts review queue. Requires an active webhook — without one, updates still land in Drafts for review."*
- A `saveAutoPublish` Server Action (in `settings/actions.ts`) reads `formData.get("autoPublish") === "on"` and updates `tenants.autoPublish` for the session tenant, `revalidatePath("/settings")`.

---

## Feature 3 — Markdown draft editor

### Editor

`@uiw/react-md-editor` (toolbar + live edit/preview), wrapped in a client component `DraftBodyEditor` (`src/app/(dashboard)/drafts/[updateId]/draft-body-editor.tsx`, `"use client"`):
- Dynamic-imported with `ssr: false` (the editor references browser globals); its CSS imported in this client module; `data-color-mode="light"`.
- Controlled: holds the markdown value in state (initialized from the draft's `body`) and syncs it into a hidden `<input name="body">`, so the existing `saveDraft` Server Action is unchanged (still reads `formData.get("body")`).
- Replaces the `Textarea` for `body` in `src/app/(dashboard)/drafts/[updateId]/page.tsx`. Title and category stay as-is.

The body is stored and sent as raw markdown. The webhook payload already sends `body` verbatim; consumers render it.

### In-app preview

The draft Preview dialog (`preview-dialog.tsx`) renders the body **as markdown** — via `MDEditor.Markdown` from the same package (`data-color-mode="light"`) — instead of the current `whitespace-pre-wrap` plain text, so the operator previews the formatted result.

### Generation

`generateUpdateDraft`'s prompt is tweaked so the AI produces a **markdown-formatted** body (e.g. append to the prompt: *"Format the body as Markdown (short paragraphs, bullet lists where helpful)."*). Drafts arrive already formatted.

---

## Migration / testing

- **One migration:** `user_personas` column type `text[]` → `jsonb` with default `[]`; add `tenants.auto_publish boolean not null default false`. Incremental (no table rebuild). The `user_personas` type change resets the column (dev data disposable) — the migration/verification confirms it does not drop/recreate `brand_profiles` or `tenants`.
- **Tests (updated/added):**
  - `parsePersonas` — pure unit tests (valid JSON → trimmed personas; nameless dropped; missing/garbage → `[]`).
  - `buildSystemPrompt` — updated fixture uses structured personas; assert the descriptive "Audience personas: … — uses it to … ; values …" line.
  - `generation.test.ts` — its fake `brandProfile.userPersonas` fixture updates to `Persona[]`; keep the existing prompt assertions (now against a persona name).
  - `runBatchForWorkspace` auto-publish — a new case: with `tenant.autoPublish` true + an active webhook, the created Update is `published` with `publishedAt` set and a `webhookDeliveries` row exists (fetch mocked); with autoPublish true + no active webhook, it stays `draft`.
  - The markdown editor + preview are client UI — manual/visual verification (like the shadcn Combobox), not unit-tested.
- `tsc` clean, full suite green, `npm run build` compiles after each task.

## Non-goals (reaffirmed)

- No brand accent color / dark mode (the md editor is forced light).
- No rich-text (WYSIWYG) editor — markdown source with a live preview is the editing model.
- No per-persona weighting or ordering logic beyond the list order the user enters.
- No change to the per-workspace batching model, the webhook signing/retry, or tenant isolation.
