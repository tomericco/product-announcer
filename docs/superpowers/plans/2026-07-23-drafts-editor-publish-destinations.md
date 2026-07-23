# Drafts Editor Layout + Publish-Destinations Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the draft (release) detail editor a cleaner chrome layout and replace its immediate "Approve & publish" with a modal that lets the user choose which configured destinations this publish delivers to.

**Architecture:** Three layers. (1) A destination *registry* gains a display `label`, a `listPublishTargets(tenantId)` readiness query, and an optional `only` filter on `dispatchAllDestinations`. (2) `approveDraft` reads the chosen destinations from the form, validates them, requires ≥1, and forwards them to dispatch. (3) The client editor is relaid out (padding removed, toggle moved to the header, reject moved into the action row) and the approve button becomes a portaled modal that builds `FormData` from the live form and invokes `approveDraft` in a transition.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), Drizzle ORM + Postgres, Vitest (real test DB + stubbed `fetch`), shadcn/base-ui `Dialog`, `useTransition`.

## Global Constraints

- No test may reach the live Anthropic API or any live external API. Destination delivery is exercised with a stubbed global `fetch` and a real test DB (see `tests/lib/publishing/dispatch.test.ts`).
- Client components must NOT import `@/db` or pg. Destination target data reaches the client only as plain-data props queried server-side. Type-only imports from `@/lib/publishing/destinations/types` are allowed in client files (that module is `import type`-only and erases at build).
- Server actions derive tenant/user from the session (`requireSession()`), never from `formData`. The chosen `destinations` are the one thing read from `formData`, and they are validated against the known registry — never trusted verbatim.
- Publishing (mark released/frozen + close out atomic updates) requires at least one selected destination. This is enforced both in the modal (Publish disabled until ≥1 checked) and in `approveDraft` (throws on an empty/all-unknown set).
- The drafts *list* quick-publish (`publishDraft`) is a non-goal: it stays "dispatch to all configured destinations" and is not changed.
- Follow the existing dialog idiom (`src/app/(dashboard)/atomic-updates/new-atomic-update-dialog.tsx`): selection in React state, `FormData` built in JS, action invoked inside `useTransition`. Do not rely on native form serialization from portaled dialog content.

## File Structure

- `src/lib/publishing/destinations/types.ts` — add `label` to the `Destination` interface; add exported `PublishTarget` type. (Task 1)
- `src/lib/publishing/destinations/webhook.ts`, `webflow.ts` — add the `label` field to each destination object. (Task 1)
- `src/lib/publishing/dispatch.ts` — add `listPublishTargets`; add `only?: DestinationId[]` to `dispatchAllDestinations`. (Task 1)
- `tests/lib/publishing/dispatch.test.ts` — cover `listPublishTargets` and the `only` filter. (Task 1)
- `src/app/(dashboard)/drafts/actions.ts` — `approveDraft` reads/validates/forwards `destinations`. (Task 2)
- `tests/app/drafts/publish-idempotency.test.ts` — update `approveFormData` to carry destinations; add destination-selection tests. (Task 2)
- `src/app/globals.css` — zero the MDXEditor content padding. (Task 3)
- `src/app/(dashboard)/drafts/[releaseId]/draft-submit-buttons.tsx` — add `RejectButton`; remove `ApproveButton`. (Task 3)
- `src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx` — NEW client modal. (Task 3)
- `src/app/(dashboard)/drafts/[releaseId]/page.tsx` — relayout chrome; query targets; wire the dialog. (Task 3)

---

### Task 1: Destination registry metadata + publish-target readiness + dispatch filter

**Files:**
- Modify: `src/lib/publishing/destinations/types.ts`
- Modify: `src/lib/publishing/destinations/webhook.ts:27` (destination object)
- Modify: `src/lib/publishing/destinations/webflow.ts:102` (destination object)
- Modify: `src/lib/publishing/dispatch.ts`
- Test: `tests/lib/publishing/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `Destination<TConfig>` gains `label: string`.
  - `type PublishTarget = { id: DestinationId; label: string; configured: boolean }` (exported from `types.ts`).
  - `listPublishTargets(tenantId: string, database?: typeof db): Promise<PublishTarget[]>` — one entry per registered destination, in registry order `[webhook, webflow]`; `configured` is `(await destination.loadConfig(tenantId, db)) != null`.
  - `dispatchAllDestinations(releaseId: string, database?: typeof db, only?: DestinationId[]): Promise<void>` — when `only` is passed, restricts the delivery loop to those ids.
- Consumes: existing `DESTINATIONS`, `Destination`, `DestinationId` from `./destinations/types`.

- [ ] **Step 1: Add `label` to the interface and `PublishTarget` type**

In `src/lib/publishing/destinations/types.ts`, add `label` to the interface and the new type at the end of the file:

```ts
export interface Destination<TConfig> {
  id: DestinationId;
  /** Human-readable name shown in the publish-destinations modal. */
  label: string;
  loadConfig(tenantId: string, database: DbClient): Promise<TConfig | null>;
  deliver(release: Release, config: TConfig, externalId: string | null, database: DbClient): Promise<DeliveryResult>;
}

// One row in the publish modal: a destination and whether it is ready to
// receive a publish (its loadConfig returns non-null — webhook active,
// Webflow has a picked collection). Unconfigured targets still appear, with
// a "Set up" link instead of a checkbox.
export type PublishTarget = { id: DestinationId; label: string; configured: boolean };
```

- [ ] **Step 2: Set `label` on each destination**

In `src/lib/publishing/destinations/webhook.ts`, add `label` right after `id`:

```ts
export const webhookDestination: Destination<WebhookConfig> = {
  id: "webhook",
  label: "Webhook",

  async loadConfig(tenantId, database: DbClient) {
```

In `src/lib/publishing/destinations/webflow.ts`, likewise:

```ts
export const webflowDestination: Destination<WebflowConnection> = {
  id: "webflow",
  label: "Webflow",

  async loadConfig(tenantId, database: DbClient) {
```

- [ ] **Step 3: Write the failing tests**

Add these tests inside the existing `describe("dispatch", …)` block in `tests/lib/publishing/dispatch.test.ts` (they reuse the file's `seed`, `encryptedSecret`, `encryptedToken`, `webflowMapping`, `WEBFLOW_SCHEMA`, `jsonResponse` helpers). Also add `listPublishTargets` to the import from `dispatch`:

```ts
import { dispatchAllDestinations, retryFailedDeliveries, listPublishTargets } from "../../../src/lib/publishing/dispatch";
```

```ts
it("listPublishTargets reports configured=true only for destinations that are ready", async () => {
  const { tenant } = await seed();
  await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
  // Webflow connection exists but no collection chosen yet → not a usable target.
  await db.insert(webflowConnections).values({ tenantId: tenant.id, ...encryptedToken(), status: "active" });

  const targets = await listPublishTargets(tenant.id);

  expect(targets).toEqual([
    { id: "webhook", label: "Webhook", configured: true },
    { id: "webflow", label: "Webflow", configured: false },
  ]);
});

it("listPublishTargets reports Webflow configured once a collection is picked", async () => {
  const { tenant } = await seed();
  await db.insert(webflowConnections).values({
    tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
    fieldMapping: webflowMapping, publishMode: "draft", status: "active",
  });

  const targets = await listPublishTargets(tenant.id);

  expect(targets).toEqual([
    { id: "webhook", label: "Webhook", configured: false },
    { id: "webflow", label: "Webflow", configured: true },
  ]);
});

it("dispatchAllDestinations with `only` delivers to just the listed destinations", async () => {
  const { tenant, update } = await seed();
  await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
  await db.insert(webflowConnections).values({
    tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
    fieldMapping: webflowMapping, publishMode: "draft", status: "active",
  });

  vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

  await dispatchAllDestinations(update.id, db, ["webhook"]);

  const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
  expect(deliveries.map((d) => d.destination)).toEqual(["webhook"]);
  // Webflow untouched: its delivery would be 2 fetches (schema + create); webhook is 1.
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("dispatchAllDestinations with no `only` delivers to all configured destinations", async () => {
  const { tenant, update } = await seed();
  await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
  await db.insert(webflowConnections).values({
    tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
    fieldMapping: webflowMapping, publishMode: "draft", status: "active",
  });

  // Registry order is [webhook, webflow]: webhook = 1 fetch, webflow = schema + create.
  vi.mocked(fetch)
    .mockResolvedValueOnce({ ok: true } as Response)
    .mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA))
    .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

  await dispatchAllDestinations(update.id, db);

  const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
  expect(deliveries.map((d) => d.destination).sort()).toEqual(["webflow", "webhook"]);
});

it("dispatchAllDestinations with `only` naming an unconfigured destination delivers nothing", async () => {
  const { update } = await seed();

  await dispatchAllDestinations(update.id, db, ["webflow"]);

  const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
  expect(deliveries).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run the tests, verify they fail**

Run: `npm test -- tests/lib/publishing/dispatch.test.ts`
Expected: the new tests FAIL — `listPublishTargets` is not exported, and `dispatchAllDestinations` ignores a third argument (the `only` test would deliver to both destinations).

- [ ] **Step 5: Implement `listPublishTargets` and the `only` filter**

In `src/lib/publishing/dispatch.ts`, extend the type import and add the function; modify `dispatchAllDestinations`.

Update the import line (line 6) to add the two types:

```ts
import type { Destination, DeliveryResult, Release, DestinationId, PublishTarget } from "./destinations/types";
```

Add `listPublishTargets` (e.g. just above `dispatchAllDestinations`):

```ts
// Readiness of every registered destination for this tenant, for the publish
// modal. `configured` mirrors exactly what dispatch would act on: loadConfig
// returning non-null (webhook active; Webflow with a picked collection). A
// destination dispatch would skip shows here as unconfigured, so the modal
// never offers a target that can't receive anything.
export async function listPublishTargets(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<PublishTarget[]> {
  const targets: PublishTarget[] = [];
  for (const destination of DESTINATIONS) {
    const config = await destination.loadConfig(tenantId, database);
    targets.push({ id: destination.id, label: destination.label, configured: config != null });
  }
  return targets;
}
```

Modify `dispatchAllDestinations`'s signature and loop source (the body is otherwise unchanged):

```ts
export async function dispatchAllDestinations(
  releaseId: string,
  database: typeof defaultDb = defaultDb,
  // When provided, restricts delivery to these destinations — the publish
  // modal's chosen subset. Omitted (publishDraft, the list quick-publish)
  // keeps delivering to all configured destinations. A selected-but-now-
  // unconfigured id is still safe: the loadConfig null-skip below drops it.
  only?: DestinationId[]
): Promise<void> {
  try {
    const [release] = await database.select().from(releases).where(eq(releases.id, releaseId)).limit(1);
    if (!release) return;

    const targets = only ? DESTINATIONS.filter((d) => only.includes(d.id)) : DESTINATIONS;
    for (const destination of targets) {
      try {
        const config = await destination.loadConfig(release.tenantId, database);
        if (!config) continue;

        await claimAndDeliver(database, destination, release, config, (result) => nextAttempts(result, 1), "publish");
      } catch (error) {
        console.error(`Dispatch to ${destination.id} failed for update ${releaseId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Dispatch failed for update ${releaseId}:`, error);
  }
}
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npm test -- tests/lib/publishing/dispatch.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/publishing/destinations/types.ts src/lib/publishing/destinations/webhook.ts src/lib/publishing/destinations/webflow.ts src/lib/publishing/dispatch.ts tests/lib/publishing/dispatch.test.ts
git commit -m "feat: destination registry labels + listPublishTargets + dispatch only-filter"
```

---

### Task 2: `approveDraft` reads, validates, and forwards the chosen destinations

**Files:**
- Modify: `src/app/(dashboard)/drafts/actions.ts` (imports; `approveDraft`)
- Test: `tests/app/drafts/publish-idempotency.test.ts`

**Interfaces:**
- Consumes: `dispatchAllDestinations(releaseId, database?, only?)` and `DestinationId` from Task 1.
- Produces: `approveDraft` now requires the form to carry ≥1 valid `destinations` entry; it dispatches to exactly that validated set. `publishDraft` is unchanged.

- [ ] **Step 1: Write the failing tests**

In `tests/app/drafts/publish-idempotency.test.ts`:

Add `webflowConnections` to the schema import and an `encryptedToken` helper next to `encryptedSecret`:

```ts
import { tenants, repos, releases, webhookConfigs, webflowConnections, deliveryAttempts, users } from "../../../src/db/schema";
```

```ts
function encryptedToken() {
  const p = encryptSecret("wf-tok");
  return { tokenCiphertext: p.ciphertext, tokenIv: p.iv, tokenAuthTag: p.authTag };
}
```

Change `approveFormData` to carry destinations (defaulting to the seeded webhook so every existing approveDraft test keeps publishing):

```ts
function approveFormData(releaseId: string, publishedAt: string, destinations: string[] = ["webhook"]) {
  const fd = new FormData();
  fd.set("releaseId", releaseId);
  fd.set("title", "Original title");
  fd.set("body", "Original body");
  fd.set("publishedAt", publishedAt);
  for (const d of destinations) fd.append("destinations", d);
  return fd;
}
```

Add these tests inside `describe("approveDraft", …)`:

```ts
it("publishes only to the destinations named in the form", async () => {
  const { tenant, update, user } = await seed();
  // A second, fully-configured destination so the filtering is observable.
  await db.insert(webflowConnections).values({
    tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
    fieldMapping: { name: { source: "title" } }, publishMode: "draft", status: "active",
  });
  vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);
  vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

  await approveDraft(approveFormData(update.id, "", ["webhook"]));

  const deliveries = await deliveriesFor(update.id);
  expect(deliveries.map((d) => d.destination)).toEqual(["webhook"]);
});

it("rejects a publish that names no destinations, leaving the draft unpublished", async () => {
  const { tenant, update, user } = await seed();
  vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

  await expect(approveDraft(approveFormData(update.id, "", []))).rejects.toThrow();

  const row = await rowFor(update.id);
  expect(row.status).toBe("draft");
  expect(fetch).not.toHaveBeenCalled();
  expect(await deliveriesFor(update.id)).toHaveLength(0);
});

it("rejects a publish whose destinations are all unrecognized", async () => {
  const { tenant, update, user } = await seed();
  vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: tenant.id, id: user.id } } as never);

  await expect(approveDraft(approveFormData(update.id, "", ["bogus"]))).rejects.toThrow();

  const row = await rowFor(update.id);
  expect(row.status).toBe("draft");
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npm test -- tests/app/drafts/publish-idempotency.test.ts`
Expected: the two "rejects…" tests FAIL (current `approveDraft` ignores `destinations`, so it publishes regardless — no throw).

- [ ] **Step 3: Implement destination parsing + guard in `approveDraft`**

In `src/app/(dashboard)/drafts/actions.ts`, add the type import and a validator, then wire it into `approveDraft`.

Add near the top imports:

```ts
import type { DestinationId } from "@/lib/publishing/destinations/types";
```

Add this helper (near `parseExpectedPublishedAt`):

```ts
const KNOWN_DESTINATIONS: readonly DestinationId[] = ["webhook", "webflow"];

// The publish modal submits one `destinations` entry per chosen target. Never
// trust the wire: keep only real destination ids, and require at least one —
// publishing marks the release published/frozen and closes out its atomic
// updates, and the product rule is that a publish must name a delivery target.
// The modal disables Publish until one is picked; this is the server-side
// guard for a crafted request that bypasses the UI.
function parseSelectedDestinations(formData: FormData): DestinationId[] {
  const raw = formData.getAll("destinations");
  const selected = KNOWN_DESTINATIONS.filter((id) => raw.includes(id));
  if (selected.length === 0) {
    throw new Error("Select at least one destination to publish to.");
  }
  return selected;
}
```

In `approveDraft`, parse before any write (right after `loadOwnedDraft`) and pass to dispatch:

```ts
export async function approveDraft(formData: FormData) {
  const session = await requireSession();
  const releaseId = formData.get("releaseId") as string;
  const existing = await loadOwnedDraft(session.user.tenantId, releaseId);
  // Validate the chosen destinations before publishing, so an empty/invalid
  // set aborts without marking the release published or closing its atomic updates.
  const destinations = parseSelectedDestinations(formData);
  const expectedPublishedAt = parseExpectedPublishedAt(formData.get("publishedAt"));

  // …unchanged transaction (publish CAS + markReleaseAtomicUpdatesReleased)…

  if (changed) {
    await dispatchAllDestinations(releaseId, undefined, destinations);
  }

  revalidatePath("/drafts");
  redirect("/drafts");
}
```

(Only the two annotated lines and the `dispatchAllDestinations` argument change; leave the transaction body, `markReleaseAtomicUpdatesReleased`, and the redirect exactly as they are. `publishDraft` is not touched.)

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npm test -- tests/app/drafts/publish-idempotency.test.ts`
Expected: PASS (all existing + new).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(dashboard\)/drafts/actions.ts tests/app/drafts/publish-idempotency.test.ts
git commit -m "feat: approveDraft publishes to the destinations chosen in the form"
```

---

### Task 3: Editor chrome relayout + publish-destinations modal

**Files:**
- Modify: `src/app/globals.css` (append one rule)
- Modify: `src/app/(dashboard)/drafts/[releaseId]/draft-submit-buttons.tsx`
- Create: `src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx`
- Modify: `src/app/(dashboard)/drafts/[releaseId]/page.tsx`

**Interfaces:**
- Consumes: `listPublishTargets` (Task 1), `PublishTarget`/`DestinationId` types (Task 1), `approveDraft` (Task 2), existing `SourceToggleButton`, `DraftEditorProvider`, `rejectDraft`, `saveDraft`.
- Produces: `RejectButton` (submits `rejectDraft`); `PublishDialog({ targets })`. `ApproveButton` is removed.

This task has no unit tests (UI layout + a dialog, consistent with the codebase's other dialogs which carry none). Verification is typecheck + lint + build; the reject action is already covered by the unchanged `rejectDraft` tests.

- [ ] **Step 1: Remove the MDXEditor content padding**

Append to `src/app/globals.css`:

```css
/* MDXEditor's content-editable root (._contentEditable_*) ships
   `padding: var(--spacing-3)` (0.75rem) in its own lazily-loaded stylesheet.
   Our contentEditableClassName ("mdx-content …") lands on that same element,
   so zero the padding here to align the body flush with the title and the
   rest of the draft. Doubled class beats the vendor single-class rule
   deterministically regardless of chunk load order — same reasoning as
   .mdx-toolbar-host.mdx-toolbar-host above. */
.mdx-content.mdx-content {
  padding: 0;
}
```

- [ ] **Step 2: Add `RejectButton`, remove `ApproveButton`**

Rewrite `src/app/(dashboard)/drafts/[releaseId]/draft-submit-buttons.tsx` so it exports `SaveChangesButton` (unchanged) and `RejectButton`, and no longer imports `approveDraft` or exports `ApproveButton`:

```tsx
"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { rejectDraft } from "../actions";

// Defense in depth against a double-click: `useFormStatus` reports whether
// the enclosing <form> has a submission in flight, so the buttons disable for
// the duration of either action. Not the guarantee — server actions are
// public endpoints; the real fix is the published_at compare-and-swap in
// actions.ts.
export function SaveChangesButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending}>
      Save changes
    </Button>
  );
}

export function RejectButton() {
  const { pending } = useFormStatus();
  return (
    // formAction overrides the form's default action (saveDraft) for this
    // button only. rejectDraft reads just releaseId (a hidden field in the
    // form), so submitting the whole form here is harmless.
    <Button
      type="submit"
      formAction={rejectDraft}
      variant="ghost"
      disabled={pending}
      className="text-muted-foreground hover:text-destructive"
    >
      Reject
    </Button>
  );
}
```

- [ ] **Step 3: Create the publish dialog**

Create `src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx`:

```tsx
"use client";

import { useRef, useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DestinationId, PublishTarget } from "@/lib/publishing/destinations/types";
import { approveDraft } from "../actions";

/**
 * "Approve & publish" on the draft detail page. Opens a modal listing every
 * publish destination: configured ones as checkboxes (all pre-checked),
 * unconfigured ones as a muted row with a "Set up" link to /integrations
 * (new tab, so the in-progress draft isn't navigated away from). Publish
 * stays disabled until at least one destination is checked.
 *
 * Follows the FormData-in-JS idiom from
 * atomic-updates/new-atomic-update-dialog: the dialog content is portaled
 * outside the <form>, so rather than relying on native serialization it reads
 * the live form via a ref to the in-form trigger button
 * (`triggerRef.current.form`) — capturing the current title/body/hidden fields
 * exactly as a submit would — then appends the chosen destinations and invokes
 * approveDraft in a transition. approveDraft's redirect("/drafts") navigates
 * the router on success (a server action invoked in a transition navigates;
 * see the Next server-actions guide).
 */
export function PublishDialog({ targets }: { targets: PublishTarget[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<DestinationId>>(
    () => new Set(targets.filter((t) => t.configured).map((t) => t.id))
  );
  const [pending, startTransition] = useTransition();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const configured = targets.filter((t) => t.configured);
  const unconfigured = targets.filter((t) => !t.configured);

  function toggle(id: DestinationId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function publish() {
    const form = triggerRef.current?.form;
    if (!form) return;
    const formData = new FormData(form);
    for (const id of selected) formData.append("destinations", id);
    // No try/catch: approveDraft calls redirect(), which throws NEXT_REDIRECT
    // as control flow and must not be swallowed. Its empty-set guard can't be
    // reached from here — Publish is disabled until ≥1 destination is checked.
    startTransition(async () => {
      await approveDraft(formData);
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button ref={triggerRef} type="button">
            Approve & publish
          </Button>
        }
      />
      <DialogContent className="flex max-h-[85dvh] flex-col gap-5 p-6 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish release</DialogTitle>
          <DialogDescription>
            Choose where to publish. Publishing marks this release published and delivers it to the
            selected destinations.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {configured.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4 rounded border-input"
                checked={selected.has(t.id)}
                onChange={() => toggle(t.id)}
              />
              <span className="font-medium">{t.label}</span>
            </label>
          ))}

          {unconfigured.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 text-sm text-muted-foreground"
            >
              <span>{t.label}</span>
              <a
                href="/integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
              >
                Set up
                <ExternalLink className="size-3" />
              </a>
            </div>
          ))}

          {targets.length === 0 && (
            <p className="text-sm text-muted-foreground">No publish destinations available.</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="button" onClick={publish} disabled={selected.size === 0 || pending}>
            {pending ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Note on the trigger ref: the trigger `<Button>` is rendered in place inside the `<form>` (only `DialogContent` is portaled), so `triggerRef.current.form` resolves to the enclosing form. If `ref` does not forward through `DialogTrigger render={<Button …/>}` to the DOM button (verify `triggerRef.current` is non-null when the dialog opens), fall back to attaching the ref to a `<button type="button" hidden ref={triggerRef} />` placed inside the form and read its `.form` instead.

- [ ] **Step 4: Relayout `page.tsx` and wire the dialog**

In `src/app/(dashboard)/drafts/[releaseId]/page.tsx`:

Update imports — drop `rejectDraft` (the standalone reject form is removed) and `ApproveButton`; add `RejectButton`, `PublishDialog`, `listPublishTargets`:

```ts
import { saveDraft } from "../actions";
import { DraftBodyEditor } from "./draft-body-editor";
import { DraftTitleField } from "./draft-title-field";
import { DraftEditorProvider, SourceToggleButton } from "./draft-editor-context";
import { SaveChangesButton, RejectButton } from "./draft-submit-buttons";
import { PublishDialog } from "./publish-dialog";
import { CatchUpBanner } from "./catch-up-banner";
import { listPublishTargets } from "@/lib/publishing/dispatch";
```

After `const delta = await computeReleaseDelta(update.id);`, query the targets:

```ts
const publishTargets = await listPublishTargets(session.user.tenantId);
```

Replace the returned JSX so the provider wraps both the header row and the form, the toggle sits top-right, the action row carries Reject + Save + the dialog, and the standalone reject form is gone:

```tsx
return (
  <div className="mx-auto w-full max-w-3xl space-y-6">
    <DraftEditorProvider>
      <div className="flex items-center justify-between">
        <GuardedLink
          href="/drafts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Drafts
        </GuardedLink>
        <SourceToggleButton />
      </div>

      {statusLabel && (
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{statusLabel}</p>
          {update.reviewStatus === "failed" && update.reviewIssues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {update.reviewIssues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showCodeWarning && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
          This draft contains a code block. Webflow&apos;s rich text field doesn&apos;t support code
          blocks, so it will be published as plain formatted text.
        </p>
      )}

      {delta.count > 0 && <CatchUpBanner count={delta.count} releaseId={update.id} />}

      <form action={saveDraft} className="space-y-4">
        <input type="hidden" name="releaseId" value={update.id} />
        <input
          type="hidden"
          name="publishedAt"
          value={update.publishedAt ? update.publishedAt.toISOString() : ""}
        />
        <h1 className="sr-only">{update.title || "Untitled draft"}</h1>
        <DraftTitleField defaultValue={update.title} />
        <DraftBodyEditor defaultValue={update.body} />
        <div className="flex items-center gap-3 pt-4">
          <RejectButton />
          <SaveChangesButton />
          <div className="ml-auto">
            <PublishDialog targets={publishTargets} />
          </div>
        </div>
      </form>
    </DraftEditorProvider>
  </div>
);
```

(Keep the two hidden-field explanatory comments from the original if preserving them; they are elided here only for brevity. Do not change the hidden fields themselves.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. In particular, `page.tsx` no longer references `rejectDraft` or `ApproveButton`, and `draft-submit-buttons.tsx` no longer imports `approveDraft`.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: clean (no unused imports left behind).

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean. This is the load-bearing check for the client task — it confirms `publish-dialog.tsx` (a client component) pulls no `@/db`/pg value imports (the `types.ts` import is type-only) and that the page compiles.

- [ ] **Step 8: Commit**

```bash
git add src/app/globals.css "src/app/(dashboard)/drafts/[releaseId]/draft-submit-buttons.tsx" "src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx" "src/app/(dashboard)/drafts/[releaseId]/page.tsx"
git commit -m "feat: draft editor chrome relayout + publish-destinations modal"
```

---

## Self-Review

**1. Spec coverage:**
- Change 1 (remove 0.75rem padding) → Task 3 Step 1. ✓
- Change 2 (toggle to top-right; reject into action row; approve right) → Task 3 Steps 2 & 4. ✓
- Change 3 (modal listing configured + unconfigured destinations with setup links; choose destinations; require ≥1; all pre-checked) → Task 1 (registry + `listPublishTargets`), Task 2 (`approveDraft` selection + guard), Task 3 (`publish-dialog.tsx`). ✓
- Non-goal (list `publishDraft` unchanged) → explicitly preserved in Task 1 Step 5 and Task 2 Step 3. ✓
- Global constraints (no live API; no client db import; session-derived tenant; ≥1 destination) → enforced across all tasks and in Task 3 Step 7 (build). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step carries complete code. ✓

**3. Type consistency:** `label: string` added in Task 1 and set on both destinations (same task). `PublishTarget = { id; label; configured }` defined in Task 1 and consumed unchanged by `page.tsx`/`publish-dialog.tsx` in Task 3. `listPublishTargets(tenantId, database?)` signature matches its call in Task 3. `dispatchAllDestinations(releaseId, database?, only?)` matches its call `dispatchAllDestinations(releaseId, undefined, destinations)` in Task 2. `DestinationId` reused verbatim ("webhook" | "webflow"). ✓
