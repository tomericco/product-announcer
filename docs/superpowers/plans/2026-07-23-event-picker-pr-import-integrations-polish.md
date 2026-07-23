# Unified Event Picker, PR Import, Integrations Move & Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight changes: a shared rich multi-select event picker reused by the importer and the add-to-atomic-update flow, merged-PR import, a Settings→Integrations move of GitHub, an optional webhook secret, an open-drafts nav counter, two label alignments, and a user avatar/logout menu.

**Architecture:** Small independent UI/polish tasks first (labels, nav counter, avatar, webhook secret, GitHub move), then the coupled work: extract `EventMultiSelect` from the Import dialog (behavior-preserving), add PR import on the server, wire the PR tab + type switcher into the Import dialog, and finally make the add-to-atomic-update picker multi-select (batch add + one regeneration) using the shared component.

**Tech Stack:** Next.js 16 App Router (Server Components + Server Actions), Drizzle ORM + Postgres, octokit (GitHub App), Vitest (real test DB + injected/stubbed externals), shadcn/base-ui `Dialog`/`Tabs`/`DropdownMenu`, `next-auth` (JWT strategy).

## Global Constraints

- No test may reach a live external API (Anthropic, GitHub, Webflow). GitHub fetches and enrichment are injected/mocked (see `tests/lib/change-events/*`, `tests/lib/publishing/dispatch.test.ts`).
- Client components must not import `@/db` or pg. Server data reaches client dialogs only as plain-data props or via server actions the client calls. Type-only imports are fine.
- Server actions derive tenant/user from `requireSession()`, never from `formData`; every GitHub/DB read is tenant-scoped.
- `externalId` namespacing: commits use the SHA; PRs use `owner/repo#number`. Uniqueness via `change_events_repo_commit_unique`, `change_events_repo_pr_unique`, `change_events_tenant_provider_external_unique`.
- Adding/removing evidence on an atomic update always regenerates its title/summary, overwriting a prior hand-edit (clear `summaryEditedAt` before the best-effort refresh). A hidden/released update is never a valid add target.
- Keep typecheck + lint + vitest + build green at the end of every task.
- Test DB = Docker `product-announcer-postgres` on :5434. If `ECONNREFUSED :5434`: `open -a Docker`; `docker start product-announcer-postgres`; `npm run db:migrate:test`. Never run two DB-backed vitest suites concurrently.

## File Structure

- `nav-links.tsx`, `history/page.tsx`, `publish-dialog.tsx` — label/counter changes (Tasks 1, 2, 6-labels).
- `layout.tsx`, `user-menu.tsx` (new), `lib/workspace/initials.ts` (new) — avatar/logout + draft counter (Tasks 2, 3).
- `db/schema.ts` + a generated migration, `integrations/webhook-config-form.tsx`, `integrations/actions.ts`, `lib/publishing/destinations/webhook.ts` — optional secret (Task 4).
- `settings/page.tsx` → `integrations/page.tsx` + moved repo components, `api/github/setup/route.ts` — GitHub move (Task 5).
- `_components/event-multi-select.tsx` (new), `change-events/import-dialog.tsx` — shared picker (Task 6).
- `lib/integrations/github/github.ts`, `lib/change-events/import-pull-requests.ts` (new), `change-events/import-actions.ts` — PR import server (Task 7).
- `change-events/import-dialog.tsx` — PR tab wiring (Task 8).
- `lib/change-events/add-events-to-atomic-update.ts` (new), `atomic-updates/actions.ts`, `atomic-updates/add-event-picker.tsx`, `atomic-updates/atomic-update-card.tsx` — multi-add (Task 9).

---

### Task 1: Label alignments — "Publish" CTA + "Release history" (Features F, G)

**Files:**
- Modify: `src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx`
- Modify: `src/app/(dashboard)/history/page.tsx:24`

Two trivial string changes with no behavior change and no tests; grouped because each alone is too small for its own review gate. Verified by typecheck + build.

- [ ] **Step 1: Rename the draft CTA**

In `publish-dialog.tsx`, the `DialogTrigger`'s button text changes from `Approve & publish` to `Publish`:

```tsx
<DialogTrigger
  render={
    <Button ref={triggerRef} type="button">
      Publish
    </Button>
  }
/>
```

- [ ] **Step 2: Rename the History nav item**

In `nav-links.tsx`, change the `/history` entry label:

```ts
  { href: "/history", label: "Release history" },
```

- [ ] **Step 3: Rename the History page heading**

In `history/page.tsx:24`:

```tsx
      <h1 className="text-xl font-semibold">Release history</h1>
```

- [ ] **Step 4: Verify + commit**

Run: `npm run typecheck` (clean), `npm run build` (clean).

```bash
git add "src/app/(dashboard)/drafts/[releaseId]/publish-dialog.tsx" "src/app/(dashboard)/nav-links.tsx" "src/app/(dashboard)/history/page.tsx"
git commit -m "feat: align draft CTA to 'Publish' and rename History to Release history"
```

---

### Task 2: Open-drafts nav counter (Feature E)

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx`

**Interfaces:**
- Produces: `<NavLinks draftCount={number} />`.

No unit test (a layout count + presentational badge); verified via typecheck/build.

- [ ] **Step 1: Count open drafts in the layout and pass it down**

In `layout.tsx`, add `count` + `releases` to the drizzle imports (`import { count, eq } from "drizzle-orm";` and add `releases` to the `@/db/schema` import), then after the `tenant` query add:

```ts
  const [draftCountRow] = await db
    .select({ value: count() })
    .from(releases)
    .where(and(eq(releases.tenantId, session.user.tenantId), eq(releases.status, "draft")));
  const draftCount = draftCountRow?.value ?? 0;
```

Add `and` to the drizzle import. Then render `<NavLinks draftCount={draftCount} />`.

- [ ] **Step 2: Render the badge in NavLinks**

In `nav-links.tsx`, accept the prop and show a badge on the Drafts item when > 0. Add a `Badge` import (`import { Badge } from "@/components/ui/badge";`).

```tsx
export function NavLinks({ draftCount }: { draftCount: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Button
            key={item.href}
            variant={active ? "secondary" : "ghost"}
            className="justify-start font-normal"
            aria-current={active ? "page" : undefined}
            render={<GuardedLink href={item.href} />}
          >
            {item.label}
            {item.href === "/drafts" && draftCount > 0 && (
              <Badge variant="secondary" className="ml-auto">
                {draftCount}
              </Badge>
            )}
          </Button>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck`, `npm run build` (both clean).

```bash
git add "src/app/(dashboard)/layout.tsx" "src/app/(dashboard)/nav-links.tsx"
git commit -m "feat: show open-drafts count on the Drafts nav item"
```

---

### Task 3: User avatar + logout menu (Feature H)

**Files:**
- Create: `src/lib/workspace/initials.ts`
- Create: `src/app/(dashboard)/user-menu.tsx`
- Modify: `src/app/(dashboard)/layout.tsx`
- Test: `tests/lib/workspace/initials.test.ts`

**Interfaces:**
- Produces: `initials(nameOrEmail: string): string`; `<UserMenu email={string} name={string | null} />`.

- [ ] **Step 1: Write the failing test for `initials`**

Create `tests/lib/workspace/initials.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { initials } from "../../../src/lib/workspace/initials";

describe("initials", () => {
  it("takes the first letters of the first two words of a name", () => {
    expect(initials("Tomer Gabbai")).toBe("TG");
  });
  it("uses a single-word name's first two letters", () => {
    expect(initials("Cher")).toBe("CH");
  });
  it("falls back to the email local-part when there is no name", () => {
    expect(initials("tomer@frontitude.com")).toBe("TO");
  });
  it("returns a single letter when only one is available", () => {
    expect(initials("a@b.com")).toBe("A");
  });
  it("returns '?' for empty input", () => {
    expect(initials("")).toBe("?");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- tests/lib/workspace/initials.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `initials`**

Create `src/lib/workspace/initials.ts`:

```ts
// Derives up-to-2-character initials for the default (image-less) avatar.
// A multi-word name uses the first letter of its first two words; a
// single word uses its first two letters; with no name we fall back to the
// email's local-part (before "@") under the same rule. Purely presentational.
export function initials(nameOrEmail: string): string {
  const source = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const words = source.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- tests/lib/workspace/initials.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the `UserMenu` client component**

Create `src/app/(dashboard)/user-menu.tsx`:

```tsx
"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { initials } from "@/lib/workspace/initials";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Sidebar footer identity + account menu. The avatar is initials-only (no
 * remote image fetch — keeps the app free of external image requests). The
 * single action is Log out, via NextAuth's `signOut`, which POSTs to the
 * unguarded /api/auth/signout and redirects to sign-in. No SessionProvider is
 * required for `signOut`.
 */
export function UserMenu({ email, name }: { email: string; name: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal" />
        }
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground">
          {initials(name || email)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[13rem]">
        <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/api/auth/signin" })}>
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 6: Wire it into the layout**

In `layout.tsx`, replace the plain email footer div:

```tsx
        <div className="mt-auto px-2 pt-3 text-xs text-muted-foreground">{session.user.email}</div>
```

with:

```tsx
        <div className="mt-auto pt-3">
          <UserMenu email={session.user.email} name={session.user.name ?? null} />
        </div>
```

Add `import { UserMenu } from "./user-menu";`.

- [ ] **Step 7: Verify + commit**

Run: `npm test -- tests/lib/workspace/initials.test.ts` (pass), `npm run typecheck`, `npm run lint`, `npm run build` (clean).

```bash
git add src/lib/workspace/initials.ts tests/lib/workspace/initials.test.ts "src/app/(dashboard)/user-menu.tsx" "src/app/(dashboard)/layout.tsx"
git commit -m "feat: user avatar + logout menu in the sidebar"
```

---

### Task 4: Optional webhook secret (Feature D)

**Files:**
- Modify: `src/db/schema.ts:258-260`
- Create: a generated migration under `drizzle/` (via `npm run db:generate`)
- Modify: `src/app/(dashboard)/integrations/webhook-config-form.tsx`
- Modify: `src/app/(dashboard)/integrations/actions.ts` (`saveWebhookConfig`)
- Modify: `src/lib/publishing/destinations/webhook.ts` (`deliver`)
- Test: `tests/lib/publishing/dispatch.test.ts`

**Interfaces:**
- Produces: `webhook_configs` secret columns nullable; `webhookDestination.deliver` sends no signature header when the secret is null.

- [ ] **Step 1: Make the secret columns nullable in the schema**

In `src/db/schema.ts`, drop `.notNull()` from the three secret columns:

```ts
  secretCiphertext: text("secret_ciphertext"),
  secretIv: text("secret_iv"),
  secretAuthTag: text("secret_auth_tag"),
```

- [ ] **Step 2: Generate + apply the migration**

Run: `npm run db:generate`
Expected: a new migration containing `ALTER TABLE "webhook_configs" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;` (and the same for `secret_iv`, `secret_auth_tag`). A nullability change is not a rename, so it should not prompt; if it does prompt interactively, the change is unambiguous.
Then apply to the test DB: `npm run db:migrate:test`, and to dev: `npm run db:migrate`.

- [ ] **Step 3: Write the failing test (deliver without a secret)**

In `tests/lib/publishing/dispatch.test.ts`, add a test inside `describe("dispatch", …)` (reuses `seed`, and note the webhook config is inserted WITHOUT a secret):

```ts
it("delivers without a signature header when the webhook config has no secret", async () => {
  const { tenant, update } = await seed();
  await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook" });

  vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

  await dispatchAllDestinations(update.id);

  const [call] = vi.mocked(fetch).mock.calls;
  const headers = (call[1] as RequestInit).headers as Record<string, string>;
  expect(headers["x-product-announcer-signature"]).toBeUndefined();
  expect(headers["content-type"]).toBe("application/json");

  const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.releaseId, update.id));
  expect(delivery.status).toBe("success");
});
```

- [ ] **Step 4: Run it, verify it fails**

Run: `npm test -- tests/lib/publishing/dispatch.test.ts`
Expected: FAIL — the current `deliver` calls `decryptSecret` on null columns (throws → permanent/configFault, no fetch), so the assertions fail. (It also would not compile against the nullable type until Step 5.)

- [ ] **Step 5: Skip signing when there is no secret**

In `src/lib/publishing/destinations/webhook.ts`, replace the unconditional decrypt + signed-header block in `deliver` with a null-aware one:

```ts
  async deliver(release, config, _externalId, _database): Promise<DeliveryResult> {
    // A secret is optional. With one, sign the body (HMAC) and, on a decrypt
    // failure, fail permanently as a config fault — retrying can't help.
    // Without one, deliver unsigned: no signature header at all.
    let signature: string | null = null;
    if (config.secretCiphertext && config.secretIv && config.secretAuthTag) {
      let secret: string;
      try {
        secret = decryptSecret({
          ciphertext: config.secretCiphertext,
          iv: config.secretIv,
          authTag: config.secretAuthTag,
        });
      } catch {
        return {
          status: "permanent",
          error: "Could not decrypt the webhook secret. Check CREDENTIALS_ENCRYPTION_KEY.",
          configFault: true,
        };
      }
      signature = signPayload(secret, JSON.stringify(buildPayload(release)));
    }

    const body = JSON.stringify(buildPayload(release));
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-product-announcer-signature": signature } : {}),
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      return response.ok ? { status: "ok" } : { status: "retryable", error: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
    }
  },
```

Note: `signPayload` must run over the exact `body` that is sent. Compute `body` once before signing to keep them identical:

```ts
    const body = JSON.stringify(buildPayload(release));
    let signature: string | null = null;
    if (config.secretCiphertext && config.secretIv && config.secretAuthTag) {
      let secret: string;
      try {
        secret = decryptSecret({ ciphertext: config.secretCiphertext, iv: config.secretIv, authTag: config.secretAuthTag });
      } catch {
        return { status: "permanent", error: "Could not decrypt the webhook secret. Check CREDENTIALS_ENCRYPTION_KEY.", configFault: true };
      }
      signature = signPayload(secret, body);
    }
    try {
      const response = await fetch(config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(signature ? { "x-product-announcer-signature": signature } : {}) },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      return response.ok ? { status: "ok" } : { status: "retryable", error: `HTTP ${response.status}` };
    } catch (error) {
      return { status: "retryable", error: error instanceof Error ? error.message : "request failed" };
    }
```

Use this single-`body` form (the first block above is illustrative; this is the one to implement).

- [ ] **Step 6: Run it, verify it passes (and existing signed test still passes)**

Run: `npm test -- tests/lib/publishing/dispatch.test.ts`
Expected: PASS — the new no-secret test and the existing "records a successful delivery and signs the payload" test both pass.

- [ ] **Step 7: Allow saving a secret-less config**

In `src/app/(dashboard)/integrations/actions.ts`, in `saveWebhookConfig`, remove the insert-branch guard. Replace:

```ts
    } else {
      if (!encrypted) throw new Error("A secret is required to create a webhook config");
      await db.insert(webhookConfigs).values({
        tenantId: session.user.tenantId,
        url,
        active,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
      });
    }
```

with:

```ts
    } else {
      await db.insert(webhookConfigs).values({
        tenantId: session.user.tenantId,
        url,
        active,
        // A secret is optional: with none provided, the columns stay null and
        // deliveries go out unsigned.
        ...(encrypted
          ? { secretCiphertext: encrypted.ciphertext, secretIv: encrypted.iv, secretAuthTag: encrypted.authTag }
          : {}),
      });
    }
```

- [ ] **Step 8: Make the form's Secret field optional**

In `webhook-config-form.tsx`, drop `required={!config}` and update the placeholder so it reads as optional:

```tsx
        <Input
          id="secret"
          type="password"
          name="secret"
          placeholder={config ? "Saved — leave blank to keep" : "Optional — used to sign deliveries"}
        />
```

- [ ] **Step 9: Verify + commit**

Run: `npm test -- tests/lib/publishing/dispatch.test.ts` (pass), `npm run typecheck`, `npm run lint`, `npm run build` (clean).

```bash
git add src/db/schema.ts drizzle/ "src/app/(dashboard)/integrations/webhook-config-form.tsx" "src/app/(dashboard)/integrations/actions.ts" src/lib/publishing/destinations/webhook.ts tests/lib/publishing/dispatch.test.ts
git commit -m "feat: make the webhook signing secret optional (deliver unsigned when absent)"
```

---

### Task 5: Move GitHub repos from Settings to Integrations (Feature B)

**Files:**
- Modify: `src/app/(dashboard)/settings/page.tsx` (remove the GitHub repos card + its data)
- Modify: `src/app/(dashboard)/integrations/page.tsx` (add the GitHub repos card + its data)
- Move: `settings/add-repo-dialog.tsx`, `settings/repo-branch-select.tsx`, `settings/repo-row.tsx` → `integrations/` (and `removeRepo` action)
- Modify: `src/app/api/github/setup/route.ts` (redirect map)
- Modify: `settings/actions.ts` / `integrations/actions.ts` as needed for `removeRepo`

No new unit tests (a relocation). Verified via typecheck + lint + build; existing repo/branch tests keep passing.

- [ ] **Step 1: Move the repo components + `removeRepo` to integrations**

`git mv` the three components into `integrations/`:

```bash
git mv "src/app/(dashboard)/settings/add-repo-dialog.tsx" "src/app/(dashboard)/integrations/add-repo-dialog.tsx"
git mv "src/app/(dashboard)/settings/repo-branch-select.tsx" "src/app/(dashboard)/integrations/repo-branch-select.tsx"
git mv "src/app/(dashboard)/settings/repo-row.tsx" "src/app/(dashboard)/integrations/repo-row.tsx"
```

Move the `removeRepo` server action from `settings/actions.ts` to `integrations/actions.ts` (cut the function + any helpers it alone uses; keep imports valid in both files). Update the moved components' imports of `removeRepo`/sibling components to their new relative paths. Update any `revalidatePath("/settings")` inside `removeRepo` (and the repo add/branch actions if they live in settings) to `revalidatePath("/integrations")`.

- [ ] **Step 2: Move the GitHub repos card + data into the Integrations page**

In `integrations/page.tsx`, add the GitHub data-fetching block currently in `settings/page.tsx` (the `installUrl`, `listAccessibleRepos`, `branchesByFullName` map with its per-repo try/catch, `availableRepos`) — importing `getGithubApp`, `listAccessibleRepos`, `listRepoBranches`, `repos`, `tenants` as needed — and render the **GitHub repos** `Card` (the connect button / repo list / `RepoBranchSelect` / `AddRepoDialog`) as a new section alongside Webhook and Webflow. Change the install-URL state to target integrations:

```ts
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|integrations` });
```

- [ ] **Step 3: Remove the GitHub repos card + data from Settings**

In `settings/page.tsx`, delete the GitHub repos `Card` JSX and the now-unused GitHub data-fetching (`installUrl`, `accessibleRepos`, `branchesByFullName`, `availableRepos`) and the now-unused imports (`getGithubApp`, `listAccessibleRepos`, `listRepoBranches`, `AddRepoDialog`, `RepoBranchSelect`). Keep the workspace-name, brand, personas, schedule cards untouched.

- [ ] **Step 4: Update the setup-route redirect**

In `src/app/api/github/setup/route.ts`, map the new `returnTo`:

```ts
  const destination = returnTo === "integrations" ? "/integrations" : returnTo === "settings" ? "/settings" : "/onboarding";
  return NextResponse.redirect(new URL(`${destination}?github_connect=success`, request.url));
```

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck`, `npm run lint`, `npm run build`, and the existing repo tests `npm test -- tests/lib/workspace/repo-selection-form.test.ts tests/lib/workspace/repo-sync.test.ts` (all pass). Grep to confirm no dangling `settings` references to the moved pieces: `grep -rn "add-repo-dialog\|repo-branch-select\|repo-row\|removeRepo" "src/app/(dashboard)/settings"` returns nothing.

```bash
git add -A "src/app/(dashboard)/settings" "src/app/(dashboard)/integrations" src/app/api/github/setup/route.ts
git commit -m "feat: move GitHub repos management from Settings to Integrations"
```

---

### Task 6: Extract the shared `EventMultiSelect` picker (Feature A, part 1)

**Files:**
- Create: `src/app/(dashboard)/_components/event-multi-select.tsx`
- Modify: `src/app/(dashboard)/change-events/import-dialog.tsx`

**Interfaces:**
- Produces:

```ts
export type PickerType = "commit" | "pull_request";

export type PickerRow = {
  key: string;                 // unique selection key
  title: string;               // primary line
  meta?: React.ReactNode;      // secondary line
  externalUrl?: string | null; // external "open" link (right side)
  locked?: boolean;            // rendered checked + disabled (e.g. already imported)
  badge?: React.ReactNode;     // right-side badge
};

export function EventMultiSelect(props: {
  activeType: PickerType;
  onTypeChange: (t: PickerType) => void;
  enabledTypes: PickerType[];      // tabs to enable; a disabled "Task — soon" tab always shows
  rows: PickerRow[];               // rows for the active type (parent-loaded)
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  search: string;
  onSearchChange: (s: string) => void;
  filtersSlot?: React.ReactNode;   // caller chrome (repo tabs, date range) above the list
  submitLabel: string;
  submitting?: boolean;
  onSubmit: () => void;
}): JSX.Element;
```

This is a **behavior-preserving extraction**: the list rendering, `Select all`, and shift-click range selection currently in `import-dialog.tsx` move into `EventMultiSelect` verbatim (generalized from `ImportableCommit` to `PickerRow`). No functional change to the Import dialog after wiring.

- [ ] **Step 1: Create `EventMultiSelect`**

Create `src/app/(dashboard)/_components/event-multi-select.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type PickerType = "commit" | "pull_request";

export type PickerRow = {
  key: string;
  title: string;
  meta?: React.ReactNode;
  externalUrl?: string | null;
  locked?: boolean;
  badge?: React.ReactNode;
};

const TYPE_LABEL: Record<PickerType, string> = { commit: "Commits", pull_request: "PRs" };

export function EventMultiSelect({
  activeType,
  onTypeChange,
  enabledTypes,
  rows,
  loading,
  error,
  emptyLabel = "Nothing to show.",
  selected,
  onSelectedChange,
  search,
  onSearchChange,
  filtersSlot,
  submitLabel,
  submitting,
  onSubmit,
}: {
  activeType: PickerType;
  onTypeChange: (t: PickerType) => void;
  enabledTypes: PickerType[];
  rows: PickerRow[];
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  search: string;
  onSearchChange: (s: string) => void;
  filtersSlot?: React.ReactNode;
  submitLabel: string;
  submitting?: boolean;
  onSubmit: () => void;
}) {
  // Anchor for shift-click range selection, by key (survives filtering).
  const anchorKey = useRef<string | null>(null);
  const shiftHeldRef = useRef(false);

  // A new type tab is a different result set — its selection and anchor don't
  // carry over.
  useEffect(() => {
    anchorKey.current = null;
  }, [activeType]);

  const query = search.trim().toLowerCase();
  const visible = query ? rows.filter((r) => r.title.toLowerCase().includes(query)) : rows;
  const selectable = visible.filter((r) => !r.locked);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key));

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectedChange(next);
  }

  function selectRange(fromIndex: number, toIndex: number) {
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    const clicked = visible[toIndex];
    const target = !selected.has(clicked.key);
    const next = new Set(selected);
    for (let i = lo; i <= hi; i++) {
      const r = visible[i];
      if (r.locked) continue;
      if (target) next.add(r.key);
      else next.delete(r.key);
    }
    onSelectedChange(next);
  }

  function onCheckboxChange(row: PickerRow, index: number) {
    const anchorIndex =
      shiftHeldRef.current && anchorKey.current
        ? visible.findIndex((r) => r.key === anchorKey.current)
        : -1;
    if (anchorIndex !== -1) selectRange(anchorIndex, index);
    else toggle(row.key);
    anchorKey.current = row.key;
    shiftHeldRef.current = false;
  }

  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) for (const r of selectable) next.delete(r.key);
    else for (const r of selectable) next.add(r.key);
    onSelectedChange(next);
  }

  return (
    <>
      <Tabs value={activeType} onValueChange={(v) => onTypeChange(v as PickerType)}>
        <TabsList>
          {enabledTypes.map((t) => (
            <TabsTrigger key={t} value={t}>
              {TYPE_LABEL[t]}
            </TabsTrigger>
          ))}
          <TabsTrigger value="task" disabled>
            Tasks — soon
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {filtersSlot}

      <div className="h-80 overflow-y-auto rounded-lg border border-border">
        <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-border bg-background px-4 py-2.5 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allSelected}
            disabled={selectable.length === 0}
            onChange={toggleAll}
          />
          Select all{selectable.length > 0 ? ` (${selectable.length})` : ""}
          <span className="ml-auto text-xs font-normal text-muted-foreground">Shift-click to select a range</span>
        </label>
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((row, index) => {
              const checked = row.locked || selected.has(row.key);
              return (
                <li key={row.key}>
                  <label
                    className={
                      "flex cursor-pointer items-start gap-3 px-4 py-3.5 text-sm hover:bg-muted/50" +
                      (row.locked ? " cursor-not-allowed opacity-60" : "")
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-input"
                      checked={checked}
                      disabled={row.locked}
                      onClick={(e) => {
                        shiftHeldRef.current = e.shiftKey;
                      }}
                      onChange={() => onCheckboxChange(row, index)}
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="block truncate font-medium">{row.title}</span>
                      {row.meta && <span className="block text-xs text-muted-foreground">{row.meta}</span>}
                    </span>
                    {row.badge && (
                      <Badge variant="secondary" className="shrink-0 self-center">
                        {row.badge}
                      </Badge>
                    )}
                    {row.externalUrl && (
                      <a
                        href={row.externalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Open externally"
                        className="shrink-0 self-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{selected.size} selected</span>
        <Button type="button" onClick={onSubmit} disabled={selected.size === 0 || submitting}>
          {submitLabel}
        </Button>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Rewrite `import-dialog.tsx` to use `EventMultiSelect`**

Replace the inline list/tabs/selection logic in `import-dialog.tsx` with the shared component, keeping the Import dialog's own data loading (commits), its repo tabs + date filters (passed as `filtersSlot`), and its `Cancel`/CTA footer inside the shared component's footer. Concretely:

- Keep: `open`, `activeTab` (repo tabs — this is the REPO filter, distinct from the event-type tabs), `commits`, `loading`, `error`, `search`, `after`, `before`, `submitting`, the `load` effect, `onImport`, `reset`.
- Add: `const [pickerType, setPickerType] = useState<PickerType>("commit");` and change `selected` from `Map<string, CommitSelection>` to `Set<string>` keyed by `selectionKey(repoId, sha)`, with a lookup `Map` from key → `CommitSelection` derived from `commits` at submit time (so `onImport` builds `selections` by mapping the selected keys through the loaded `commits`).
- Map `commits` (after `imported` handling) to `PickerRow[]`: `key = selectionKey(c.repoId, c.sha)`, `title = c.message.split("\n")[0]`, `meta = <>{activeTab === ALL && repo · }{author · }{sha7}{ · date}</>`, `externalUrl = c.url`, `locked = c.imported`, `badge = c.imported ? "Imported" : undefined`.
- Render `<EventMultiSelect activeType={pickerType} onTypeChange={(t) => { setPickerType(t); setSelected(new Set()); }} enabledTypes={["commit"]} rows={rows} loading={loading} error={error} emptyLabel="No commits found." selected={selected} onSelectedChange={setSelected} search={search} onSearchChange={setSearch} filtersSlot={<>{repoTabs}{dateInputs}</>} submitLabel={submitting ? "Importing…" : \`Import ${selected.size} commit${selected.size === 1 ? "" : "s"}\`} submitting={submitting} onSubmit={onImport} />`.
- In this task, `enabledTypes={["commit"]}` (PR wiring lands in Task 8). The `Cancel` button stays as a `DialogClose` in the dialog footer alongside the shared component, or keep the shared component's CTA and add a `DialogClose` Cancel just outside it — preserve the existing two-button footer.

The `DialogHeader`/`Dialog` shell, repo `Tabs`, and the date inputs remain in `import-dialog.tsx`; only the list + select-all + shift logic + the "N selected"/CTA move into `EventMultiSelect`.

- [ ] **Step 3: Verify (behavior-preserving) + commit**

Run: `npm run typecheck`, `npm run lint`, `npm run build` (clean). Manual smoke (recommended, not gating): open the Import dialog, confirm search, select-all, shift-range, per-repo tabs, and import still work exactly as before.

```bash
git add "src/app/(dashboard)/_components/event-multi-select.tsx" "src/app/(dashboard)/change-events/import-dialog.tsx"
git commit -m "refactor: extract shared EventMultiSelect from the import dialog"
```

---

### Task 7: PR import — server (Feature C, part 1)

**Files:**
- Modify: `src/lib/integrations/github/github.ts` (add `listRepoPullRequests`)
- Create: `src/lib/change-events/import-pull-requests.ts`
- Modify: `src/app/(dashboard)/change-events/import-actions.ts` (add `listImportablePullRequests`, `importPullRequests`)
- Test: `tests/lib/change-events/import-pull-requests.test.ts`, and a `listRepoPullRequests` filter test (co-located or in a github lib test)

**Interfaces:**
- Produces:
  - `listRepoPullRequests(installationId, repoFullName, base, opts?): Promise<RepoPullRequest[]>` where `RepoPullRequest = { number; title; body: string | null; url; mergedAt: string | null; authorName: string | null }` — merged PRs only.
  - `importSelectedPullRequests({ tenantId, selections }, deps?): Promise<{ importedCount: number }>` with `PullRequestSelection = { repoId; number; title; body: string | null; url; mergedAt: string | null }`.
  - `listImportablePullRequests({ repoIds, since?, until? }): Promise<{ pullRequests: ImportablePullRequest[] }>`; `importPullRequests({ selections })`.

- [ ] **Step 1: Add `listRepoPullRequests` to the GitHub lib**

In `src/lib/integrations/github/github.ts`, add (mirroring `listRepoCommits`'s octokit setup):

```ts
export type RepoPullRequest = {
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
  authorName: string | null;
};

export async function listRepoPullRequests(
  installationId: string,
  repoFullName: string,
  base: string
): Promise<RepoPullRequest[]> {
  const [owner, repo] = repoFullName.split("/");
  const installationOctokit = await getGithubApp().getInstallationOctokit(Number(installationId));
  // Closed PRs targeting the watched branch, newest-updated first. Only MERGED
  // ones are shipped changes, so filter out closed-unmerged (merged_at null).
  const prs = await installationOctokit.paginate(installationOctokit.rest.pulls.list, {
    owner,
    repo,
    state: "closed",
    base,
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  return prs
    .filter((pr) => pr.merged_at != null)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      body: pr.body ?? null,
      url: pr.html_url,
      mergedAt: pr.merged_at ?? null,
      authorName: pr.user?.login ?? null,
    }));
}
```

- [ ] **Step 2: Write the failing test for the import core**

Create `tests/lib/change-events/import-pull-requests.test.ts`, mirroring `tests/lib/change-events/*` DB conventions (real test DB; enrichment injected; no GitHub fetch needed since PR content is supplied in the selection). Seed a tenant + repo, then:

```ts
// (imports: db, tenants, repos, changeEvents; eq/and; importSelectedPullRequests)
it("imports a merged PR as a pull_request change event with owner/repo#number external id", async () => {
  const { tenant, repo } = await seed(); // inserts tenant + repo githubRepoFullName "acme/x"
  const enrich = vi.fn().mockResolvedValue({ userFacing: true, impactSummary: "Adds X", suggestedCategory: "new", confidence: 0.9 });

  const result = await importSelectedPullRequests(
    {
      tenantId: tenant.id,
      selections: [
        { repoId: repo.id, number: 42, title: "Add X", body: "Does X", url: "https://github.com/acme/x/pull/42", mergedAt: "2026-07-01T00:00:00Z" },
      ],
    },
    { enrich, resolvePending: vi.fn() }
  );

  expect(result.importedCount).toBe(1);
  const [row] = await db.select().from(changeEvents).where(and(eq(changeEvents.repoId, repo.id), eq(changeEvents.prNumber, 42)));
  expect(row.type).toBe("pull_request");
  expect(row.provider).toBe("github");
  expect(row.externalId).toBe("acme/x#42");
  expect(row.prTitle).toBe("Add X");
  expect(row.prUrl).toBe("https://github.com/acme/x/pull/42");
  expect(row.mergedAt).not.toBeNull();
  expect(enrich).toHaveBeenCalledWith(expect.objectContaining({ type: "pull_request", prTitle: "Add X", prDescription: "Does X" }));
});

it("is idempotent: re-importing the same merged PR does not duplicate", async () => {
  const { tenant, repo } = await seed();
  const enrich = vi.fn().mockResolvedValue({ userFacing: false, impactSummary: null, suggestedCategory: null, confidence: 0.1 });
  const sel = { repoId: repo.id, number: 7, title: "T", body: null, url: "https://github.com/acme/x/pull/7", mergedAt: "2026-07-01T00:00:00Z" };
  await importSelectedPullRequests({ tenantId: tenant.id, selections: [sel] }, { enrich, resolvePending: vi.fn() });
  await importSelectedPullRequests({ tenantId: tenant.id, selections: [sel] }, { enrich, resolvePending: vi.fn() });
  const rows = await db.select().from(changeEvents).where(and(eq(changeEvents.repoId, repo.id), eq(changeEvents.prNumber, 7)));
  expect(rows).toHaveLength(1);
});
```

(Model the `seed`/cleanup exactly on an existing `tests/lib/change-events/*` file that inserts tenant + repo.)

- [ ] **Step 3: Run it, verify it fails**

Run: `npm test -- tests/lib/change-events/import-pull-requests.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `importSelectedPullRequests`**

Create `src/lib/change-events/import-pull-requests.ts`, mirroring `import-commits.ts` (read it first). Full new file:

```ts
import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { changeEvents, repos } from "@/db/schema";
import { enrichChangeItem, type EnrichChangeItem } from "@/lib/ai/enrich-change-item";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";
import { mapWithConcurrency } from "@/lib/concurrency";

export type PullRequestSelection = {
  repoId: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
};

const ENRICH_CONCURRENCY = 4;

export async function importSelectedPullRequests(
  input: { tenantId: string; selections: PullRequestSelection[] },
  deps: {
    enrich?: EnrichChangeItem;
    database?: typeof defaultDb;
    resolvePending?: typeof resolvePendingEvents;
  } = {}
): Promise<{ importedCount: number }> {
  const database = deps.database ?? defaultDb;
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
  if (input.selections.length === 0) return { importedCount: 0 };

  const byRepo = new Map<string, PullRequestSelection[]>();
  for (const s of input.selections) {
    const list = byRepo.get(s.repoId) ?? [];
    list.push(s);
    byRepo.set(s.repoId, list);
  }

  let importedCount = 0;
  const resolvableIds: string[] = [];

  for (const [repoId, selections] of byRepo) {
    const [repo] = await database
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.tenantId, input.tenantId)))
      .limit(1);
    if (!repo) continue;

    const inserted = await mapWithConcurrency(selections, ENRICH_CONCURRENCY, async (selection) => {
      const enrichment = await enrich({
        tenantId: input.tenantId,
        type: "pull_request",
        repoName: repo.githubRepoFullName,
        prTitle: selection.title,
        prDescription: selection.body,
      });

      const enrichedFields = {
        prTitle: selection.title,
        prDescription: selection.body,
        prUrl: selection.url,
        mergedAt: selection.mergedAt ? new Date(selection.mergedAt) : null,
        userFacing: enrichment.userFacing,
        impactSummary: enrichment.impactSummary,
        suggestedCategory: enrichment.suggestedCategory,
        enrichmentConfidence: enrichment.confidence,
        enrichedAt: new Date(),
      };

      const upserted = await database
        .insert(changeEvents)
        .values({
          tenantId: input.tenantId,
          repoId: repo.id,
          type: "pull_request",
          provider: "github",
          externalId: `${repo.githubRepoFullName}#${selection.number}`,
          prNumber: selection.number,
          ...enrichedFields,
        })
        .onConflictDoUpdate({
          target: [changeEvents.repoId, changeEvents.prNumber],
          set: { status: "pending", excludedAt: null, excludedBy: null, ...enrichedFields },
          setWhere: eq(changeEvents.status, "excluded"),
        })
        .returning({ id: changeEvents.id });

      return { count: upserted.length, id: upserted[0]?.id, userFacing: enrichment.userFacing };
    });

    importedCount += inserted.reduce((a, b) => a + b.count, 0);
    for (const r of inserted) {
      if (r.count > 0 && r.id && r.userFacing !== false) resolvableIds.push(r.id);
    }
  }

  // `resolvePendingEvents(tenantId, eventIds, deps?)` — positional, matching
  // how `importSelectedCommits` calls it (it does not thread the test db into
  // resolvePending; tests inject a `resolvePending` mock instead).
  if (resolvableIds.length > 0) await resolvePending(input.tenantId, resolvableIds);

  return { importedCount };
}
```

Verified against the codebase: `mapWithConcurrency` lives in `@/lib/concurrency`; `resolvePendingEvents` lives in `@/lib/change-events/pipeline` and takes `(tenantId, eventIds, deps?)`. The `enrich`/`resolvePending` dep names above match this new file's own object-`deps` shape (the PR test injects `{ enrich, resolvePending }`).

- [ ] **Step 5: Run it, verify it passes**

Run: `npm test -- tests/lib/change-events/import-pull-requests.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the PR list/import actions**

In `src/app/(dashboard)/change-events/import-actions.ts`, add (mirroring `listImportableCommits`/`importCommits`):

```ts
export type ImportablePullRequest = {
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
  authorName: string | null;
  imported: boolean;
};

export async function listImportablePullRequests(input: {
  repoIds: string[];
}): Promise<{ pullRequests: ImportablePullRequest[] }> {
  const session = await requireSession();
  if (input.repoIds.length === 0) return { pullRequests: [] };

  const ownedRepos = await db
    .select()
    .from(repos)
    .where(and(eq(repos.tenantId, session.user.tenantId), inArray(repos.id, input.repoIds)));

  const perRepo = await Promise.all(
    ownedRepos.map(async (repo) => {
      let prs;
      try {
        prs = await listRepoPullRequests(repo.githubInstallationId, repo.githubRepoFullName, repo.watchedBranch);
      } catch {
        return [] as ImportablePullRequest[];
      }
      const numbers = prs.map((p) => p.number);
      const existing = numbers.length
        ? await db
            .select({ number: changeEvents.prNumber })
            .from(changeEvents)
            .where(
              and(
                eq(changeEvents.repoId, repo.id),
                inArray(changeEvents.prNumber, numbers),
                ne(changeEvents.status, "excluded")
              )
            )
        : [];
      const importedNumbers = new Set(existing.map((e) => e.number));
      return prs.map((p) => ({
        repoId: repo.id,
        repoFullName: repo.githubRepoFullName,
        number: p.number,
        title: p.title,
        body: p.body,
        url: p.url,
        mergedAt: p.mergedAt,
        authorName: p.authorName,
        imported: importedNumbers.has(p.number),
      }));
    })
  );

  const pullRequests = perRepo.flat().sort((a, b) => {
    const ta = a.mergedAt ? Date.parse(a.mergedAt) : 0;
    const tb = b.mergedAt ? Date.parse(b.mergedAt) : 0;
    return tb - ta;
  });
  return { pullRequests };
}

export async function importPullRequests(input: {
  selections: PullRequestSelection[];
}): Promise<{ importedCount: number }> {
  const session = await requireSession();
  const result = await importSelectedPullRequests({ tenantId: session.user.tenantId, selections: input.selections });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}
```

Add imports: `listRepoPullRequests` from the github lib; `importSelectedPullRequests, type PullRequestSelection` from `@/lib/change-events/import-pull-requests`.

- [ ] **Step 7: Verify + commit**

Run: `npm test -- tests/lib/change-events/import-pull-requests.test.ts` (pass), `npm run typecheck`, `npm run lint` (clean).

```bash
git add src/lib/integrations/github/github.ts src/lib/change-events/import-pull-requests.ts "src/app/(dashboard)/change-events/import-actions.ts" tests/lib/change-events/import-pull-requests.test.ts
git commit -m "feat: import merged pull requests as change events"
```

---

### Task 8: PR import — UI wiring (Feature C, part 2)

**Files:**
- Modify: `src/app/(dashboard)/change-events/import-dialog.tsx`

**Interfaces:**
- Consumes: `EventMultiSelect` (Task 6); `listImportablePullRequests`, `importPullRequests`, `ImportablePullRequest`, `PullRequestSelection` (Task 7).

- [ ] **Step 1: Load PRs when the PR type tab is active**

In `import-dialog.tsx`, add PR state parallel to commits: `const [pullRequests, setPullRequests] = useState<ImportablePullRequest[]>([]);`. Extend the `load` effect so that when `pickerType === "pull_request"` it calls `listImportablePullRequests({ repoIds })` (repo tabs still apply; date filters are commit-only and can be hidden for the PR tab), and when `pickerType === "commit"` it calls `listImportableCommits` as today. Reset `selected` to a new empty `Set` on `pickerType` change (a commit selection and a PR selection can't be imported together).

- [ ] **Step 2: Map the active type's data to `PickerRow[]` and submit accordingly**

Build `rows` from `commits` or `pullRequests` depending on `pickerType`:
- Commit rows: as in Task 6.
- PR row: `key = \`${pr.repoId}#${pr.number}\``, `title = pr.title`, `meta = <>{activeTab === ALL && repo · }{pr.authorName && author · }#{pr.number}{ · merged date}</>`, `externalUrl = pr.url`, `locked = pr.imported`, `badge = pr.imported ? "Imported" : undefined`.

`onImport` branches on `pickerType`: for commits, map selected keys → `CommitSelection[]` and call `importCommits` (as today); for PRs, map selected keys → `PullRequestSelection[]` (via a key→PR lookup) and call `importPullRequests`. Pass `enabledTypes={["commit", "pull_request"]}` to `EventMultiSelect`, and set `submitLabel` to reflect the active type ("Import N commits" / "Import N PRs").

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck`, `npm run lint`, `npm run build` (clean). Manual smoke (recommended): switch to the PRs tab, confirm merged PRs list, select + import, and that they appear as change events.

```bash
git add "src/app/(dashboard)/change-events/import-dialog.tsx"
git commit -m "feat: PR import tab + event-type switcher in the import dialog"
```

---

### Task 9: Multi-select add-to-atomic-update + regenerate (Feature A, part 2)

**Files:**
- Create: `src/lib/change-events/add-events-to-atomic-update.ts`
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` (replace `addEventToAtomicUpdate` with `addEventsToAtomicUpdate`)
- Rewrite: `src/app/(dashboard)/atomic-updates/add-event-picker.tsx` (multi-select via `EventMultiSelect`)
- Modify: `src/app/(dashboard)/atomic-updates/atomic-update-card.tsx` (call the new action from the picker)
- Test: `tests/app/atomic-updates-actions.test.ts` (or a new core test file)

**Interfaces:**
- Produces:
  - `addEventsToExistingAtomicUpdate({ tenantId, userId, atomicUpdateId, eventIds, confirmEmptyDeletion }, deps?): Promise<AddEventsResult>` where the result mirrors `CreateFromEventsResult` but with the target being an existing update.
  - `addEventsToAtomicUpdate(atomicUpdateId: string, eventIds: string[], confirmEmptyDeletion?: boolean): Promise<AddEventsResult>` (server action).

- [ ] **Step 1: Write the failing test for the batch core**

Add to `tests/app/atomic-updates-actions.test.ts` (or a new `tests/lib/change-events/add-events-to-atomic-update.test.ts`), following the DB conventions and injecting `refresh` to avoid the live model:

```ts
it("adds multiple events to an existing open update and regenerates once", async () => {
  const { tenant } = await seedTenant();
  const target = await insertOpenAtomicUpdate(tenant.id, "Target");
  const e1 = await insertUnassignedEvent(tenant.id);
  const e2 = await insertUnassignedEvent(tenant.id);
  const refresh = vi.fn().mockResolvedValue(undefined);

  const result = await addEventsToExistingAtomicUpdate(
    { tenantId: tenant.id, userId: "u1", atomicUpdateId: target.id, eventIds: [e1.id, e2.id] },
    { refresh }
  );

  expect(result.ok).toBe(true);
  const rows = await db.select().from(changeEvents).where(eq(changeEvents.atomicUpdateId, target.id));
  expect(rows.map((r) => r.id).sort()).toEqual([e1.id, e2.id].sort());
  // Regenerated once, over the target (and any surviving sources), not per-event.
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh.mock.calls[0][2]).toContain(target.id);
});

it("returns needsConfirmation naming every source that would be emptied, making no change until confirmed", async () => {
  const { tenant } = await seedTenant();
  const target = await insertOpenAtomicUpdate(tenant.id, "Target");
  const sourceA = await insertOpenAtomicUpdate(tenant.id, "Source A");
  const evA = await insertEventInUpdate(tenant.id, sourceA.id); // sole event of Source A
  const refresh = vi.fn();

  const pending = await addEventsToExistingAtomicUpdate(
    { tenantId: tenant.id, userId: "u1", atomicUpdateId: target.id, eventIds: [evA.id] },
    { refresh }
  );
  expect(pending.ok).toBe(false);
  expect(pending).toMatchObject({ needsConfirmation: true, emptiedAtomicUpdates: [{ id: sourceA.id, title: "Source A" }] });
  // No mutation yet.
  const [still] = await db.select().from(changeEvents).where(eq(changeEvents.id, evA.id));
  expect(still.atomicUpdateId).toBe(sourceA.id);
  expect(refresh).not.toHaveBeenCalled();

  const confirmed = await addEventsToExistingAtomicUpdate(
    { tenantId: tenant.id, userId: "u1", atomicUpdateId: target.id, eventIds: [evA.id], confirmEmptyDeletion: true },
    { refresh }
  );
  expect(confirmed.ok).toBe(true);
});

it("rejects adding to a target that is not open (released/hidden) or not owned", async () => {
  const { tenant } = await seedTenant();
  const released = await insertAtomicUpdate(tenant.id, { status: "released" });
  const e1 = await insertUnassignedEvent(tenant.id);
  const res = await addEventsToExistingAtomicUpdate(
    { tenantId: tenant.id, userId: "u1", atomicUpdateId: released.id, eventIds: [e1.id] },
    { refresh: vi.fn() }
  );
  expect(res.ok).toBe(false);
});
```

(Reuse/extend whatever seed helpers `tests/app/atomic-updates-actions.test.ts` already has; add small inserters if missing.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npm test -- tests/app/atomic-updates-actions.test.ts`
Expected: FAIL (function not defined).

- [ ] **Step 3: Implement the batch core**

Create `src/lib/change-events/add-events-to-atomic-update.ts`, modeled on `create-from-events.ts` (read it first) but targeting an existing open update. Full new file:

```ts
import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { refreshAtomicUpdates } from "@/lib/ai/regenerate-atomic-summary";
import { cleanupOrTouch } from "./reassign";

type Database = typeof defaultDb;

export type AddEventsInput = {
  tenantId: string;
  userId: string;
  atomicUpdateId: string;
  eventIds: string[];
  confirmEmptyDeletion?: boolean;
};

type AddEventsDeps = {
  database?: Database;
  refresh?: (database: Database, tenantId: string, atomicUpdateIds: string[]) => Promise<void>;
};

export type AddEventsSuccess = { ok: true; deletedAtomicUpdates?: { id: string; title: string }[] };
export type AddEventsRejection = { ok: false; reason: string };
export type AddEventsNeedsConfirmation = {
  ok: false;
  reason: "needs_confirmation";
  needsConfirmation: true;
  emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[];
};
export type AddEventsResult = AddEventsSuccess | AddEventsRejection | AddEventsNeedsConfirmation;

/**
 * Batched "add these events to THIS existing open atomic update", the
 * multi-select sibling of `createAtomicUpdateFromEvents` (which creates a new
 * update). Reuses `cleanupOrTouch` from `reassign.ts`. All moves happen in one
 * transaction; a single `now` deterministically bumps `updatedAt` on the
 * target and every surviving source (this is what fires a draft's catch-up
 * delta reliably). Summary regeneration runs best-effort AFTER commit and is
 * FORCED — the target's (and surviving sources') `summaryEditedAt` freeze is
 * cleared first, so adding evidence overrides a prior hand-edit.
 *
 * If moving events out of their open source update(s) would empty any, they
 * are not silently deleted: unless `confirmEmptyDeletion`, no mutation happens
 * and `needsConfirmation` lists every source that would be emptied. Any
 * selected event currently in a `released` update freezes the whole batch. The
 * target must exist, be owned by the tenant, and be `open`.
 */
export async function addEventsToExistingAtomicUpdate(
  input: AddEventsInput,
  deps: AddEventsDeps = {}
): Promise<AddEventsResult> {
  const database = deps.database ?? defaultDb;
  const refresh = deps.refresh ?? refreshAtomicUpdates;
  const { tenantId, atomicUpdateId, eventIds, confirmEmptyDeletion } = input;

  type TxOutcome =
    | { ok: true; affectedIds: string[]; deletedAtomicUpdates: { id: string; title: string }[] }
    | AddEventsRejection
    | AddEventsNeedsConfirmation;

  const outcome = await database.transaction(async (tx): Promise<TxOutcome> => {
    const now = new Date();

    const requestedIds = Array.from(new Set(eventIds));
    if (requestedIds.length === 0) return { ok: false, reason: "No change events selected." };

    // Target must exist, be owned, and be open.
    const [target] = await tx
      .select({ id: atomicUpdates.id, status: atomicUpdates.status })
      .from(atomicUpdates)
      .where(and(eq(atomicUpdates.id, atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
      .limit(1);
    if (!target) return { ok: false, reason: "Atomic update not found." };
    if (target.status !== "open") return { ok: false, reason: "Can only add events to an open atomic update." };

    const events = await tx
      .select()
      .from(changeEvents)
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));
    if (events.length < requestedIds.length) return { ok: false, reason: "One or more change events were not found." };

    // Source updates = the events' current updates, excluding the target itself.
    const sourceAtomicUpdateIds = Array.from(
      new Set(
        events
          .map((e) => e.atomicUpdateId)
          .filter((id): id is string => id !== null && id !== atomicUpdateId)
      )
    );
    const sourceAtomics =
      sourceAtomicUpdateIds.length > 0
        ? await tx
            .select({ id: atomicUpdates.id, status: atomicUpdates.status, title: atomicUpdates.title, releaseId: atomicUpdates.releaseId })
            .from(atomicUpdates)
            .where(and(inArray(atomicUpdates.id, sourceAtomicUpdateIds), eq(atomicUpdates.tenantId, tenantId)))
        : [];
    const sourceById = new Map(sourceAtomics.map((s) => [s.id, s]));

    const releasedSource = sourceAtomics.find((s) => s.status === "released");
    if (releasedSource) {
      return { ok: false, reason: `Cannot move an event out of the published atomic update "${releasedSource.title}".` };
    }

    const eventIdSet = new Set(events.map((e) => e.id));
    const openSourceIds = sourceAtomics.filter((s) => s.status === "open").map((s) => s.id);

    const emptiedAtomicUpdates: { id: string; title: string; inDraft: boolean }[] = [];
    for (const sourceId of openSourceIds) {
      const remaining = await tx.select({ id: changeEvents.id }).from(changeEvents).where(eq(changeEvents.atomicUpdateId, sourceId));
      const remainingOutsideBatch = remaining.filter((r) => !eventIdSet.has(r.id));
      if (remainingOutsideBatch.length === 0) {
        const source = sourceById.get(sourceId)!;
        emptiedAtomicUpdates.push({ id: source.id, title: source.title, inDraft: source.releaseId !== null });
      }
    }
    if (emptiedAtomicUpdates.length > 0 && confirmEmptyDeletion !== true) {
      return { ok: false, reason: "needs_confirmation", needsConfirmation: true, emptiedAtomicUpdates };
    }

    await tx
      .update(changeEvents)
      .set({ atomicUpdateId, status: "pending", excludedAt: null, excludedBy: null })
      .where(and(inArray(changeEvents.id, requestedIds), eq(changeEvents.tenantId, tenantId)));

    await tx.update(atomicUpdates).set({ updatedAt: now }).where(eq(atomicUpdates.id, atomicUpdateId));

    const affectedIds: string[] = [atomicUpdateId];
    const deletedAtomicUpdates: { id: string; title: string }[] = [];
    for (const sourceId of openSourceIds) {
      const { survived } = await cleanupOrTouch(tx, tenantId, sourceId, now);
      if (survived) affectedIds.push(sourceId);
      else deletedAtomicUpdates.push({ id: sourceById.get(sourceId)!.id, title: sourceById.get(sourceId)!.title });
    }

    return { ok: true, affectedIds, deletedAtomicUpdates };
  });

  if (!outcome.ok) return outcome;

  // Force regeneration: clear the hand-edit freeze on every affected open
  // update so the best-effort refresh below actually regenerates them
  // (refreshAtomicUpdates skips frozen ones). Evidence changes override a
  // prior manual edit.
  await database
    .update(atomicUpdates)
    .set({ summaryEditedAt: null })
    .where(and(inArray(atomicUpdates.id, outcome.affectedIds), eq(atomicUpdates.tenantId, tenantId), eq(atomicUpdates.status, "open")));

  try {
    await refresh(database, tenantId, outcome.affectedIds);
  } catch (error) {
    console.error("[add-events-to-atomic-update] best-effort summary regen failed:", error);
  }

  return { ok: true, deletedAtomicUpdates: outcome.deletedAtomicUpdates };
}
```

Before implementing, confirm `cleanupOrTouch`'s exact exported signature in `reassign.ts` (it is used the same way by `create-from-events.ts`) and that `summaryEditedAt` is the freeze column name on `atomicUpdates`.

- [ ] **Step 4: Run it, verify it passes**

Run: `npm test -- tests/app/atomic-updates-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the action `addEventToAtomicUpdate` → `addEventsToAtomicUpdate`**

In `atomic-updates/actions.ts`, remove `addEventToAtomicUpdate` and add:

```ts
export async function addEventsToAtomicUpdate(
  atomicUpdateId: string,
  eventIds: string[],
  confirmEmptyDeletion?: boolean
): Promise<AddEventsResult> {
  const session = await requireSession();
  const result = await addEventsToExistingAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId,
    eventIds,
    confirmEmptyDeletion,
  });
  revalidatePath("/atomic-updates");
  return result;
}
```

Import `addEventsToExistingAtomicUpdate, type AddEventsResult` from `@/lib/change-events/add-events-to-atomic-update`. Keep `removeEventFromAtomicUpdate` unchanged.

- [ ] **Step 6: Rewrite the add picker as multi-select**

Rewrite `atomic-updates/add-event-picker.tsx` to use `EventMultiSelect` inside a `Dialog`: hold `selected: Set<string>` (keys = event ids), `pickerType` (`"commit" | "pull_request"`, default "commit"), `search`, and map the `events` prop (filtered by active type) to `PickerRow[]` (`key = event.id`, `title = event.title`, `meta = TYPE_LABEL · PROVIDER_LABEL`, `externalUrl = event.externalUrl`, `badge = event.atomicUpdateTitle ?? "Unassigned"`). On submit, call `addEventsToAtomicUpdate(atomicUpdateId, Array.from(selected))` inside a `useTransition`; on `needsConfirmation`, open the existing confirm dialog listing `emptiedAtomicUpdates` and re-submit with `confirmEmptyDeletion=true`; on `ok`, toast (naming any `deletedAtomicUpdates`) and close. `submitLabel` = idle `Add ${selected.size} event(s)` and, while pending, `"Regenerating…"` (reflecting the regeneration on submit). `enabledTypes={["commit","pull_request"]}`; no `filtersSlot` (no repo tabs/date filters). Reset `selected` on type change.

- [ ] **Step 7: Update the card to pass the multi-select picker**

In `atomic-updates/atomic-update-card.tsx`, the existing `addableEvents` prop already excludes events on this update; keep passing it. Ensure the picker is invoked with `atomicUpdateId={row.id}` and `events={addableEvents}` (unchanged prop shape). Remove any now-dead single-add wiring.

- [ ] **Step 8: Verify + commit**

Run: `npm test -- tests/app/atomic-updates-actions.test.ts` (pass), `npm run typecheck`, `npm run lint`, `npm run build` (clean). Confirm no remaining references to `addEventToAtomicUpdate`: `grep -rn "addEventToAtomicUpdate\b" src` returns nothing.

```bash
git add src/lib/change-events/add-events-to-atomic-update.ts "src/app/(dashboard)/atomic-updates/actions.ts" "src/app/(dashboard)/atomic-updates/add-event-picker.tsx" "src/app/(dashboard)/atomic-updates/atomic-update-card.tsx" tests/app/atomic-updates-actions.test.ts
git commit -m "feat: multi-select add-to-atomic-update with a single regeneration"
```

---

## Self-Review

**1. Spec coverage:**
- F (Publish CTA) + G (Release history) → Task 1. ✓
- E (open-drafts counter) → Task 2. ✓
- H (avatar + logout) → Task 3. ✓
- D (optional webhook secret) → Task 4 (schema + migration + form + action + deliver + tests). ✓
- B (GitHub → Integrations) → Task 5 (+ setup redirect). ✓
- A (unified picker) → Task 6 (shared component) + Task 9 (multi-add + regenerate). ✓
- C (PR import) → Task 7 (server) + Task 8 (UI + type switcher). ✓
- Non-goals preserved: Task tab disabled-only; `publishDraft` untouched; repo/date filters import-only; secret can't be cleared (noted). ✓

**2. Placeholder scan:** No TBD/TODO. Mirror-tasks (7, 9) reference existing files to read AND supply the full new-file code. UI-wiring steps (6.2, 8) describe exact mappings rather than restating unchanged dialog shell code, which the implementer edits in place.

**3. Type consistency:** `EventMultiSelect` props/`PickerType`/`PickerRow` defined in Task 6 and consumed unchanged in Tasks 8 and 9. `PullRequestSelection`/`ImportablePullRequest` defined in Task 7 and consumed in Task 8. `addEventsToExistingAtomicUpdate`/`AddEventsResult` defined in Task 9 core and consumed by the action in the same task. `addEventToAtomicUpdate` is removed (Task 9) and no task references it afterward. `listRepoPullRequests` signature matches its Task 7 call site.
