# shadcn/ui Adoption Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt shadcn/ui across the whole dashboard, replacing the bare grayscale Tailwind UI with shadcn components on every page — **behavior-preserving** (same routes, Server Actions, data, and form field names; only presentation changes).

**Architecture:** Initialize shadcn/ui (Tailwind v4 / React 19 path) into the existing Next 16 App Router app. Convert each page's markup to shadcn components. Server Components stay the default for data pages; mutations stay plain Server Actions bound to `<form action={…}>`. shadcn's interactive primitives (Dialog, DropdownMenu, Select) are Client Components — this phase **relaxes the MVP's "no client JS / exactly one Client Component" constraint**. Radix form controls (Select/Checkbox) submit inside Server-Action forms via their `name` prop; the free-text inputs, native checkboxes, and native `<select>`s that must keep working unchanged are converted only where the shadcn equivalent preserves form submission.

**Tech Stack:** shadcn/ui (CLI latest), Radix UI primitives, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, Tailwind v4, React 19, Next 16.

## Global Constraints

- **Behavior-preserving.** The existing automated suite (66 tests across 21 files) MUST pass unchanged after every task — this phase touches only `.tsx` presentation and shadcn config, never `src/lib/**`, `src/db/**`, Server Action logic, route handlers, or any `*.test.ts`.
- **Neutral/grayscale only.** shadcn is initialized with the **`neutral`** base color. Do NOT introduce any brand accent color. Light mode only (no dark-mode work in this phase).
- **Form field names are frozen.** Every `name="…"` on an input/select/checkbox/hidden field MUST stay identical (Server Actions and `parseRepoSelections`'s `repo-N-*` convention depend on them).
- **Keep Server-Action forms working.** Any control inside a `<form action={serverAction}>` must still submit its value. Use shadcn `Input`/`Textarea`/`Button`/`Label` (they render native elements) freely. For dropdowns, use shadcn `Select` with a `name` prop (Radix renders a hidden native select for form submission). Keep native `<input type="checkbox">` elements as-is (restyled with classes) — do NOT swap them for Radix Checkbox in this phase, to avoid form-value regressions.
- **Local dev DB:** Docker Postgres container `product-announcer-postgres` on host port **5434**; `.env.local` `DATABASE_URL` points at 5434. Tests need it running.
- TypeScript strict; `tsc --noEmit` and `npm run build` must be clean after each task.

---

### Task 1: Initialize shadcn/ui and install the component set

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/components/ui/*` (generated), `src/hooks/*` (if generated)
- Modify: `src/app/globals.css` (shadcn tokens), `package.json` / `package-lock.json` (deps)

**Interfaces:**
- Produces: the `cn` helper at `@/lib/utils`, and the shadcn components under `@/components/ui/` — every later task imports these.

- [ ] **Step 1: Run the shadcn initializer (non-interactive)**

Run it non-interactively so it can't hang on a prompt:
```bash
npx shadcn@latest init --base-color neutral --yes
```
If your CLI version rejects those flags, fall back to `npx shadcn@latest init -b neutral -y`, and only if it still prompts, answer base color = **Neutral** and accept the defaults for everything else. The CLI detects Tailwind v4 + the `@/*` alias and writes `components.json`, creates `src/lib/utils.ts` (exports `cn`), rewrites `src/app/globals.css` with the design tokens + `@theme inline` mapping + a base layer, and installs `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, and the v4 animation helper.

Expected: `components.json` exists and `src/lib/utils.ts` exports `cn`. Verify:
```bash
test -f components.json && grep -q "export function cn" src/lib/utils.ts && echo OK
```

- [ ] **Step 2: Confirm the base layer applies the theme and preserves the Geist font**

Open `src/app/globals.css`. Ensure the base layer applies the theme to the body:
```css
@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```
Remove any leftover hard-coded `body { font-family: Arial, Helvetica, sans-serif; }` rule from the old file if the initializer left it — the app's font comes from `next/font` (Geist) applied in `src/app/layout.tsx`, and shadcn's tokens shouldn't override it with Arial.

Expected: no `font-family: Arial` remains in `globals.css`.

- [ ] **Step 3: Install the components used across the app**

Run (the `add` command is non-interactive once `components.json` exists and auto-installs any missing Radix deps):
```bash
npx shadcn@latest add --yes button input textarea label card table dialog badge select separator dropdown-menu command popover
```
Expected: files appear under `src/components/ui/` (`button.tsx`, `input.tsx`, `textarea.tsx`, `label.tsx`, `card.tsx`, `table.tsx`, `dialog.tsx`, `badge.tsx`, `select.tsx`, `separator.tsx`, `dropdown-menu.tsx`, `command.tsx`, `popover.tsx`). (`command` + `popover` back the Phase-2 Combobox; installing now completes adoption.)

- [ ] **Step 4: Verify the app still builds and tests still pass**

```bash
npx tsc --noEmit
npm run build
npx vitest run
```
Expected: `tsc` clean; `✓ Compiled successfully`; `Tests 66 passed (66)`. No page markup changed yet — this proves the shadcn install didn't break anything.

- [ ] **Step 5: Commit**

```bash
git add components.json src/lib/utils.ts src/components src/app/globals.css package.json package-lock.json
git commit -m "$(cat <<'EOF'
Initialize shadcn/ui (neutral base) and install the component set

Tailwind-v4 / React-19 shadcn init: components.json, the cn helper, the
design tokens in globals.css, and the button/input/textarea/label/card/
table/dialog/badge/select/separator/dropdown-menu/command/popover
components. No page markup changed yet; the full suite still passes.
EOF
)"
```

---

### Task 2: Re-skin the dashboard shell (sidebar layout)

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`

**Interfaces:**
- Consumes: `Button` (`@/components/ui/button`), `DropdownMenu*` (`@/components/ui/dropdown-menu`), `Separator` (`@/components/ui/separator`), `cn` (`@/lib/utils`).

- [ ] **Step 1: Replace the layout with shadcn primitives**

The workspace-name `<details>/<summary>` dropdown becomes a shadcn **DropdownMenu**; nav links become `Button`-styled links (`variant="ghost"`). Replace the entire file `src/app/(dashboard)/layout.tsx`:
```tsx
import Link from "next/link";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { href: "/pending", label: "Pending" },
  { href: "/drafts", label: "Drafts" },
  { href: "/history", label: "History" },
  { href: "/integrations", label: "Integrations" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  if (!complete) redirect("/onboarding");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-1 border-r p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="w-full justify-between font-semibold">
              {tenant?.name ?? "Workspace"}
              <ChevronsUpDown className="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[13rem]">
            <DropdownMenuItem asChild>
              <Link href="/settings">Settings</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator className="my-2" />

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Button key={item.href} asChild variant="ghost" className="justify-start font-normal">
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ))}
        </nav>

        <div className="mt-auto px-2 pt-3 text-xs text-muted-foreground">{session.user.email}</div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
```
Note: `DropdownMenu` is a Client Component (Radix) — allowed in this phase. Settings stays inside the dropdown (not the flat nav); the flat nav is Pending/Drafts/History/Integrations, unchanged.

- [ ] **Step 2: Verify build + tests**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully`; `66 passed`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/layout.tsx"
git commit -m "Re-skin dashboard sidebar with shadcn DropdownMenu + Button nav"
```

---

### Task 3: Re-skin the Drafts queue (list, detail, and the preview Dialog)

**Files:**
- Modify: `src/app/(dashboard)/drafts/page.tsx`, `src/app/(dashboard)/drafts/[updateId]/page.tsx`, `src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx`

**Interfaces:**
- Consumes: `Button`, `Card*`, `Input`, `Textarea`, `Label`, `Badge`, `Dialog*`, `Select*`.
- Produces: the `PreviewDialog` client component, now built on shadcn `Dialog` (open/close state only), same props `{ updateId, title, body, category, onApprove }`.

- [ ] **Step 1: Rebuild `PreviewDialog` on shadcn `Dialog`**

Replace `src/app/(dashboard)/drafts/[updateId]/preview-dialog.tsx`:
```tsx
"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function PreviewDialog({
  updateId,
  title,
  body,
  category,
  onApprove,
}: {
  updateId: string;
  title: string;
  body: string;
  category: string;
  onApprove: (formData: FormData) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Preview</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Badge variant="secondary" className="uppercase">
            {category}
          </Badge>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{body}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
          <form action={onApprove}>
            <input type="hidden" name="updateId" value={updateId} />
            <Button type="submit">Approve &amp; publish</Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
Behavior is identical: open/close via the Dialog, `Approve & publish` submits the `onApprove` Server Action with the `updateId` hidden field.

- [ ] **Step 2: Re-skin the drafts list**

Replace `src/app/(dashboard)/drafts/page.tsx`:
```tsx
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await db
    .select()
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "draft")));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Drafts</h1>
      <div className="space-y-2">
        {drafts.map((d) => (
          <Card key={d.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <Link href={`/drafts/${d.id}`} className="font-medium hover:underline">
                {d.title}
              </Link>
              <Badge variant="secondary">{d.category}</Badge>
            </CardContent>
          </Card>
        ))}
        {drafts.length === 0 && <p className="text-sm text-muted-foreground">No drafts waiting for review.</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Re-skin the draft detail (edit form + reject)**

Replace `src/app/(dashboard)/drafts/[updateId]/page.tsx`. The category dropdown becomes a shadcn `Select` with `name="category"` (Radix submits it via a hidden native select):
```tsx
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveDraft, approveDraft, rejectDraft } from "../actions";
import { PreviewDialog } from "./preview-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function DraftDetailPage({ params }: { params: Promise<{ updateId: string }> }) {
  const session = await requireSession();
  const { updateId } = await params;

  const [update] = await db
    .select()
    .from(updates)
    .where(and(eq(updates.id, updateId), eq(updates.tenantId, session.user.tenantId)));

  if (!update) notFound();

  return (
    <div className="space-y-8">
      <form action={saveDraft} className="max-w-lg space-y-4">
        <input type="hidden" name="updateId" value={update.id} />
        <div className="space-y-2">
          <Label htmlFor="title">Title</Label>
          <Input id="title" name="title" defaultValue={update.title} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="body">Body</Label>
          <Textarea id="body" name="body" defaultValue={update.body} rows={8} />
        </div>
        <div className="space-y-2">
          <Label>Category</Label>
          <Select name="category" defaultValue={update.category}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="improved">Improved</SelectItem>
              <SelectItem value="fixed">Fixed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Save changes
        </Button>
      </form>

      <div className="flex items-center gap-4">
        <PreviewDialog
          updateId={update.id}
          title={update.title}
          body={update.body}
          category={update.category}
          onApprove={approveDraft}
        />
        <form action={rejectDraft}>
          <input type="hidden" name="updateId" value={update.id} />
          <Button type="submit" variant="ghost" className="text-muted-foreground">
            Reject
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify build + tests**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully`; `66 passed`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/drafts"
git commit -m "$(cat <<'EOF'
Re-skin Drafts with shadcn; move preview from <dialog> to shadcn Dialog

The preview modal is now a shadcn Dialog (still open/close state only);
Approve & publish / Reject / Save stay Server-Action forms. Category is a
shadcn Select with name="category" so it still submits.
EOF
)"
```

---

### Task 4: Re-skin History and Integrations

**Files:**
- Modify: `src/app/(dashboard)/history/page.tsx`, `src/app/(dashboard)/integrations/page.tsx`

**Interfaces:**
- Consumes: `Table*`, `Badge`, `Card*`, `Button`, `Input`, `Label`.

- [ ] **Step 1: Re-skin History (shadcn Table)**

Replace `src/app/(dashboard)/history/page.tsx`:
```tsx
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { updates } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function HistoryPage() {
  const session = await requireSession();
  const sentUpdates = await db
    .select()
    .from(updates)
    .where(and(eq(updates.tenantId, session.user.tenantId), eq(updates.status, "published")))
    .orderBy(desc(updates.publishedAt));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">History</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Sent</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sentUpdates.map((u) => (
            <TableRow key={u.id}>
              <TableCell>{u.title}</TableCell>
              <TableCell>
                <Badge variant="secondary">{u.category}</Badge>
              </TableCell>
              <TableCell>{u.publishedAt?.toLocaleDateString()}</TableCell>
            </TableRow>
          ))}
          {sentUpdates.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                No announcements sent yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Re-skin Integrations**

Replace `src/app/(dashboard)/integrations/page.tsx`. The `active` checkbox stays native (restyled) to preserve `active === "on"` parsing:
```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveWebhookConfig } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const COMING_SOON = ["Webflow", "Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];

export default async function IntegrationsPage() {
  const session = await requireSession();
  const [config] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.tenantId, session.user.tenantId));

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">Integrations</h1>
        <Card className="max-w-lg">
          <CardHeader>
            <CardTitle>Generic Webhook</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveWebhookConfig} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="url">URL</Label>
                <Input id="url" type="url" name="url" defaultValue={config?.url ?? ""} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="secret">Secret</Label>
                <Input id="secret" type="text" name="secret" defaultValue={config?.secret ?? ""} required />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={config?.active ?? true}
                  className="size-4 rounded border-input"
                />
                Active
              </label>
              <Button type="submit" variant="outline">
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Coming soon</h2>
        <div className="flex flex-wrap gap-2">
          {COMING_SOON.map((name) => (
            <Badge key={name} variant="outline" className="opacity-60">
              {name}
            </Badge>
          ))}
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Verify build + tests**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully`; `66 passed`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/history" "src/app/(dashboard)/integrations"
git commit -m "Re-skin History (shadcn Table) and Integrations (shadcn Card/Input/Badge)"
```

---

### Task 5: Re-skin Onboarding, Pending, and Settings

**Files:**
- Modify: `src/app/onboarding/page.tsx`, `src/app/(dashboard)/pending/page.tsx`, `src/app/(dashboard)/pending/schedule-choice/page.tsx`, `src/app/(dashboard)/settings/page.tsx`

**Interfaces:**
- Consumes: `Button`, `Card*`, `Input`, `Label`, `Select*`, `Badge`.

Note: these three pages are behaviorally rewritten in Phase 2 (workspace batching + branch picker); here we only bring them onto shadcn so nothing looks orphaned mid-migration. Keep every `name`, hidden field, cadence-`<select>` value set, and the `repo-N-*` picker fields identical — Phase 2 relies on them. Cadence dropdowns become shadcn `Select` with `name`; the repo-select checkboxes and free-text branch inputs stay native here (Phase 2 replaces the branch input with the Combobox).

- [ ] **Step 1: Re-skin onboarding**

Replace `src/app/onboarding/page.tsx` (keep all actions, the gate, and the graceful GitHub-App degrade exactly; only the markup changes):
```tsx
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { repos, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos } from "@/lib/github";
import { isOnboardingComplete } from "@/lib/onboarding";
import { addOnboardingRepos, saveOnboardingSchedule, skipOnboarding, saveWorkspaceName } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function OnboardingPage() {
  const session = await requireSession();
  if (await isOnboardingComplete(session.user.tenantId)) redirect("/pending");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|onboarding` });
    } catch {
      installUrl = null;
    }
  }

  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const watchedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));

  return (
    <main className="mx-auto max-w-lg space-y-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Set up Product Announcer</h1>
        <form action={skipOnboarding}>
          <Button type="submit" variant="ghost" className="text-muted-foreground">
            Skip for now
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Name your workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveWorkspaceName} className="flex gap-2">
            <Input name="name" defaultValue={tenant?.name ?? ""} className="flex-1" />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className={tenant?.githubInstallationId ? "opacity-60" : ""}>
        <CardHeader>
          <CardTitle>2. Connect GitHub</CardTitle>
        </CardHeader>
        <CardContent>
          {tenant?.githubInstallationId ? (
            <p className="text-sm">Connected.</p>
          ) : installUrl ? (
            <Button asChild variant="outline">
              <a href={installUrl}>Connect GitHub</a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">GitHub integration isn&apos;t configured yet.</p>
          )}
        </CardContent>
      </Card>

      {tenant?.githubInstallationId && tenantRepos.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>3. Select repos to watch</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={addOnboardingRepos} className="space-y-3">
              <input type="hidden" name="repoCount" value={accessibleRepos.length} />
              {accessibleRepos.map((repo, i) => (
                <div key={repo.fullName} className="flex items-center gap-3">
                  <input type="hidden" name={`repo-${i}-fullName`} value={repo.fullName} />
                  <label className="flex flex-1 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`repo-${i}-selected`}
                      defaultChecked={watchedFullNames.has(repo.fullName)}
                      className="size-4 rounded border-input"
                    />
                    {repo.fullName}
                  </label>
                  <Input
                    name={`repo-${i}-branch`}
                    defaultValue={repo.defaultBranch}
                    className="w-36"
                  />
                </div>
              ))}
              {accessibleRepos.length === 0 && (
                <p className="text-sm text-muted-foreground">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Add selected repos
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {tenantRepos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>4. Set your schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveOnboardingSchedule} className="space-y-4">
              <div className="space-y-2">
                <Label>Cadence</Label>
                <Select name="cadence" defaultValue="weekly">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="none">No fixed cadence (threshold only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="threshold">Or after at least this many changes</Label>
                <Input id="threshold" type="number" name="threshold" min={1} defaultValue={5} />
              </div>
              <Button type="submit" variant="outline">
                Finish setup
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
```

- [ ] **Step 2: Re-skin the Pending page and its schedule-choice page**

Replace `src/app/(dashboard)/pending/page.tsx` (logic identical — repo switcher, per-repo config, Run now, Drop — only markup changes to shadcn):
```tsx
import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { dropChangeItem, runNow } from "./actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function PendingPage({
  searchParams,
}: {
  searchParams: Promise<{ repoId?: string }>;
}) {
  const session = await requireSession();
  const { repoId: requestedRepoId } = await searchParams;

  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  if (tenantRepos.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">No repos connected yet</h1>
        <p className="text-sm text-muted-foreground">
          Onboarding was skipped without connecting a repo. Add one from{" "}
          <Link href="/settings" className="font-medium underline">
            Settings
          </Link>{" "}
          to start collecting changes.
        </p>
      </div>
    );
  }

  const activeRepo = tenantRepos.find((r) => r.id === requestedRepoId) ?? tenantRepos[0];

  const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, activeRepo.id));
  const pending = await getPendingChangeItems(activeRepo.id);

  return (
    <div className="space-y-6">
      {tenantRepos.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {tenantRepos.map((r) => (
            <Button key={r.id} asChild variant={r.id === activeRepo.id ? "secondary" : "ghost"} size="sm">
              <Link href={`/pending?repoId=${r.id}`}>{r.githubRepoFullName}</Link>
            </Button>
          ))}
        </div>
      )}

      <div>
        <h1 className="text-xl font-semibold">
          {activeRepo.githubRepoFullName}{" "}
          <span className="text-sm text-muted-foreground">({activeRepo.watchedBranch})</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Next scheduled update:{" "}
          {config?.nextScheduledAt ? config.nextScheduledAt.toLocaleString() : "not scheduled"}
          {" · "}Threshold: {config?.threshold ?? "none"}
        </p>
      </div>

      <form action={runNow}>
        <input type="hidden" name="repoId" value={activeRepo.id} />
        <Button type="submit" disabled={pending.length === 0}>
          Run now ({pending.length} pending)
        </Button>
      </form>

      <div className="space-y-2">
        {pending.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <span>{item.sourceType === "pr" ? item.prTitle : item.commitMessage}</span>
              <form action={dropChangeItem}>
                <input type="hidden" name="changeItemId" value={item.id} />
                <input type="hidden" name="repoId" value={activeRepo.id} />
                <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                  Drop
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
        {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
      </div>
    </div>
  );
}
```

Replace `src/app/(dashboard)/pending/schedule-choice/page.tsx`:
```tsx
import { chooseSchedule } from "../actions";
import { Button } from "@/components/ui/button";

export default async function ScheduleChoicePage({
  searchParams,
}: {
  searchParams: Promise<{ repoId: string }>;
}) {
  const { repoId } = await searchParams;

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-xl font-semibold">Update generated</h1>
      <p className="text-sm text-muted-foreground">
        Keep the next scheduled update as planned, or skip it since you just ran one manually?
      </p>
      <div className="flex gap-3">
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="keep" />
          <Button type="submit" variant="outline">
            Keep next scheduled update
          </Button>
        </form>
        <form action={chooseSchedule}>
          <input type="hidden" name="repoId" value={repoId} />
          <input type="hidden" name="choice" value="skip" />
          <Button type="submit" variant="outline">
            Skip it
          </Button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Re-skin Settings**

Replace `src/app/(dashboard)/settings/page.tsx` (logic identical; markup to shadcn; keep the `repo-N-*` picker fields native and every cadence-`<select>` becomes a shadcn `Select` with `name`):
```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos } from "@/lib/github";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { saveWorkspaceName, saveBrandProfile, saveRepoSchedule, addSettingsRepos } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function SettingsPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const tenantSchedules = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));

  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|settings` });
    } catch {
      installUrl = null;
    }
  }
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const watchedBranchByFullName = new Map(tenantRepos.map((r) => [r.githubRepoFullName, r.watchedBranch]));

  return (
    <div className="space-y-8">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Workspace name</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveWorkspaceName} className="flex gap-2">
            <Input name="name" defaultValue={tenant?.name ?? ""} className="flex-1" />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>GitHub repos</CardTitle>
        </CardHeader>
        <CardContent>
          {!tenant?.githubInstallationId ? (
            installUrl ? (
              <Button asChild variant="outline">
                <a href={installUrl}>Connect GitHub</a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">GitHub integration isn&apos;t configured yet.</p>
            )
          ) : (
            <form action={addSettingsRepos} className="space-y-3">
              <input type="hidden" name="repoCount" value={accessibleRepos.length} />
              {accessibleRepos.map((repo, i) => (
                <div key={repo.fullName} className="flex items-center gap-3">
                  <input type="hidden" name={`repo-${i}-fullName`} value={repo.fullName} />
                  <label className="flex flex-1 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`repo-${i}-selected`}
                      defaultChecked={watchedBranchByFullName.has(repo.fullName)}
                      className="size-4 rounded border-input"
                    />
                    {repo.fullName}
                  </label>
                  <Input
                    name={`repo-${i}-branch`}
                    defaultValue={watchedBranchByFullName.get(repo.fullName) ?? repo.defaultBranch}
                    className="w-36"
                  />
                </div>
              ))}
              {accessibleRepos.length === 0 && (
                <p className="text-sm text-muted-foreground">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Save repo selection
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Brand profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveBrandProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tone">Tone</Label>
              <Input id="tone" name="tone" defaultValue={brandProfile.tone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="readingLevel">Reading level</Label>
              <Input id="readingLevel" name="readingLevel" defaultValue={brandProfile.readingLevel ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Input id="industry" name="industry" defaultValue={brandProfile.industry ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="userPersonas">User personas (comma-separated)</Label>
              <Input id="userPersonas" name="userPersonas" defaultValue={brandProfile.userPersonas.join(", ")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doList">Do (comma-separated)</Label>
              <Input id="doList" name="doList" defaultValue={brandProfile.doList.join(", ")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dontList">Don&apos;t (comma-separated)</Label>
              <Input id="dontList" name="dontList" defaultValue={brandProfile.dontList.join(", ")} />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Schedule per repo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {tenantRepos.map((repo) => {
            const config = tenantSchedules.find((s) => s.repoId === repo.id);
            return (
              <form key={repo.id} action={saveRepoSchedule} className="space-y-3 rounded-md border p-4">
                <input type="hidden" name="repoId" value={repo.id} />
                <p className="font-medium">
                  {repo.githubRepoFullName}{" "}
                  <span className="text-sm text-muted-foreground">({repo.watchedBranch})</span>
                </p>
                <div className="space-y-2">
                  <Label>Cadence</Label>
                  <Select name="cadence" defaultValue={config?.cadence ?? "weekly"}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="none">No fixed cadence</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`threshold-${repo.id}`}>Threshold</Label>
                  <Input
                    id={`threshold-${repo.id}`}
                    type="number"
                    name="threshold"
                    min={1}
                    defaultValue={config?.threshold ?? 5}
                  />
                </div>
                <Button type="submit" variant="outline">
                  Save
                </Button>
              </form>
            );
          })}
          {tenantRepos.length === 0 && <p className="text-sm text-muted-foreground">No repos connected yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Verify build + tests**

```bash
npx tsc --noEmit && npm run build && npx vitest run
```
Expected: clean; `✓ Compiled successfully`; `66 passed`.

- [ ] **Step 5: Manual visual check**

With the dev server running (`npm run dev -- -p 3100`), sign in and click through every page: sidebar dropdown → Settings, Pending, Drafts (open a draft → Preview modal opens/closes; Save/Approve/Reject work), History, Integrations, and onboarding (if a fresh tenant). Everything renders with shadcn styling; every form still submits.

- [ ] **Step 6: Commit**

```bash
git add "src/app/onboarding/page.tsx" "src/app/(dashboard)/pending" "src/app/(dashboard)/settings/page.tsx"
git commit -m "$(cat <<'EOF'
Re-skin Onboarding, Pending, and Settings with shadcn

Cards/Inputs/Labels/Buttons throughout; cadence dropdowns become shadcn
Select (name-prop form submission). Repo-picker checkboxes and free-text
branch inputs stay native for now — Phase 2 replaces the branch input
with a shadcn Combobox. All form field names and behavior are unchanged.
EOF
)"
```

---

## What's next

Phase 1 ends with the entire dashboard on shadcn/ui, behavior unchanged (66 tests still green). Phase 2 (`2026-07-15-07-workspace-batching.md`) builds the workspace-level batching model, the unified Pending list, and the shadcn Combobox branch picker on top of these components.
