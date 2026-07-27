# Clickable History with a Release-Detail Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the history page to match the drafts row list and make every release open a read-only modal showing its rendered content, released-at, publisher, per-destination delivery status, and LinkedIn copy when present.

**Architecture:** Add a `publishedBy` column (set on both publish paths); a dependency-free `renderMarkdown` (marked, raw-HTML dropped, safe link hrefs); a tenant-scoped `getReleaseDetail` server action lazy-loaded on row click; and a drafts-styled history list whose rows are buttons opening one shared `Dialog`.

**Tech Stack:** Next.js 16 App Router (server page + client list), Drizzle ORM + Postgres, `marked` v18, base-ui `Dialog`, Vitest 4 against a real `_test` Postgres DB.

**Spec:** `docs/superpowers/specs/2026-07-27-history-release-modal-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Publisher:** add a nullable `releases.publishedBy` (→ `users.id`); set `publishedBy: session.user.id` in BOTH `approveDraft` and `publishDraft`. Pre-migration releases show "Unknown".
- **Detail is lazy-loaded** on row click via `getReleaseDetail(releaseId)` — the list query stays lean (no bodies shipped to the client).
- **Destinations in the modal = ALL delivery attempts** (success/failed/pending) with the failure error; the list row keeps the existing success-only summary.
- **Body rendering:** `renderMarkdown` mirrors `markdown-to-html.ts`'s stance — drop raw HTML (`html() => ""`); additionally blank any non-`http(s)`/`mailto`/relative/anchor link href (blocks `javascript:`/`data:`). Output styled by the existing `.mdx-content` CSS. NO new npm dependency (no sanitizer lib).
- **LinkedIn copy:** show `linkedinBody` verbatim (whitespace-preserved) as a separate section, only when non-empty.
- **Tenant isolation:** every query filters `session.user.tenantId`; `getReleaseDetail` returns `null` for a release the caller doesn't own (IDOR guard).
- **Read-only:** the modal has no re-publish/retry.
- **Tests:** Vitest, real `_test` Postgres DB, source imported via relative paths, unique tenant seeded + deleted in `afterEach`. UI tasks are presentational — verified by typecheck + lint + full suite (codebase convention).
- **Verify:** `npx vitest run`, `npm run typecheck`, `npm run lint`. Migrations: `npm run db:generate` then `npm run db:migrate` AND `npm run db:migrate:test`.

---

## File Structure

**Created:** `src/lib/markdown/render.ts`, `tests/lib/markdown/render.test.ts`, `src/app/(dashboard)/history/actions.ts`, `tests/app/history-actions.test.ts`, `src/app/(dashboard)/history/history-list.tsx`.
**Modified:** `src/db/schema.ts` (+`publishedBy`), a migration, `src/app/(dashboard)/drafts/actions.ts` (both publish `.set`s), `src/app/(dashboard)/history/page.tsx` (rewrite), an existing drafts publish test.

---

## Task 1: `renderMarkdown` — safe read-only Markdown → HTML

**Files:**
- Create: `src/lib/markdown/render.ts`
- Test: `tests/lib/markdown/render.test.ts`

**Interfaces:**
- Produces: `renderMarkdown(markdown: string): string` — returns HTML styled by `.mdx-content`; empty/whitespace input → `""`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/markdown/render.test.ts
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../../src/lib/markdown/render";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, lists and emphasis", () => {
    const html = renderMarkdown("# Title\n\nHello **world**\n\n- a\n- b");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>a</li>");
  });

  it("returns empty string for blank input", () => {
    expect(renderMarkdown("   ")).toBe("");
  });

  it("drops raw HTML (e.g. <script>)", () => {
    const html = renderMarkdown("hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("neutralizes a javascript: link href but keeps the text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).toContain('href=""');
  });

  it("keeps a normal http link and marks it noopener", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/lib/markdown/render.test.ts`
Expected: FAIL — cannot resolve `src/lib/markdown/render`.

- [ ] **Step 3: Implement**

```ts
// src/lib/markdown/render.ts
import { Marked, type Tokens } from "marked";

// Read-only Markdown → HTML for display, distinct from markdownToWebflowHtml
// (which downgrades code/tables for Webflow). Renders full Markdown but, like
// that renderer, drops raw HTML; additionally it blanks any link href that
// isn't http(s)/mailto/relative/anchor, so the output is safe for
// dangerouslySetInnerHTML without adding a sanitizer dependency.
const SAFE_HREF = /^(https?:\/\/|mailto:|\/|#)/i;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildRenderer() {
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Drop raw HTML blocks/inline (e.g. <script>, <img onerror>). Same stance
      // as markdown-to-html.ts.
      html() {
        return "";
      },
      // marked v18 does not sanitize hrefs; blank anything that isn't a safe
      // scheme (blocks javascript:/data:), preserving the visible link text.
      link(token: Tokens.Link) {
        const href = SAFE_HREF.test(token.href ?? "") ? escapeAttr(token.href) : "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        const text = this.parser.parseInline(token.tokens);
        return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return "";
  return (buildRenderer().parse(markdown, { async: false }) as string).trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/lib/markdown/render.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/lib/markdown/render.ts tests/lib/markdown/render.test.ts
git commit -m "feat: add read-only renderMarkdown (safe HTML for display)"
```

---

## Task 2: `releases.publishedBy` + set it on both publish paths

**Files:**
- Modify: `src/db/schema.ts` (releases table)
- Migration: generated
- Modify: `src/app/(dashboard)/drafts/actions.ts` (`approveDraft` + `publishDraft` `.set(...)`)
- Test: extend `tests/app/drafts/publish-idempotency.test.ts`

**Interfaces:**
- Produces: `releases.publishedBy` (nullable uuid → `users.id`), populated with the session user on publish.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, in the `releases` table, add after `editedBy`:

```ts
  publishedBy: uuid("published_by").references(() => users.id),
```

- [ ] **Step 2: Generate + apply the migration**

Run: `npm run db:generate`
Expected: a new `src/db/migrations/00NN_*.sql` with `ALTER TABLE "releases" ADD COLUMN "published_by" uuid` + its FK. Open it and confirm it's exactly that (additive, no data changes).

Run: `npm run db:migrate` then `npm run db:migrate:test`
Expected: both apply cleanly.

- [ ] **Step 3: Set `publishedBy` on both publish paths**

In `src/app/(dashboard)/drafts/actions.ts`:

In `approveDraft`, the publish UPDATE's `.set({...})` currently has `title, body, editedBy, status, publishedAt`. Add `publishedBy`:

```ts
      .set({
        title: formData.get("title") as string,
        body: resolveBody(formData.get("body") as string, existing.body),
        editedBy: session.user.id,
        publishedBy: session.user.id,
        status: "published",
        publishedAt: new Date(),
      })
```

In `publishDraft`, the UPDATE's `.set({ status: "published", publishedAt: new Date() })` becomes:

```ts
      .set({ status: "published", publishedAt: new Date(), publishedBy: session.user.id })
```

- [ ] **Step 4: Extend the publish test to assert the publisher**

Open `tests/app/drafts/publish-idempotency.test.ts`. It already seeds a user + draft, mocks the publish dependencies, and publishes (via `approveDraft` and/or `publishDraft`), then reads the release row back. In the test(s) that assert a successful publish, add an assertion that the published release's `publishedBy` equals the seeded session user's id. Concretely, after the block that re-reads the release row (e.g. `const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));`), add:

```ts
    expect(row.publishedBy).toBe(SESSION_USER_ID);
```

where `SESSION_USER_ID` is whatever id the file already uses for the mocked session user (reuse the existing variable/constant — do not introduce a new user). If only one of the two publish paths is exercised in that file, add a focused test for the other path in the same file, mirroring its existing publish call and assertion, so BOTH `approveDraft` and `publishDraft` are shown to set `publishedBy`.

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run tests/app/drafts/publish-idempotency.test.ts`
Expected: PASS.
Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

```bash
git add src/db/schema.ts src/db/migrations "src/app/(dashboard)/drafts/actions.ts" tests/app/drafts/publish-idempotency.test.ts
git commit -m "feat: record who published a release (releases.publishedBy)"
```

---

## Task 3: `getReleaseDetail` server action

**Files:**
- Create: `src/app/(dashboard)/history/actions.ts`
- Test: `tests/app/history-actions.test.ts`

**Interfaces:**
- Consumes: `renderMarkdown` (Task 1), `releases.publishedBy` (Task 2), `destinationLabel` from `@/lib/publishing/dispatch`.
- Produces:
  - `type ReleaseDestinationStatus = { destination: "webhook" | "webflow" | "linkedin"; label: string; status: "pending" | "success" | "failed"; error: string | null }`
  - `type ReleaseDetail = { id: string; title: string; bodyHtml: string; linkedinBody: string | null; publishedAt: string | null; publisherName: string | null; destinations: ReleaseDestinationStatus[] }`
  - `getReleaseDetail(releaseId: string): Promise<ReleaseDetail | null>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/history-actions.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, users, releases, deliveryAttempts } from "../../src/db/schema";

const TENANT = "History Actions Test Tenant";
let currentTenantId = "";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1" } })),
}));

import { getReleaseDetail } from "../../src/app/(dashboard)/history/actions";

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  currentTenantId = tenant.id;
  const [pub] = await db.insert(users).values({ email: "pub@example.com", name: "Pat Publisher" }).returning({ id: users.id });
  const [rel] = await db
    .insert(releases)
    .values({
      tenantId: tenant.id,
      title: "Ship it",
      body: "# Notes\n\nWe **shipped**.",
      linkedinBody: "We shipped 🎉",
      status: "published",
      publishedAt: new Date("2026-07-25T10:00:00Z"),
      publishedBy: pub.id,
    })
    .returning({ id: releases.id });
  await db.insert(deliveryAttempts).values([
    { releaseId: rel.id, destination: "webhook", status: "success" },
    { releaseId: rel.id, destination: "webflow", status: "failed", lastError: "401 Unauthorized" },
  ]);
  return { tenantId: tenant.id, releaseId: rel.id };
}

describe("getReleaseDetail", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns rendered body, publisher, and all destination statuses", async () => {
    const { releaseId } = await seed();
    const detail = await getReleaseDetail(releaseId);
    expect(detail).not.toBeNull();
    expect(detail!.title).toBe("Ship it");
    expect(detail!.bodyHtml).toContain("<strong>shipped</strong>");
    expect(detail!.linkedinBody).toBe("We shipped 🎉");
    expect(detail!.publishedAt).toBe("2026-07-25T10:00:00.000Z");
    expect(detail!.publisherName).toBe("Pat Publisher");
    const byDest = Object.fromEntries(detail!.destinations.map((d) => [d.destination, d]));
    expect(byDest.webhook).toMatchObject({ status: "success", error: null, label: expect.any(String) });
    expect(byDest.webflow).toMatchObject({ status: "failed", error: "401 Unauthorized" });
  });

  it("returns null for a release owned by another tenant (IDOR guard)", async () => {
    const { releaseId } = await seed();
    currentTenantId = "00000000-0000-0000-0000-000000000000"; // different tenant in session
    expect(await getReleaseDetail(releaseId)).toBeNull();
  });

  it("maps a null publishedBy to publisherName null", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
    currentTenantId = tenant.id;
    const [rel] = await db
      .insert(releases)
      .values({ tenantId: tenant.id, title: "Old", body: "x", status: "published", publishedAt: new Date() })
      .returning({ id: releases.id });
    const detail = await getReleaseDetail(rel.id);
    expect(detail!.publisherName).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/app/history-actions.test.ts`
Expected: FAIL — cannot resolve the history actions module.

- [ ] **Step 3: Implement**

```ts
// src/app/(dashboard)/history/actions.ts
"use server";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { releases, deliveryAttempts, users } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { destinationLabel } from "@/lib/publishing/dispatch";
import { renderMarkdown } from "@/lib/markdown/render";

export type ReleaseDestinationStatus = {
  destination: "webhook" | "webflow" | "linkedin";
  label: string;
  status: "pending" | "success" | "failed";
  error: string | null;
};

export type ReleaseDetail = {
  id: string;
  title: string;
  bodyHtml: string;
  linkedinBody: string | null;
  publishedAt: string | null;
  publisherName: string | null;
  destinations: ReleaseDestinationStatus[];
};

export async function getReleaseDetail(releaseId: string): Promise<ReleaseDetail | null> {
  const session = await requireSession();

  const [row] = await db
    .select({
      id: releases.id,
      title: releases.title,
      body: releases.body,
      linkedinBody: releases.linkedinBody,
      publishedAt: releases.publishedAt,
      publisherName: users.name,
      publisherEmail: users.email,
    })
    .from(releases)
    .leftJoin(users, eq(releases.publishedBy, users.id))
    // Tenant-scoped: a release the caller doesn't own returns no row → null.
    .where(and(eq(releases.id, releaseId), eq(releases.tenantId, session.user.tenantId)))
    .limit(1);
  if (!row) return null;

  // The release is confirmed the caller's above, so its delivery attempts
  // (FK'd to it) are safe to read by releaseId alone.
  const attempts = await db
    .select({
      destination: deliveryAttempts.destination,
      status: deliveryAttempts.status,
      error: deliveryAttempts.lastError,
    })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.releaseId, releaseId))
    .orderBy(deliveryAttempts.destination);

  return {
    id: row.id,
    title: row.title,
    bodyHtml: renderMarkdown(row.body),
    linkedinBody: row.linkedinBody,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    publisherName: row.publisherName ?? row.publisherEmail ?? null,
    destinations: attempts.map((a) => ({
      destination: a.destination,
      label: destinationLabel(a.destination),
      status: a.status,
      error: a.error,
    })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/app/history-actions.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Full suite, typecheck, commit**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

```bash
git add "src/app/(dashboard)/history/actions.ts" tests/app/history-actions.test.ts
git commit -m "feat: getReleaseDetail server action for the history modal"
```

---

## Task 4: History page redesign + release-detail modal

**Files:**
- Create: `src/app/(dashboard)/history/history-list.tsx`
- Modify: `src/app/(dashboard)/history/page.tsx` (rewrite)

**Interfaces:**
- Consumes: `getReleaseDetail`, `ReleaseDetail`, `ReleaseDestinationStatus` (Task 3); `destinationLabel`; the `Dialog` primitives; `EmptyState` family; `Badge`.

No new unit tests (presentational; the action is covered in Task 3). Verify by typecheck + lint + full suite + a manual render check.

- [ ] **Step 1: Write the client list + modal**

```tsx
// src/app/(dashboard)/history/history-list.tsx
"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { getReleaseDetail, type ReleaseDetail } from "./actions";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";

export type HistoryRow = {
  id: string;
  title: string;
  publishedAt: string | null; // ISO
  delivered: string[]; // labels of successful destinations
};

function statusVariant(status: "pending" | "success" | "failed") {
  return status === "success" ? "secondary" : status === "failed" ? "destructive" : "outline";
}

export function HistoryList({ rows }: { rows: HistoryRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function open(id: string) {
    setOpenId(id);
    setDetail(null);
    setError(false);
    setLoading(true);
    try {
      const d = await getReleaseDetail(id);
      if (d) setDetail(d);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState>
        <EmptyStateIcon>
          <History />
        </EmptyStateIcon>
        <EmptyStateTitle>No announcements sent yet</EmptyStateTitle>
        <EmptyStateDescription>
          Releases appear here once you publish a draft to your destinations.
        </EmptyStateDescription>
      </EmptyState>
    );
  }

  return (
    <>
      {/* Negative margin lets the hover highlight breathe past the text column,
          matching the drafts list. */}
      <div className="-mx-3">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => open(r.id)}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/60"
          >
            <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
            <span className="shrink-0 truncate text-sm text-muted-foreground">
              {r.delivered.length > 0 ? r.delivered.slice().sort().join(", ") : "—"}
            </span>
            <span className="shrink-0 text-sm text-muted-foreground">
              {r.publishedAt ? new Date(r.publishedAt).toLocaleDateString() : ""}
            </span>
          </button>
        ))}
      </div>

      <Dialog open={openId !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-4 p-6 sm:max-w-2xl">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error || !detail ? (
            <p className="text-sm text-destructive">Couldn&apos;t load this release.</p>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{detail.title}</DialogTitle>
              </DialogHeader>

              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Released</dt>
                <dd>{detail.publishedAt ? new Date(detail.publishedAt).toLocaleString() : "—"}</dd>
                <dt className="text-muted-foreground">Published by</dt>
                <dd>{detail.publisherName ?? "Unknown"}</dd>
                <dt className="text-muted-foreground">Destinations</dt>
                <dd className="space-y-1">
                  {detail.destinations.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    detail.destinations.map((d) => (
                      <span key={d.destination} className="mr-2 inline-flex flex-col">
                        <Badge variant={statusVariant(d.status)}>
                          {d.label}: {d.status}
                        </Badge>
                        {d.status === "failed" && d.error && (
                          <span className="mt-0.5 text-xs text-destructive">{d.error}</span>
                        )}
                      </span>
                    ))
                  )}
                </dd>
              </dl>

              <div className="min-h-0 flex-1 overflow-y-auto border-t border-border pt-4">
                <div className="mdx-content" dangerouslySetInnerHTML={{ __html: detail.bodyHtml }} />
                {detail.linkedinBody && detail.linkedinBody.trim() && (
                  <div className="mt-6 border-t border-border pt-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      LinkedIn copy
                    </p>
                    <p className="whitespace-pre-wrap text-sm">{detail.linkedinBody}</p>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Rewrite the history page to feed the list**

```tsx
// src/app/(dashboard)/history/page.tsx
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { releases, deliveryAttempts } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { destinationLabel } from "@/lib/publishing/dispatch";
import { HistoryList, type HistoryRow } from "./history-list";

export default async function HistoryPage() {
  const session = await requireSession();
  const sent = await db
    .select({ id: releases.id, title: releases.title, publishedAt: releases.publishedAt })
    .from(releases)
    .where(and(eq(releases.tenantId, session.user.tenantId), eq(releases.status, "published")))
    .orderBy(desc(releases.publishedAt));

  // Successful destinations per release for the row summary (one grouped query).
  const deliveredByRelease = new Map<string, string[]>();
  if (sent.length > 0) {
    const delivered = await db
      .select({ releaseId: deliveryAttempts.releaseId, destination: deliveryAttempts.destination })
      .from(deliveryAttempts)
      .where(
        and(
          inArray(
            deliveryAttempts.releaseId,
            sent.map((u) => u.id)
          ),
          eq(deliveryAttempts.status, "success")
        )
      );
    for (const { releaseId, destination } of delivered) {
      const list = deliveredByRelease.get(releaseId) ?? [];
      list.push(destinationLabel(destination));
      deliveredByRelease.set(releaseId, list);
    }
  }

  const rows: HistoryRow[] = sent.map((u) => ({
    id: u.id,
    title: u.title,
    publishedAt: u.publishedAt ? u.publishedAt.toISOString() : null,
    delivered: deliveredByRelease.get(u.id) ?? [],
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Release history</h1>
      <p className="text-sm text-muted-foreground">Announcements that have actually been sent to your users.</p>
      <HistoryList rows={rows} />
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run`
Expected: all PASS (no test-count change; existing suite green). Confirm `EmptyState`/`EmptyStateIcon`/`EmptyStateTitle`/`EmptyStateDescription` and the `Dialog` exports resolve (they're used elsewhere in the app). If `History` is not exported by `lucide-react` in this version, substitute another existing icon used in the app (e.g. `Clock`).

Manual: `npm run dev`, open `/history`. The list should look like drafts (hover rows, muted destinations + date). Click a row → modal opens, loads, shows title, Released, Published by, per-destination status badges (a failed one shows its error), the rendered body in `.mdx-content`, and a "LinkedIn copy" section when the release has `linkedinBody`. Close and reopen a different row.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/history/history-list.tsx" "src/app/(dashboard)/history/page.tsx"
git commit -m "feat: drafts-styled clickable history with a release-detail modal"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
| --- | --- |
| `releases.publishedBy` column, set on both publish paths | Task 2 |
| Lazy-load detail via `getReleaseDetail` (tenant-scoped, IDOR → null) | Task 3 |
| Destinations = all attempts + status + error | Task 3 (data) + Task 4 (badges + error) |
| Body render: marked, drop raw HTML, safe link hrefs, no new dep | Task 1 |
| `.mdx-content` styling | Task 4 (`<div className="mdx-content">`) |
| LinkedIn copy shown when present, whitespace-preserved | Task 4 |
| History list matches drafts (`-mx-3` hover rows) + EmptyState | Task 4 |
| Rows open a modal (button, not link); one shared Dialog | Task 4 |
| Publisher name = name ?? email ?? null ("Unknown") | Task 3 (map) + Task 4 (render) |
| Read-only (no re-publish) | Task 4 (no actions in modal) |
| No publisher backfill (historical → Unknown) | Task 2 (nullable) + Task 4 ("Unknown") |

**Placeholder scan:** none — every code step has full source; every test step full test code; every run step names command + expected result. The one "read the existing file" step (Task 2 Step 4) gives the exact assertion and reuses the file's existing fixtures rather than inventing a mock setup.

**Type consistency:** `ReleaseDetail`/`ReleaseDestinationStatus` (Task 3) are consumed unchanged by `history-list.tsx` (Task 4). `HistoryRow` (defined in Task 4's client file) is produced by the page (Task 4 Step 2) with matching fields (`id`, `title`, `publishedAt: string|null`, `delivered: string[]`). `renderMarkdown(string): string` (Task 1) is called by `getReleaseDetail` (Task 3). `publishedBy` (Task 2) is read by `getReleaseDetail`'s join (Task 3).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-27-history-release-modal.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks.
2. **Inline Execution** — batched in this session with checkpoints.

Which approach?
